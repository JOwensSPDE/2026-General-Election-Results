import test from "node:test";
import assert from "node:assert/strict";
import worker, {
  attachRaceReporting,
  cacheBustedUrl,
  civicApiSearchUrl,
  parseCivicApiBalance,
  parseSitmapBalance,
  parseResultsHtml,
  parseResultsJson,
  parseResultsPayload,
  parseRaceReporting,
  reportingDataUrls,
  resultsDataUrl,
  shouldRefreshBalanceAt,
  shouldRefreshAt,
} from "../worker/src/index.js";

const fixture = `
  <p id="lastUpdated">Data as of 09/15/2026 20:44:52</p>
  <span class="resultsType"><span>UNOFFICIAL RESULTS</span></span>
  <span>120 of 530 Precincts Reporting</span>
  <div class="filtered table-responsive" id="statewide">
    <h2>Statewide</h2>
    <h3 class="contest-title USSenator">U.S. Senator</h3>
    <h4 class="USSenator Democratic">Democratic Party</h4>
    <table><thead><tr><th>Candidate</th><th>Machine Votes</th><th>Absentee Votes</th><th>Early Voting Votes</th><th>Total Votes</th><th>Percentage</th></tr></thead>
    <tbody><tr><td>JANE DOE</td><td>1,000</td><td>200</td><td>300</td><td>1,500</td><td>60 %</td></tr>
    <tr><td>JOHN SMITH</td><td>700</td><td>100</td><td>200</td><td>1,000</td><td>40 %</td></tr></tbody></table>
    <h4 class="USSenator Republican">Republican Party</h4>
    <table><thead><tr><th>Candidate</th><th>Total Votes</th><th>Percentage</th></tr></thead>
    <tbody><tr><td>A &amp; B</td><td>777</td><td>100 %</td></tr></tbody></table>
  </div>
  <div id="byrepdist"></div>`;

const jsonFixture = [
  {
    "Election Id": "GE2026",
    "Election Name": "2026 General Election",
    "Election Date": "2026-11-03",
    "Results Type": "UNOFFICIAL RESULTS",
    "Total Precincts": 530,
    "Precincts Reported": 120,
    "Party Name": "Democratic Party",
    "Contest Sorting Order": 200,
    "Contest Title": "U.S. Senator",
    "Candidate Name": "JANE DOE",
    "Pos": 1,
    "Machine Votes": "1,000",
    "Absentee Votes": "200",
    "Early Voting Votes": "300",
    "Total Votes": "1,500",
    "Percentage": 60,
    "ReportTime": "2026-11-03T20:44:52-05:00",
  },
  {
    "Election Id": "GE2026",
    "Election Name": "2026 General Election",
    "Election Date": "2026-11-03",
    "Results Type": "UNOFFICIAL RESULTS",
    "Total Precincts": 530,
    "Precincts Reported": 120,
    "Party Name": "Republican Party",
    "Contest Sorting Order": 200,
    "Contest Title": "U.S. Senator",
    "Candidate Name": "JOHN SMITH",
    "Pos": 2,
    "Machine Votes": "700",
    "Absentee Votes": "100",
    "Early Voting Votes": "200",
    "Total Votes": "1,000",
    "Percentage": 40,
    "ReportTime": "2026-11-03T20:44:52-05:00",
  },
];

const districtReportingFixture = [
  { "Election District": "01-01", "Reporting Status": "Reported" },
  { "Election District": "01-02", "Reporting Status": "Not Reported" },
  { "Election District": "02-01", "Reporting Status": "Yes" },
];

const byElectionDistrictFixture = [
  { "Contest Title": "U.S. Senator", "Election District": "01-01", "Candidate Name": "JANE DOE", "Total Votes": 12 },
  { "Contest Title": "U.S. Senator", "Election District": "01-02", "Candidate Name": "JANE DOE", "Total Votes": 0 },
  { "Contest Title": "U.S. Senator", "Election District": "02-01", "Candidate Name": "JANE DOE", "Total Votes": 8 },
  { "Contest Title": "State Representative District 1", "Election District": "01-01", "Candidate Name": "ALPHA", "Total Votes": 9 },
  { "Contest Title": "State Representative District 1", "Election District": "01-02", "Candidate Name": "ALPHA", "Total Votes": 0 },
];

