import test from "node:test";
import assert from "node:assert/strict";
import worker, {
  attachRaceReporting,
  parseResultsHtml,
  parseResultsJson,
  parseResultsPayload,
  parseRaceReporting,
  reportingDataUrls,
  resultsDataUrl,
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

test("scheduled refresh stores parsed results in KV", async () => {
  const kv = createKv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(fixture, { status: 200 });
  let scheduledWork;

  try {
    worker.scheduled(
      { scheduledTime: Date.parse("2026-11-04T01:01:00Z") },
      { RESULTS_CACHE: kv, RESULTS_SOURCE_URL: "https://example.com/results" },
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
      },
      { waitUntil(promise) { scheduledWork = promise; } },
    );
    await scheduledWork;
  } finally {
    globalThis.fetch = originalFetch;
  }

  const stored = await kv.get("delaware-general-results-2026:last-good", "json");
  assert.equal(requested.length, 3);
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
