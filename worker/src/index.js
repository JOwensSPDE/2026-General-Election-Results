const DEFAULT_SOURCE = "https://elections.delaware.gov/results/enr/GE2026.html?group=Statewide&filter=";
const CACHE_KEY = "delaware-general-results-2026:last-good";
const STATUS_KEY = "delaware-general-results-2026:refresh-status";
const BALANCE_CACHE_KEY = "delaware-general-results-2026:civicapi-balance:last-good";
const BALANCE_STATUS_KEY = "delaware-general-results-2026:civicapi-balance:refresh-status-v2";
const DEFAULT_REFRESH_START = "2026-11-03T19:45:00-05:00";
const DEFAULT_REFRESH_END = "2026-11-04T08:00:00-05:00";
const DEFAULT_BALANCE_REFRESH_START = "2026-11-03T19:00:00-05:00";
const DEFAULT_BALANCE_REFRESH_END = "2026-11-04T08:00:00-05:00";
const CIVICAPI_SEARCH_ENDPOINT = "https://civicapi.org/api/v2/race/search";
const CIVICAPI_RESULTS_URL = "https://civicapi.org/results";
const DEFAULT_BALANCE_FALLBACK_URL = "https://sitmap.live/api/elections/us-2026.json";
const SENATE_HOLDOVERS = { democratic: 34, republican: 31 };
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
      const [latest, refreshStatus, balance, balanceStatus] = await Promise.all([
        readLastGood(env),
        readRefreshStatus(env),
        readBalanceLastGood(env),
        readBalanceRefreshStatus(env),
      ]);
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
        balanceOfPower: {
          configured: env.CIVICAPI_BALANCE_ENABLED !== "false",
          provider: balance?.source || "civicAPI",
          fallbackConfigured: env.BALANCE_FALLBACK_ENABLED !== "false",
          cacheReady: Boolean(balance),
          lastSuccessAt: balanceStatus?.lastSuccessAt || balance?.fetchedAt || null,
          lastAttemptAt: balanceStatus?.lastAttemptAt || null,
          lastError: balanceStatus?.lastError || null,
          refreshWindow: {
            startsAt: env.BALANCE_REFRESH_WINDOW_START || DEFAULT_BALANCE_REFRESH_START,
            endsAt: env.BALANCE_REFRESH_WINDOW_END || DEFAULT_BALANCE_REFRESH_END,
          },
        },
      }, 200, origin, { "cache-control": "no-store" });
    }

    if (url.pathname === "/api/balance") {
      return serveBalanceOfPower(env, origin);
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
    const work = [];
    if (shouldRefreshAt(scheduledTime, env)) work.push(refreshResults(env));
    if (env.CIVICAPI_BALANCE_ENABLED !== "false" && shouldRefreshBalanceAt(scheduledTime, env)) work.push(refreshBalanceOfPower(env));
    if (work.length) ctx.waitUntil(Promise.all(work));
  },
};

export function shouldRefreshAt(timestamp, env = {}) {
  const time = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  const startsAt = Date.parse(env.REFRESH_WINDOW_START || DEFAULT_REFRESH_START);
  const endsAt = Date.parse(env.REFRESH_WINDOW_END || DEFAULT_REFRESH_END);
  return Number.isFinite(time) && Number.isFinite(startsAt) && Number.isFinite(endsAt)
    && time >= startsAt && time < endsAt;
}

export function shouldRefreshBalanceAt(timestamp, env = {}) {
  const time = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  const startsAt = Date.parse(env.BALANCE_REFRESH_WINDOW_START || DEFAULT_BALANCE_REFRESH_START);
  const endsAt = Date.parse(env.BALANCE_REFRESH_WINDOW_END || DEFAULT_BALANCE_REFRESH_END);
  return Number.isFinite(time) && Number.isFinite(startsAt) && Number.isFinite(endsAt)
    && time >= startsAt && time < endsAt;
}