const senateCivicFixture = {
  results: [
    { race_id: 101, type: "US Senate", election_name: "Delaware US Senate", last_updated: "2026-11-04T02:15:00Z", candidates: [{ name: "A", party: "DEM", winner: true }] },
    { race_id: 102, type: "US Senate", election_name: "Georgia US Senate", last_updated: "2026-11-04T02:15:20Z", candidates: [{ name: "B", party: { abbreviation: "GOP" }, winner: 1 }] },
    { race_id: 103, type: "US Senate", election_name: "Maine US Senate", last_updated: "2026-11-04T02:15:10Z", candidates: [{ name: "C", party: "IND", winner: false }] },
    { race_id: 104, type: "State Senate", election_name: "US Virgin Islands Senate St. Croix District", candidates: [{ name: "D", party: "DEM", winner: true }] },
  ],
};

const houseCivicFixture = {
  data: {
    races: [
      { race_id: 201, type: "US House", province: "NY", district: "1", election_name: "New York US House 1", last_updated: "2026-11-04T02:15:30Z", candidates: [{ name: "A", party: "Democratic", winner: true }] },
      { race_id: 202, type: "US House", province: "TX", district: "2", election_name: "Texas US House 2", last_updated: "2026-11-04T02:15:40Z", candidates: [{ name: "B", party: "Republican", winner: "yes" }] },
      { race_id: 203, province: "DC", district: "At-large", election_name: "District of Columbia Delegate", candidates: [{ name: "C", party: "DEM", winner: true }] },
      { race_id: 204, type: "US House", province: "AZ", district: "7", election_name: "Arizona US House 7 Special", candidates: [{ name: "D", party: "DEM", winner: true }] },
      { race_id: 205, type: "US House", province: "AZ", district: "7", election_name: "Arizona US House 7", candidates: [{ name: "E", party: "GOP", winner: true }] },
    ],
  },
};

const sitmapFixture = {
  generatedAt: "2026-11-04T00:45:33.208Z",
  dataAsOf: "2026-11-04T00:43:36.904Z",
  test: false,
  tallies: [
    {
      chamber: "senate",
      won: { dem: 2 },
      holdover: { dem: 32, ind: 2, rep: 31 },
      control: { dem: 36, rep: 31 },
      open: 33,
    },
    {
      chamber: "house",
      won: { dem: 10, rep: 5 },
      unopposed: { dem: 4 },
      control: { dem: 14, rep: 5 },
      open: 416,
    },
  ],
};

test("parses statewide contests, parties, totals and reporting", () => {
  const result = parseResultsHtml(fixture, "https://example.com/results");
  assert.equal(result.sourceUpdatedAt, "09/15/2026 20:44:52");
  assert.equal(result.reporting.reported, 120);
  assert.equal(result.reporting.total, 530);
  assert.equal(result.reporting.percentage, 22.64);
  assert.equal(result.contests.length, 1);
  assert.equal(result.contests[0].title, "U.S. Senator");
  assert.equal(result.contests[0].candidates[0].party, "Democratic");
  assert.equal(result.contests[0].candidates[0].votes, 1500);
  assert.equal(result.contests[0].candidates[2].name, "A & B");
  assert.equal(result.contests[0].candidates[2].party, "Republican");
});

test("fails loudly when the statewide markup changes", () => {
  assert.throws(() => parseResultsHtml("<html></html>"), /statewide results section/i);
});

test("derives Delaware's statewide JSON feed from the public results page", () => {
  assert.equal(
    resultsDataUrl("https://elections.delaware.gov/results/enr/GE2026.html?group=Statewide&filter="),
    "https://elections.delaware.gov/results/enr/Election_StatewideResults_ID_GE2026.json",
  );
});

test("derives Delaware's race-reporting feeds from the public results page", () => {
  assert.deepEqual(
    reportingDataUrls("https://elections.delaware.gov/results/enr/GE2026.html?group=Statewide&filter="),
    {
      districtReporting: "https://elections.delaware.gov/results/enr/Election_DistrictReporting_ID_GE2026.json",
      byElectionDistrict: "https://elections.delaware.gov/results/enr/Election_ByElectionDistrict_ID_GE2026.json",
    },
  );
});

