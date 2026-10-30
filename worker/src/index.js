const DEFAULT_SOURCE = "https://elections.delaware.gov/results/enr/GE2026.html?group=Statewide&filter=";
const CACHE_KEY = "delaware-general-results-2026:last-good";
const STATUS_KEY = "delaware-general-results-2026:refresh-status";
const DEFAULT_REFRESH_START = "2026-11-03T19:45:00-05:00";
const DEFAULT_REFRESH_END = "2026-11-04T08:00:00-05:00";
const STATEWIDE_FEED = "Election_StatewideResults_ID";
const DISTRICT_REPORTING_FEED = "Election_DistrictReporting_ID";
const BY_ELECTION_DISTRICT_FEED = "Election_ByElectionDistrict_ID";

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = allowedOrigin(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== "GET") {
      return apiResponse({ error: "Method not allowed" }, 405, origin);
    }

    if (url.pathname === "/api/health") {
      const [latest, refreshStatus] = await Promise.all([readLastGood(env), readRefreshStatus(env)]);
      return apiResponse({
        ok: true,
        service: "Delaware General Results 2026",
        cacheReady: Boolean(latest),
        lastSuccessAt: refreshStatus?.lastSuccessAt || latest?.fetchedAt || null,
        lastAttemptAt: refreshStatus?.lastAttemptAt || null,
        lastError: refreshStatus?.lastError || null,
        refreshWindow: {
          startsAt: env.REFRESH_WINDOW_START || DEFAULT_REFRESH_START,
          endsAt: env.REFRESH_WINDOW_END || DEFAULT_REFRESH_END,
        },
      }, 200, origin, { "cache-control": "no-store" });
    }

    if (url.pathname !== "/api/results") {
      return apiResponse({ error: "Not found" }, 404, origin);
    }

    if (!env.RESULTS_CACHE?.get) {
      return apiResponse({
        error: "Results cache is not configured.",
        sourceUrl: env.RESULTS_SOURCE_URL || DEFAULT_SOURCE,
      }, 503, origin, { "cache-control": "no-store" });
    }

    const [latest, refreshStatus] = await Promise.all([readLastGood(env), readRefreshStatus(env)]);
    if (!latest) {
      return apiResponse({
        error: "Results are not available yet.",
        detail: "Waiting for the first successful scheduled refresh.",
        sourceUrl: env.RESULTS_SOURCE_URL || DEFAULT_SOURCE,
      }, 503, origin, { "cache-control": "no-store" });
    }

    const staleAfterSeconds = clampNumber(env.STALE_AFTER_SECONDS, 180, 60, 3600);
    const lastSuccessAt = refreshStatus?.lastSuccessAt || latest.fetchedAt;
    const lastSuccessMs = Date.parse(lastSuccessAt || "");
    const refreshWindowActive = shouldRefreshAt(Date.now(), env);
    const stale = refreshWindowActive && (!Number.isFinite(lastSuccessMs)
      || Date.now() - lastSuccessMs > staleAfterSeconds * 1000);
    const ttl = clampNumber(env.CACHE_SECONDS, 15, 5, 60);

    return apiResponse({
      ...latest,
      stale,
      checkedAt: lastSuccessAt || null,
      warning: stale ? "Showing the last successful update while the source refresh recovers." : undefined,
    }, 200, origin, {
      "x-results-cache": stale ? "stale-kv" : "kv",
      "cache-control": `public, max-age=5, s-maxage=${ttl}, stale-while-revalidate=120`,
    });
  },

  scheduled(controller, env, ctx) {
    const scheduledTime = controller?.scheduledTime ?? Date.now();
    if (!shouldRefreshAt(scheduledTime, env)) return;
    ctx.waitUntil(refreshResults(env));
  },
};

export function shouldRefreshAt(timestamp, env = {}) {
  const time = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  const startsAt = Date.parse(env.REFRESH_WINDOW_START || DEFAULT_REFRESH_START);
  const endsAt = Date.parse(env.REFRESH_WINDOW_END || DEFAULT_REFRESH_END);
  return Number.isFinite(time) && Number.isFinite(startsAt) && Number.isFinite(endsAt)
    && time >= startsAt && time < endsAt;
}