async function serveBalanceOfPower(env, origin) {
  if (!env.RESULTS_CACHE?.get) {
    return apiResponse({ error: "Results cache is not configured." }, 503, origin, { "cache-control": "no-store" });
  }

  const [latest, refreshStatus] = await Promise.all([readBalanceLastGood(env), readBalanceRefreshStatus(env)]);
  if (!latest) {
    return apiResponse(initialBalanceState(), 200, origin, { "cache-control": "public, max-age=15, s-maxage=30" });
  }

  const staleAfterSeconds = clampNumber(env.BALANCE_STALE_AFTER_SECONDS, 180, 60, 3600);
  const lastSuccessAt = refreshStatus?.lastSuccessAt || latest.fetchedAt;
  const lastSuccessMs = Date.parse(lastSuccessAt || "");
  const stale = shouldRefreshBalanceAt(Date.now(), env) && (!Number.isFinite(lastSuccessMs)
    || Date.now() - lastSuccessMs > staleAfterSeconds * 1000);
  const ttl = clampNumber(env.CACHE_SECONDS, 15, 5, 60);

  return apiResponse({
    ...latest,
    stale,
    checkedAt: lastSuccessAt || null,
  }, 200, origin, {
    "x-balance-cache": stale ? "stale-kv" : "kv",
    "cache-control": `public, max-age=5, s-maxage=${ttl}, stale-while-revalidate=120`,
  });
}

function initialBalanceState() {
  return {
    status: "waiting",
    source: "civicAPI",
    sourceUpdatedAt: null,
    fetchedAt: null,
    stale: false,
    sourceUrls: { senate: CIVICAPI_RESULTS_URL, house: CIVICAPI_RESULTS_URL },
    chambers: {
      senate: balanceChamber(0, 0, 0, 100, 51),
      house: balanceChamber(0, 0, 0, 435, 218),
    },
  };
}