test("adds Delaware's cache-busting timestamp without changing other parameters", () => {
  const url = new URL(cacheBustedUrl(
    "https://elections.delaware.gov/results/enr/Election_StatewideResults_ID_GE2026.json?group=Statewide",
    1793757600000,
  ));
  assert.equal(url.searchParams.get("group"), "Statewide");
  assert.equal(url.searchParams.get("t"), "1793757600000");
});

test("calculates reporting and outstanding precincts for each race", () => {
  const reporting = parseRaceReporting(byElectionDistrictFixture, districtReportingFixture);
  assert.deepEqual(reporting["u-s-senator"], {
    reported: 2,
    total: 3,
    percentage: 66.67,
    outstanding: 1,
    label: "Precincts reporting in this race",
  });
  assert.deepEqual(reporting["state-representative-district-1"], {
    reported: 1,
    total: 2,
    percentage: 50,
    outstanding: 1,
    label: "Precincts reporting in this race",
  });
});

test("does not treat early or absentee votes as a reported election-day precinct", () => {
  const rows = [
    {
      "Contest Title": "U.S. Senator",
      "Election District": "Election District 01-01",
      "Machine Votes": 0,
      "Absentee Votes": 39,
      "Early Voting Votes": 177,
      "Total Votes": 216,
    },
    {
      "Contest Title": "U.S. Senator",
      "Election District": "Election District 01-02",
      "Machine Votes": 0,
      "Absentee Votes": 44,
      "Early Voting Votes": 229,
      "Total Votes": 273,
    },
  ];

  assert.deepEqual(parseRaceReporting(rows, [])["u-s-senator"], {
    reported: 0,
    total: 2,
    percentage: 0,
    outstanding: 2,
    label: "Precincts reporting in this race",
  });

  rows[0]["Machine Votes"] = 12;
  assert.deepEqual(parseRaceReporting(rows, [])["u-s-senator"], {
    reported: 1,
    total: 2,
    percentage: 50,
    outstanding: 1,
    label: "Precincts reporting in this race",
  });
});

test("attaches race reporting to official statewide contest results", () => {
  const parsed = parseResultsJson(jsonFixture, "https://example.com/public-results");
  const result = attachRaceReporting(parsed, byElectionDistrictFixture, districtReportingFixture);
  assert.equal(result.raceReportingAvailable, true);
  assert.equal(result.contests[0].reporting.reported, 2);
  assert.equal(result.contests[0].reporting.total, 3);
  assert.equal(result.contests[0].reporting.outstanding, 1);
});

test("parses Delaware's official statewide JSON format", () => {
  const result = parseResultsJson(jsonFixture, "https://example.com/public-results");
  assert.equal(result.sourceUpdatedAt, "2026-11-03T20:44:52-05:00");
  assert.equal(result.reporting.reported, 120);
  assert.equal(result.reporting.total, 530);
  assert.equal(result.reporting.percentage, 22.64);
  assert.equal(result.contests.length, 1);
  assert.equal(result.contests[0].candidates[0].party, "Democratic");
  assert.equal(result.contests[0].candidates[1].party, "Republican");
  assert.equal(result.contests[0].candidates[0].votes, 1500);
});

test("auto-detects the official JSON response", () => {
  const result = parseResultsPayload(JSON.stringify(jsonFixture));
  assert.equal(result.contests[0].candidates[1].name, "JOHN SMITH");
});

test("refresh window uses the configured Delaware election-night interval", () => {
  assert.equal(shouldRefreshAt("2026-11-03T19:44:59-05:00"), false);
  assert.equal(shouldRefreshAt("2026-11-03T19:45:00-05:00"), true);
  assert.equal(shouldRefreshAt("2026-11-04T07:59:59-05:00"), true);
  assert.equal(shouldRefreshAt("2026-11-04T08:00:00-05:00"), false);
});

test("national balance refresh starts at 7 p.m. Eastern", () => {
  assert.equal(shouldRefreshBalanceAt("2026-11-03T18:59:59-05:00"), false);
  assert.equal(shouldRefreshBalanceAt("2026-11-03T19:00:00-05:00"), true);
  assert.equal(shouldRefreshBalanceAt("2026-11-04T07:59:59-05:00"), true);
  assert.equal(shouldRefreshBalanceAt("2026-11-04T08:00:00-05:00"), false);
});

