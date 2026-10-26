import { parseResultsPayload, resultsDataUrl } from "../worker/src/index.js";

const source = process.argv[2] || "https://elections.delaware.gov/results/enr/GE2026.html?group=Statewide&filter=";
const dataUrl = resultsDataUrl(source);
const response = await fetch(dataUrl, { headers: { "user-agent": "Spotlight Delaware results parser smoke test" } });
if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
const result = parseResultsPayload(await response.text(), source);
console.log(JSON.stringify({
  source: result.sourceUrl,
  dataUrl,
  sourceUpdatedAt: result.sourceUpdatedAt,
  reporting: result.reporting,
  contests: result.contests.length,
  candidates: result.contests.reduce((sum, contest) => sum + contest.candidates.length, 0)
}, null, 2));