async function refreshResults(env) {
  if (!env.RESULTS_CACHE?.put) throw new Error("RESULTS_CACHE KV binding is required for scheduled refreshes.");

  const sourceUrl = env.RESULTS_SOURCE_URL || DEFAULT_SOURCE;
  const dataUrl = resultsDataUrl(sourceUrl);
  const auxiliaryUrls = reportingDataUrls(sourceUrl);
  const previous = await readRefreshStatus(env);
  const now = new Date();
  const attemptAt = now.toISOString();
  const cacheBust = now.getTime();
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
      fetch(cacheBustedUrl(dataUrl, cacheBust), requestInit),
      fetchOptionalRows(cacheBustedUrl(auxiliaryUrls.districtReporting, cacheBust), requestInit),
      fetchOptionalRows(cacheBustedUrl(auxiliaryUrls.byElectionDistrict, cacheBust), requestInit),
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

async function refreshBalanceOfPower(env) {
  if (!env.RESULTS_CACHE?.put) throw new Error("RESULTS_CACHE KV binding is required for civicAPI balance refreshes.");

  const previous = await readBalanceRefreshStatus(env);
  const now = new Date();
  const attemptAt = now.toISOString();
  const nextAttemptMs = Date.parse(previous?.nextAttemptAt || "");
  if (Number.isFinite(nextAttemptMs) && nextAttemptMs > now.getTime()) return;

  try {
    const requestInit = balanceRequestInit();
    let body;
    if (env.BALANCE_FALLBACK_ENABLED !== "false" && env.BALANCE_FALLBACK_FIRST !== "false") {
      try {
        body = await fetchFallbackBalance(env, requestInit, attemptAt);
      } catch (fallbackError) {
        body = await fetchCivicApiBalance(env, requestInit, attemptAt);
        body.fallbackError = safeError(fallbackError);
      }
    } else {
      try {
        body = await fetchCivicApiBalance(env, requestInit, attemptAt);
      } catch (primaryError) {
        if (env.BALANCE_FALLBACK_ENABLED === "false") throw primaryError;
        body = await fetchFallbackBalance(env, requestInit, attemptAt);
        body.primaryError = safeError(primaryError);
      }
    }

    await Promise.all([
      writeBalanceLastGood(env, body),
      writeBalanceRefreshStatus(env, {
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
    await writeBalanceRefreshStatus(env, {
      ...previous,
      lastAttemptAt: attemptAt,
      lastError: safeError(error),
      nextAttemptAt: new Date(now.getTime() + backoffSeconds * 1000).toISOString(),
      consecutiveFailures,
    });
    console.error("Scheduled civicAPI balance refresh failed:", safeError(error));
  }
}

function balanceRequestInit() {
  return {
    headers: {
      "accept": "application/json",
      "user-agent": "Spotlight Delaware election-results monitor/1.6 (+https://spotlightdelaware.org)",
    },
    cf: { cacheTtl: 0, cacheEverything: false },
  };
}

async function fetchCivicApiBalance(env, requestInit, fetchedAt) {
  const [senateResponse, houseResponse] = await Promise.all([
    fetch(civicApiSearchUrl("senate", env), requestInit),
    fetch(civicApiSearchUrl("house", env), requestInit),
  ]);
  if (!senateResponse.ok || !houseResponse.ok) {
    const status = !senateResponse.ok ? senateResponse.status : houseResponse.status;
    const error = new Error(`civicAPI results feed returned HTTP ${status}`);
    error.status = status;
    throw error;
  }

  const [senatePayload, housePayload] = await Promise.all([senateResponse.json(), houseResponse.json()]);
  const senate = parseCivicApiBalance(senatePayload, "senate");
  const house = parseCivicApiBalance(housePayload, "house");
  return {
    status: "live",
    source: "civicAPI",
    sourceUpdatedAt: newestTimestamp(senate.sourceUpdatedAt, house.sourceUpdatedAt),
    fetchedAt,
    stale: false,
    sourceUrls: { senate: CIVICAPI_RESULTS_URL, house: CIVICAPI_RESULTS_URL },
    chambers: { senate: senate.chamber, house: house.chamber },
  };
}

async function fetchFallbackBalance(env, requestInit, fetchedAt) {
  const sourceUrl = env.BALANCE_FALLBACK_URL || DEFAULT_BALANCE_FALLBACK_URL;
  const response = await fetch(sourceUrl, requestInit);
  if (!response.ok) {
    const error = new Error(`National results fallback returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  const parsed = parseSitmapBalance(await response.json());
  return {
    status: "live",
    source: "civicAPI via sitmap.live",
    sourceUpdatedAt: parsed.sourceUpdatedAt,
    fetchedAt,
    stale: false,
    sourceUrls: { senate: sourceUrl, house: sourceUrl },
    chambers: parsed.chambers,
  };
}

export function civicApiSearchUrl(chamberId, env = {}) {
  const chamber = chamberId === "senate" ? "senate" : "house";
  const url = new URL(env.CIVICAPI_SEARCH_URL || CIVICAPI_SEARCH_ENDPOINT);
  url.searchParams.set("country", "US");
  url.searchParams.set("startDate", "2026-11-03");
  url.searchParams.set("endDate", "2026-11-03");
  url.searchParams.set("election_type", "General");
  url.searchParams.set("query", chamber === "senate" ? "US Senate" : "US House");
  url.searchParams.set("limit", "1000");
  return url.toString();
}

export function parseCivicApiBalance(input, chamberId) {
  const races = civicApiRaces(input).filter(race => isFederalChamberRace(race, chamberId));
  if (!races.length) throw new Error(`civicAPI ${chamberId} response did not include any federal ${chamberId} races.`);

  const usableRaces = chamberId === "house" ? uniqueVotingHouseRaces(races) : uniqueRaces(races);
  let democraticCalls = 0;
  let republicanCalls = 0;
  let otherCalls = 0;
  const timestamps = [];

  for (const race of usableRaces) {
    const updated = race?.last_updated || race?.lastUpdated || race?.updated_at || race?.updatedAt;
    if (updated) timestamps.push(updated);
    const candidates = asArray(race?.candidates || race?.candidate_results || race?.candidateResults);
    const winner = candidates.find(candidate => civicWinner(candidate?.winner || candidate?.is_winner || candidate?.isWinner));
    if (!winner) continue;
    const party = civicParty(winner?.party || winner?.party_name || winner?.partyName || winner?.party_code || winner?.partyCode);
    if (party === "democratic") democraticCalls += 1;
    else if (party === "republican") republicanCalls += 1;
    else otherCalls += 1;
  }

  const totalSeats = chamberId === "senate" ? 100 : 435;
  const majority = chamberId === "senate" ? 51 : 218;
  const democratic = democraticCalls + (chamberId === "senate" ? SENATE_HOLDOVERS.democratic : 0);
  const republican = republicanCalls + (chamberId === "senate" ? SENATE_HOLDOVERS.republican : 0);
  const other = otherCalls;
  if (democratic + republican + other > totalSeats) {
    throw new Error(`civicAPI ${chamberId} response contained more called seats than the chamber total.`);
  }

  return {
    sourceUpdatedAt: newestTimestamp(...timestamps),
    chamber: balanceChamber(democratic, republican, other, totalSeats, majority),
  };
}

export function parseSitmapBalance(input) {
  if (!input || typeof input !== "object") throw new Error("National results fallback returned an invalid response.");
  if (input.test === true) throw new Error("National results fallback returned test data.");

  const tallies = asArray(input.tallies);
  const senate = sitmapChamber(tallies, "senate", 100, 51);
  const house = sitmapChamber(tallies, "house", 435, 218);
  const sourceUpdatedAt = input.dataAsOf || input.lastSuccessfulFetch || input.fetchedAt || input.generatedAt || null;

  return { sourceUpdatedAt, chambers: { senate, house } };
}

function sitmapChamber(tallies, chamberId, total, majority) {
  const tally = tallies.find(item => String(item?.chamber || "").toLowerCase() === chamberId);
  if (!tally) throw new Error(`National results fallback did not include ${chamberId} totals.`);

  const won = tally.won && typeof tally.won === "object" ? tally.won : null;
  const holdover = tally.holdover && typeof tally.holdover === "object" ? tally.holdover : {};
  const control = tally.control && typeof tally.control === "object" ? tally.control : {};
  const democratic = won
    ? nonnegativeInteger(won.dem ?? won.democratic)
      + (chamberId === "senate" ? nonnegativeInteger(holdover.dem ?? holdover.democratic) + nonnegativeInteger(holdover.ind) : 0)
    : nonnegativeInteger(control.dem ?? control.democratic);
  const republican = won
    ? nonnegativeInteger(won.rep ?? won.republican)
      + (chamberId === "senate" ? nonnegativeInteger(holdover.rep ?? holdover.republican) : 0)
    : nonnegativeInteger(control.rep ?? control.republican);
  const other = won
    ? nonnegativeInteger(won.ind) + nonnegativeInteger(won.other)
    : nonnegativeInteger(control.ind) + nonnegativeInteger(control.other);
  if (democratic + republican + other > total) {
    throw new Error(`National results fallback contained more ${chamberId} seats than the chamber total.`);
  }

  return balanceChamber(democratic, republican, other, total, majority);
}

function nonnegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function balanceChamber(democratic, republican, other, total, majority) {
  const assigned = Math.max(0, democratic) + Math.max(0, republican) + Math.max(0, other);
  return {
    democratic: Math.max(0, democratic),
    republican: Math.max(0, republican),
    other: Math.max(0, other),
    uncalled: Math.max(0, total - assigned),
    total,
    majority,
  };
}

function civicApiRaces(input) {
  if (Array.isArray(input)) return input;
  if (!input || typeof input !== "object") return [];
  for (const key of ["races", "results", "items"]) {
    if (Array.isArray(input[key])) return input[key];
  }
  if (Array.isArray(input.data)) return input.data;
  if (input.data && typeof input.data === "object") return civicApiRaces(input.data);
  return [];
}

function uniqueRaces(races) {
  const seen = new Set();
  return races.filter((race, index) => {
    const key = String(race?.race_id || race?.raceId || race?.id || `${raceName(race)}-${index}`);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueVotingHouseRaces(races) {
  const seats = new Map();
  for (const race of uniqueRaces(races)) {
    if (!isVotingHouseRace(race)) continue;
    const key = houseSeatKey(race);
    const current = seats.get(key);
    if (!current || (isSpecialElection(current) && !isSpecialElection(race))) seats.set(key, race);
  }
  return [...seats.values()];
}

function isVotingHouseRace(race) {
  const details = race?.district_details || race?.districtDetails || {};
  const jurisdiction = String(
    race?.province || race?.state || race?.state_code || race?.stateCode
      || details?.province || details?.state || details?.state_code || details?.stateCode || "",
  ).trim().toUpperCase();
  if (["AS", "DC", "GU", "MP", "PR", "VI"].includes(jurisdiction)) return false;
  return !/delegate|resident commissioner/i.test(`${raceName(race)} ${districtName(race)}`);
}

function houseSeatKey(race) {
  const details = race?.district_details || race?.districtDetails || {};
  const jurisdiction = String(race?.province || race?.state || race?.state_code || race?.stateCode
    || details?.province || details?.state || details?.state_code || details?.stateCode || "").trim().toLowerCase();
  const district = districtName(race).toLowerCase().replace(/[^a-z0-9]+/g, "");
  return jurisdiction || district ? `${jurisdiction}:${district}` : String(race?.race_id || race?.raceId || race?.id || raceName(race));
}

function districtName(race) {
  const details = race?.district_details || race?.districtDetails || {};
  return String(race?.district || race?.district_name || race?.districtName || details?.district_name || details?.districtName || "");
}

function raceName(race) {
  const name = race?.election_name || race?.electionName || race?.name || race?.title || "";
  if (typeof name === "string") return name;
  return String(name?.en_US || name?.en || Object.values(name || {})[0] || "");
}

function isFederalChamberRace(race, chamberId) {
  const type = String(race?.type || race?.race_type || race?.raceType || "");
  const name = raceName(race);
  const office = `${type} ${name}`;
  const federal = "(?:US|U\\.?S\\.?|United States)";
  const chamber = chamberId === "senate" ? "Senate" : "House";
  return new RegExp(`\\b${federal}\\s+${chamber}\\b`, "i").test(office);
}

function isSpecialElection(race) {
  return /\bspecial\b/i.test(raceName(race));
}

function civicWinner(value) {
  if (value === true || value === 1) return true;
  return /^(?:1|true|yes|y|x|called|winner)$/i.test(String(value || "").trim());
}

function civicParty(value) {
  const raw = typeof value === "object"
    ? value?.abbreviation || value?.abbr || value?.code || value?.name || ""
    : value;
  const party = String(raw || "").trim().toLowerCase();
  if (/^(?:d|dem)$/.test(party) || /democrat|democratic|dfl/.test(party)) return "democratic";
  if (/^(?:r|rep|gop)$/.test(party) || /republican/.test(party)) return "republican";
  return "other";
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value && typeof value === "object" ? [value] : [];
}

function newestTimestamp(...values) {
  const valid = values.filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a));
  return valid[0] || null;
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

export function cacheBustedUrl(sourceUrl, timestamp = Date.now()) {
  if (!sourceUrl) return sourceUrl;
  const url = new URL(sourceUrl);
  url.searchParams.set("t", String(timestamp));
  return url.toString();
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
      : (rowStatus ?? rowHasElectionDayVotes(row));
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

function rowHasElectionDayVotes(row) {
  return rowNumber(row, ["Machine Votes", "Election Day Votes"]) > 0;
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

async function writeBalanceLastGood(env, body) {
  if (!env.RESULTS_CACHE?.put) return;
  await env.RESULTS_CACHE.put(BALANCE_CACHE_KEY, JSON.stringify(body));
}

async function readBalanceLastGood(env) {
  if (!env.RESULTS_CACHE?.get) return null;
  return env.RESULTS_CACHE.get(BALANCE_CACHE_KEY, "json");
}

async function writeBalanceRefreshStatus(env, body) {
  if (!env.RESULTS_CACHE?.put) return;
  await env.RESULTS_CACHE.put(BALANCE_STATUS_KEY, JSON.stringify(body), { expirationTtl: 604800 });
}

async function readBalanceRefreshStatus(env) {
  if (!env.RESULTS_CACHE?.get) return null;
  return env.RESULTS_CACHE.get(BALANCE_STATUS_KEY, "json");
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/\S+/g, "upstream page").slice(0, 240);
}