test("builds civicAPI Senate and House search requests", () => {
  const senate = new URL(civicApiSearchUrl("senate"));
  const house = new URL(civicApiSearchUrl("house"));
  assert.equal(senate.origin + senate.pathname, "https://civicapi.org/api/v2/race/search");
  assert.equal(senate.searchParams.get("country"), "US");
  assert.equal(senate.searchParams.get("startDate"), "2026-11-03");
  assert.equal(senate.searchParams.get("endDate"), "2026-11-03");
  assert.equal(senate.searchParams.get("election_type"), "General");
  assert.equal(senate.searchParams.get("query"), "US Senate");
  assert.equal(house.searchParams.get("election_type"), "General");
  assert.equal(house.searchParams.get("query"), "US House");
  assert.equal(house.searchParams.get("limit"), "1000");
});

test("parses civicAPI calls, Senate holdovers and voting House seats", () => {
  const senate = parseCivicApiBalance(senateCivicFixture, "senate");
  assert.deepEqual(senate.chamber, {
    democratic: 35,
    republican: 32,
    other: 0,
    uncalled: 33,
    total: 100,
    majority: 51,
  });
  assert.equal(senate.sourceUpdatedAt, "2026-11-04T02:15:20Z");

  const house = parseCivicApiBalance(houseCivicFixture, "house");
  assert.deepEqual(house.chamber, {
    democratic: 1,
    republican: 2,
    other: 0,
    uncalled: 432,
    total: 435,
    majority: 218,
  });
});

test("parses the national JSON fallback totals", () => {
  const parsed = parseSitmapBalance(sitmapFixture);
  assert.equal(parsed.sourceUpdatedAt, "2026-11-04T00:43:36.904Z");
  assert.deepEqual(parsed.chambers.senate, {
    democratic: 36,
    republican: 31,
    other: 0,
    uncalled: 33,
    total: 100,
    majority: 51,
  });
  assert.deepEqual(parsed.chambers.house, {
    democratic: 10,
    republican: 5,
    other: 0,
    uncalled: 420,
    total: 435,
    majority: 218,
  });
});

test("rejects test data from the national JSON fallback", () => {
  assert.throws(() => parseSitmapBalance({ ...sitmapFixture, test: true }), /test data/i);
});

test("scheduled civicAPI refresh caches balance totals without requesting Delaware before 7:45 p.m.", async () => {
  const kv = createKv();
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async input => {
    const url = String(input);
    requested.push(url);
    const query = new URL(url).searchParams.get("query");
    if (query === "US Senate") return Response.json(senateCivicFixture);
    if (query === "US House") return Response.json(houseCivicFixture);
    return new Response("Not found", { status: 404 });
  };
  let scheduledWork;

  try {
    worker.scheduled(
      { scheduledTime: Date.parse("2026-11-04T00:15:00Z") },
      { RESULTS_CACHE: kv, BALANCE_FALLBACK_ENABLED: "false" },
      { waitUntil(promise) { scheduledWork = promise; } },
    );
    assert.ok(scheduledWork);
    await scheduledWork;
  } finally {
    globalThis.fetch = originalFetch;
  }

  const stored = await kv.get("delaware-general-results-2026:civicapi-balance:last-good", "json");
  assert.equal(requested.length, 2);
  assert.equal(stored.chambers.senate.democratic, 35);
  assert.equal(stored.chambers.house.republican, 2);
  assert.equal(stored.source, "civicAPI");
});

test("scheduled balance refresh uses the one-minute JSON feed before the direct civicAPI search", async () => {
  const kv = createKv();
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async input => {
    const url = String(input);
    requested.push(url);
    if (url.includes("sitmap.live/api/elections/us-2026.json")) return Response.json(sitmapFixture);
    if (url.includes("civicapi.org/api/v2/race/search")) return new Response("Unavailable", { status: 503 });
    return new Response("Not found", { status: 404 });
  };
  let scheduledWork;

  try {
    worker.scheduled(
      { scheduledTime: Date.parse("2026-11-04T00:20:00Z") },
      { RESULTS_CACHE: kv },
      { waitUntil(promise) { scheduledWork = promise; } },
    );
    await scheduledWork;
  } finally {
    globalThis.fetch = originalFetch;
  }

  const stored = await kv.get("delaware-general-results-2026:civicapi-balance:last-good", "json");
  const status = await kv.get("delaware-general-results-2026:civicapi-balance:refresh-status-v2", "json");
  assert.equal(requested.length, 1);
  assert.match(requested[0], /sitmap\.live/);
  assert.equal(stored.source, "civicAPI via sitmap.live");
  assert.equal(stored.chambers.senate.democratic, 36);
  assert.equal(stored.chambers.house.democratic, 10);
  assert.equal(stored.chambers.house.republican, 5);
  assert.equal(status.lastError, null);
  assert.equal(status.consecutiveFailures, 0);
});