async function refreshResults(env) {
  if (!env.RESULTS_CACHE?.put) throw new Error("RESULTS_CACHE KV binding is required for scheduled refreshes.");

  const sourceUrl = env.RESULTS_SOURCE_URL || DEFAULT_SOURCE;
  const dataUrl = resultsDataUrl(sourceUrl);
  const auxiliaryUrls = reportingDataUrls(sourceUrl);
  const previous = await readRefreshStatus(env);
  const now = new Date();
  const attemptAt = now.toISOString();
  const nextAttemptMs = Date.parse(previous?.nextAttemptAt || "");

  if (Number.isFinite(nextAttemptMs) && nextAttemptMs > now.getTime()) return;

  try {
    const requestInit = {
      headers: {
        "accept": "application/json,text/html;q=0.5",
        "user-agent": "Spotlight Delaware election-results monitor/1.3 (+https://spotlightdelaware.org)",
      },
      cf: { cacheTtl: 0, cacheEverything: false },
    };
    const [upstream, districtReportingRows, electionDistrictRows] = await Promise.all([
      fetch(dataUrl, requestInit),
      fetchOptionalRows(auxiliaryUrls.districtReporting, requestInit),
      fetchOptionalRows(auxiliaryUrls.byElectionDistrict, requestInit),
    ]);

    if (!upstream.ok) {
      const error = new Error(`Delaware results feed returned HTTP ${upstream.status}`);
      error.status = upstream.status;
      throw error;
    }

    const payload = await upstream.text();
    const parsed = attachRaceReporting(
      parseResultsPayload(payload, sourceUrl),
      electionDistrictRows,
      districtReportingRows,
    );
    const body = { ...parsed, fetchedAt: attemptAt, stale: false };

    await Promise.all([
      writeLastGood(env, body),
      writeRefreshStatus(env, {
        lastAttemptAt: attemptAt,
        lastSuccessAt: attemptAt,
        lastError: null,
        nextAttemptAt: null,
        consecutiveFailures: 0,
      }),
    ]);
  } catch (error) {
    const consecutiveFailures = (previous?.consecutiveFailures || 0) + 1;
    const backoffSeconds = retryDelaySeconds(error, consecutiveFailures);
    await writeRefreshStatus(env, {
      ...previous,
      lastAttemptAt: attemptAt,
      lastError: safeError(error),
      nextAttemptAt: new Date(now.getTime() + backoffSeconds * 1000).toISOString(),
      consecutiveFailures,
    });
    console.error("Scheduled Delaware results refresh failed:", safeError(error));
  }
}

function retryDelaySeconds(error, failures) {
  const status = Number(error?.status);
  if (status === 429) return Math.min(900, 60 * (2 ** Math.min(failures, 4)));
  if (!status || status >= 500) return Math.min(300, 60 * (2 ** Math.min(failures - 1, 3)));
  return 60;
}

export function resultsDataUrl(sourceUrl = DEFAULT_SOURCE) {
  return electionFeedUrl(sourceUrl, STATEWIDE_FEED) || sourceUrl;
}

export function reportingDataUrls(sourceUrl = DEFAULT_SOURCE) {
  return {
    districtReporting: electionFeedUrl(sourceUrl, DISTRICT_REPORTING_FEED),
    byElectionDistrict: electionFeedUrl(sourceUrl, BY_ELECTION_DISTRICT_FEED),
  };
}