test("scheduled refresh stores parsed results in KV", async () => {
  const kv = createKv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(fixture, { status: 200 });
  let scheduledWork;

  try {
    worker.scheduled(
      { scheduledTime: Date.parse("2026-11-04T01:01:00Z") },
      { RESULTS_CACHE: kv, RESULTS_SOURCE_URL: "https://example.com/results", CIVICAPI_BALANCE_ENABLED: "false" },
      { waitUntil(promise) { scheduledWork = promise; } },
    );
    assert.ok(scheduledWork);
    await scheduledWork;
  } finally {
    globalThis.fetch = originalFetch;
  }

  const stored = await kv.get("delaware-general-results-2026:last-good", "json");
  const status = await kv.get("delaware-general-results-2026:refresh-status", "json");
  assert.equal(stored.contests[0].candidates[0].votes, 1500);
  assert.equal(status.lastError, null);
  assert.equal(status.consecutiveFailures, 0);
});

test("scheduled refresh joins the official district feeds into each contest", async () => {
  const kv = createKv();
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async input => {
    const url = String(input);
    requested.push(url);
    if (url.includes("Election_StatewideResults_ID")) {
      return new Response(JSON.stringify(jsonFixture), { status: 200 });
    }
    if (url.includes("Election_DistrictReporting_ID")) {
      return new Response(JSON.stringify(districtReportingFixture), { status: 200 });
    }
    if (url.includes("Election_ByElectionDistrict_ID")) {
      return new Response(JSON.stringify(byElectionDistrictFixture), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };
  let scheduledWork;

  try {
    worker.scheduled(
      { scheduledTime: Date.parse("2026-11-04T01:01:00Z") },
      {
        RESULTS_CACHE: kv,
        RESULTS_SOURCE_URL: "https://elections.delaware.gov/results/enr/GE2026.html?group=Statewide&filter=",
        CIVICAPI_BALANCE_ENABLED: "false",
      },
      { waitUntil(promise) { scheduledWork = promise; } },
    );
    await scheduledWork;
  } finally {
    globalThis.fetch = originalFetch;
  }

  const stored = await kv.get("delaware-general-results-2026:last-good", "json");
  assert.equal(requested.length, 3);
  assert.ok(requested.every(url => new URL(url).searchParams.has("t")));
  assert.equal(stored.contests[0].reporting.reported, 2);
  assert.equal(stored.contests[0].reporting.total, 3);
  assert.equal(stored.contests[0].reporting.outstanding, 1);
  assert.equal(stored.raceReportingAvailable, true);
});

test("reader requests use KV without fetching the Delaware source", async () => {
  const parsed = parseResultsHtml(fixture, "https://example.com/results");
  const fetchedAt = new Date().toISOString();
  const kv = createKv({
    "delaware-general-results-2026:last-good": { ...parsed, fetchedAt, stale: false },
    "delaware-general-results-2026:refresh-status": {
      lastAttemptAt: fetchedAt,
      lastSuccessAt: fetchedAt,
      lastError: null,
      nextAttemptAt: null,
      consecutiveFailures: 0,
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Reader request must not fetch upstream"); };

  try {
    const response = await worker.fetch(
      new Request("https://worker.example/api/results", {
        headers: { origin: "https://jowensspde.github.io" },
      }),
      {
        RESULTS_CACHE: kv,
        ALLOWED_ORIGIN: "https://spotlightdelaware.org,https://jowensspde.github.io",
      },
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-results-cache"), "kv");
    assert.equal(response.headers.get("access-control-allow-origin"), "https://jowensspde.github.io");
    assert.equal(body.contests[0].candidates[0].votes, 1500);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function createKv(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  return {
    async get(key, type) {
      const value = values.get(key);
      if (value == null) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) {
      values.set(key, value);
    },
  };
}