function electionFeedUrl(sourceUrl, feedName) {
  const url = new URL(sourceUrl);
  const match = url.pathname.match(/^(.*\/)([a-z0-9_-]+)\.html$/i);
  if (!match || !url.pathname.includes("/results/enr/")) return null;
  url.pathname = `${match[1]}${feedName}_${match[2].toUpperCase()}.json`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function fetchOptionalRows(url, requestInit) {
  if (!url) return null;
  try {
    const response = await fetch(url, requestInit);
    if (!response.ok) return null;
    return rowsFromJson(await response.text());
  } catch {
    return null;
  }
}

function rowsFromJson(input) {
  let value;
  try {
    value = typeof input === "string" ? JSON.parse(input) : input;
  } catch {
    return null;
  }
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return null;
  for (const key of ["rows", "data", "results", "items"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return null;
}

export function attachRaceReporting(parsed, electionDistrictInput, districtReportingInput) {
  const raceReporting = parseRaceReporting(electionDistrictInput, districtReportingInput);
  const contests = parsed.contests.map(contest => {
    const reporting = raceReporting[contestLookupKey(contest.title)]
      || (isStatewideContest(contest.title) ? parsed.reporting : null);
    return reporting ? { ...contest, reporting } : contest;
  });
  return {
    ...parsed,
    contests,
    raceReportingAvailable: contests.some(contest => contest.reporting?.total),
  };
}

export function parseRaceReporting(electionDistrictInput, districtReportingInput) {
  const electionDistrictRows = rowsFromJson(electionDistrictInput) || [];
  const districtReportingRows = rowsFromJson(districtReportingInput) || [];
  const statusByPrecinct = new Map();
  const directByContest = new Map();

  for (const row of districtReportingRows) {
    if (!row || typeof row !== "object") continue;
    const precinct = precinctKey(row);
    const status = reportedStatus(row);
    if (precinct && status !== null) statusByPrecinct.set(precinct, status);

    const title = contestTitle(row);
    const reported = rowNumber(row, [
      "Precincts Reported", "Election Districts Reported", "Districts Reported", "Reported Precincts",
    ]);
    const total = rowNumber(row, [
      "Total Precincts", "Total Election Districts", "Election Districts", "Precinct Total",
    ]);
    if (title && !precinct && total > 0) {
      directByContest.set(contestLookupKey(title), reportingRecord(reported, total));
    }
  }

  const precinctsByContest = new Map();
  for (const row of [...electionDistrictRows, ...districtReportingRows]) {
    if (!row || typeof row !== "object") continue;
    const title = contestTitle(row);
    const precinct = precinctKey(row);
    if (!title || !precinct) continue;
    const key = contestLookupKey(title);
    if (!precinctsByContest.has(key)) precinctsByContest.set(key, new Map());
    const precincts = precinctsByContest.get(key);
    const rowStatus = reportedStatus(row);
    const prior = precincts.get(precinct);
    const reported = statusByPrecinct.has(precinct)
      ? statusByPrecinct.get(precinct)
      : (rowStatus ?? rowHasVotes(row));
    precincts.set(precinct, Boolean(prior || reported));
  }

  const result = {};
  for (const [key, precincts] of precinctsByContest) {
    const total = precincts.size;
    const reported = [...precincts.values()].filter(Boolean).length;
    if (total) result[key] = reportingRecord(reported, total);
  }
  for (const [key, reporting] of directByContest) result[key] = reporting;
  return result;
}

function reportingRecord(reportedValue, totalValue) {
  const total = Math.max(0, parseInteger(totalValue));
  const reported = Math.min(total, Math.max(0, parseInteger(reportedValue)));
  return {
    reported,
    total,
    percentage: percent(reported, total),
    outstanding: Math.max(0, total - reported),
    label: "Precincts reporting in this race",
  };
}

function contestTitle(row) {
  return String(rowValue(row, ["Contest Title", "Contest Name", "Race Title", "Office Title"]) || "").trim();
}

function precinctKey(row) {
  const value = rowValue(row, [
    "Election District", "Election District ID", "Election District Number",
    "Precinct", "Precinct ID", "Precinct Number", "ED", "ED ID", "Voting District",
  ]);
  return value == null ? "" : String(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function reportedStatus(row) {
  const value = rowValue(row, [
    "Reported", "Is Reported", "District Reported", "Reporting Status",
    "Results Reported", "Has Reported", "Report Status",
  ]);
  if (value == null || value === "") return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  const text = String(value).trim().toLowerCase();
  if (/^(?:0|n|no|false|not reported|unreported|outstanding|pending)$/.test(text)) return false;
  if (/^(?:1|y|yes|true|reported|complete|completed)$/.test(text)) return true;
  if (/not\s+reported|unreported|outstanding|pending/.test(text)) return false;
  if (/reported|complete/.test(text)) return true;
  return null;
}

function rowHasVotes(row) {
  return rowNumber(row, ["Total Votes", "Votes", "Machine Votes", "Election Day Votes"])
    + rowNumber(row, ["Absentee Votes"])
    + rowNumber(row, ["Early Voting Votes"]) > 0;
}

function rowNumber(row, aliases) {
  return parseInteger(rowValue(row, aliases) ?? 0);
}

function rowValue(row, aliases) {
  const wanted = new Set(aliases.map(normalizedField));
  for (const [key, value] of Object.entries(row)) {
    if (wanted.has(normalizedField(key))) return value;
  }
  return undefined;
}

function normalizedField(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function contestLookupKey(value) {
  return slug(String(value).replace(/^U\.?\s*S\.?\s+Representative In Congress$/i, "Representative in Congress"));
}

function isStatewideContest(title) {
  return /^(?:U\.?\s*S\.?\s+Senator|(?:U\.?\s*S\.?\s+)?Representative in Congress|Attorney General|Auditor of Accounts|State Treasurer)$/i.test(title);
}

export function parseResultsPayload(payload, sourceUrl = DEFAULT_SOURCE) {
  if (!payload || typeof payload !== "string") throw new Error("The source response was empty.");
  const trimmed = payload.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return parseResultsJson(trimmed, sourceUrl);
  return parseResultsHtml(payload, sourceUrl);
}

export function parseResultsJson(input, sourceUrl = DEFAULT_SOURCE) {
  let rows;
  try {
    rows = typeof input === "string" ? JSON.parse(input) : input;
  } catch {
    throw new Error("The Delaware results feed returned invalid JSON.");
  }

  if (!Array.isArray(rows) || !rows.length) throw new Error("The Delaware results feed contained no candidate rows.");

  const validRows = rows.filter(row => row && row["Contest Title"] && row["Party Name"] && row["Candidate Name"]);
  if (!validRows.length) throw new Error("The Delaware results feed did not contain recognizable candidate records.");

  const contestMap = new Map();
  for (const row of validRows) {
    const title = String(row["Contest Title"]).trim();
    const party = canonicalParty(row["Party Name"]);
    const key = title.toLowerCase();
    if (!contestMap.has(key)) {
      contestMap.set(key, {
        id: slug(title),
        title,
        sortOrder: parseInteger(row["Contest Sorting Order"]),
        candidates: [],
      });
    }
    contestMap.get(key).candidates.push({
      name: String(row["Candidate Name"]).trim(),
      party,
      votes: parseInteger(row["Total Votes"] ?? 0),
      percentage: parseFloatSafe(row.Percentage),
      machineVotes: parseInteger(row["Machine Votes"] ?? 0),
      absenteeVotes: parseInteger(row["Absentee Votes"] ?? 0),
      earlyVotes: parseInteger(row["Early Voting Votes"] ?? 0),
      position: parseInteger(row.Pos),
    });
  }

  const contests = [...contestMap.values()]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(contest => ({
      id: contest.id,
      title: contest.title,
      candidates: contest.candidates
        .sort((a, b) => a.position - b.position)
        .map(({ position, ...candidate }) => candidate),
    }));

  const reported = Math.max(...validRows.map(row => parseInteger(row["Precincts Reported"])));
  const total = Math.max(...validRows.map(row => parseInteger(row["Total Precincts"])));
  const first = validRows[0];

  return {
    election: first["Election Name"] || "2026 Delaware General Election",
    electionDate: first["Election Date"] || "2026-11-03",
    status: first["Results Type"] || "UNOFFICIAL RESULTS",
    sourceUpdatedAt: first.ReportTime || null,
    sourceUrl,
    reporting: {
      reported,
      total,
      percentage: percent(reported, total),
      label: "Election districts reporting statewide",
    },
    contests,
  };
}

export function parseResultsHtml(html, sourceUrl = DEFAULT_SOURCE) {
  if (!html || typeof html !== "string") throw new Error("The source page was empty.");

  const statewideStart = html.search(/<div\b[^>]*\bid=["']statewide["'][^>]*>/i);
  if (statewideStart < 0) throw new Error("Could not find the statewide results section.");

  const afterStart = html.slice(statewideStart);
  const nextSection = afterStart.slice(1).search(/<div\b[^>]*\bid=["'](?:byrepdist|byelectiondist|bycounty|bycountyw)["'][^>]*>/i);
  const statewide = nextSection >= 0 ? afterStart.slice(0, nextSection + 1) : afterStart;
  const updated = firstText(html, /<[^>]*\bid=["']lastUpdated["'][^>]*>([\s\S]*?)<\/[^>]+>/i)
    .replace(/^Data as of\s*/i, "");
  const status = firstText(html, /<[^>]*\bclass=["'][^"']*resultsType[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i) || "UNOFFICIAL RESULTS";
  const precinctMatch = stripTags(html).match(/([\d,]+)\s+of\s+([\d,]+)\s+(?:Precincts?|Election Districts?)\s+Reporting/i);
  const contests = [];

  const headingPattern = /<h3\b[^>]*\bclass=["'][^"']*contest-title[^"']*["'][^>]*>([\s\S]*?)<\/h3>/gi;
  const headings = [...statewide.matchAll(headingPattern)];

  for (let index = 0; index < headings.length; index += 1) {
    const match = headings[index];
    const title = cleanText(match[1]);
    const bodyStart = match.index + match[0].length;
    const bodyEnd = index + 1 < headings.length ? headings[index + 1].index : statewide.length;
    const block = statewide.slice(bodyStart, bodyEnd);
    const candidates = [];
    const tablePattern = /(?:<h4\b[^>]*>([\s\S]*?)<\/h4>\s*)?(<table\b[\s\S]*?<\/table>)/gi;
    for (const tableMatch of block.matchAll(tablePattern)) {
      const fallbackParty = canonicalParty(cleanText(tableMatch[1] || ""));
      const table = parseTable(tableMatch[2]);
      candidates.push(...table.rows.map(row => ({
          name: row.Candidate || row.candidate || "Unknown candidate",
          party: canonicalParty(row.Party || row["Party Name"] || fallbackParty),
          votes: parseInteger(row["Total Votes"] ?? row.Votes ?? 0),
          percentage: parseFloatSafe(row.Percentage),
          machineVotes: parseInteger(row["Machine Votes"] ?? 0),
          absenteeVotes: parseInteger(row["Absentee Votes"] ?? 0),
          earlyVotes: parseInteger(row["Early Voting Votes"] ?? 0),
        })));
    }
    if (candidates.length) contests.push({ id: slug(title), title, candidates });
  }

  if (!contests.length) throw new Error("No statewide contest tables were found.");

  const reporting = precinctMatch ? {
    reported: parseInteger(precinctMatch[1]),
    total: parseInteger(precinctMatch[2]),
    percentage: percent(parseInteger(precinctMatch[1]), parseInteger(precinctMatch[2])),
    label: "Election districts reporting statewide",
  } : null;

  return {
    election: "2026 Delaware General Election",
    electionDate: "2026-11-03",
    status,
    sourceUpdatedAt: updated || null,
    sourceUrl,
    reporting,
    contests,
  };
}

function parseTable(tableHtml) {
  const headers = [...tableHtml.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(match => cleanText(match[1]));
  const body = firstRaw(tableHtml, /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i) || tableHtml;
  const rows = [];
  for (const rowMatch of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => cleanText(match[1]));
    if (!cells.length) continue;
    const row = {};
    cells.forEach((cell, index) => { row[headers[index] || `column${index + 1}`] = cell; });
    rows.push(row);
  }
  return { headers, rows };
}

function firstText(input, pattern) {
  return cleanText(firstRaw(input, pattern));
}

function firstRaw(input, pattern) {
  const match = input.match(pattern);
  return match ? match[1] : "";
}

function cleanText(input = "") {
  return decodeEntities(stripTags(input)).replace(/\s+/g, " ").trim();
}

function stripTags(input = "") {
  return input.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function decodeEntities(input) {
  const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : "";
    }
    return named[entity.toLowerCase()] ?? `&${entity};`;
  });
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function canonicalParty(value = "") {
  const party = String(value).replace(/\s+Party$/i, "").trim();
  if (/^Democratic$/i.test(party)) return "Democratic";
  if (/^Republican$/i.test(party)) return "Republican";
  if (/^(Ind Pty of DE|Independent(?: Party of Delaware)?)$/i.test(party)) return "Independent Party of Delaware";
  return party || "Other";
}

function parseInteger(value) {
  const number = Number.parseInt(String(value).replace(/[^0-9-]/g, ""), 10);
  return Number.isFinite(number) ? number : 0;
}

function parseFloatSafe(value) {
  const number = Number.parseFloat(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function percent(part, total) {
  return total ? Number(((part / total) * 100).toFixed(2)) : 0;
}

function clampNumber(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function allowedOrigin(request, env) {
  const allowed = env.ALLOWED_ORIGIN || "*";
  const origin = request.headers.get("origin");
  if (allowed === "*") return "*";
  const choices = allowed.split(",").map(value => value.trim());
  return origin && choices.includes(origin) ? origin : choices[0];
}

function corsHeaders(origin) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    "vary": "Origin",
  };
}

function apiResponse(body, status, origin, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...jsonHeaders, ...corsHeaders(origin), ...extra },
  });
}

async function writeLastGood(env, body) {
  if (!env.RESULTS_CACHE?.put) return;
  await env.RESULTS_CACHE.put(CACHE_KEY, JSON.stringify(body));
}

async function readLastGood(env) {
  if (!env.RESULTS_CACHE?.get) return null;
  return env.RESULTS_CACHE.get(CACHE_KEY, "json");
}

async function writeRefreshStatus(env, body) {
  if (!env.RESULTS_CACHE?.put) return;
  await env.RESULTS_CACHE.put(STATUS_KEY, JSON.stringify(body), { expirationTtl: 604800 });
}

async function readRefreshStatus(env) {
  if (!env.RESULTS_CACHE?.get) return null;
  return env.RESULTS_CACHE.get(STATUS_KEY, "json");
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/\S+/g, "upstream page").slice(0, 240);
}
