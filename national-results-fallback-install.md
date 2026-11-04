# Election-results live-sync hotfix v4

This version makes two corrections:

- It counts only civicAPI-called House races, excluding unopposed seats, so the House totals align with civicAPI's map. Senate totals continue to include seats not up for election and independents who caucus with Democrats.
- It no longer treats early or absentee votes as proof that a Delaware election-day precinct has reported. A precinct is counted only after machine votes appear or Delaware supplies an explicit reporting status.
- It adds the same timestamp cache-buster used by Delaware's official results page, preventing the Worker from receiving a three-minute-old cached JSON response.

Extract this ZIP into:

`C:\Users\Jake\OneDrive\Desktop\Spotlight Delaware 2026 General Results CivicAPI\election-night-results`

Choose **Replace the files in the destination** when Windows asks.

The ZIP updates:

- `worker\src\index.js`
- `tests\parser.test.js`

Then open PowerShell and run:

```powershell
$project = "C:\Users\Jake\OneDrive\Desktop\Spotlight Delaware 2026 General Results CivicAPI\election-night-results"
Set-Location $project

npm.cmd test
npm.cmd run worker:deploy
```

The test command should report **21 passing tests**.

After the deployment finishes, wait about one minute and run:

```powershell
Invoke-RestMethod "https://delaware-general-results-2026.spotlightdelaware.workers.dev/api/health?check=fallback" |
    ConvertTo-Json -Depth 8

Invoke-RestMethod "https://delaware-general-results-2026.spotlightdelaware.workers.dev/api/balance?check=fallback" |
    ConvertTo-Json -Depth 8
```

Expected result:

- `balanceOfPower.cacheReady` is `true`.
- `/api/balance` has `status: "live"`.
- When the fallback is active, `source` is `"civicAPI via sitmap.live"`.
- Senate and House totals are greater than zero once calls are available.
- Delaware race widgets show zero precincts reported while the official statewide feed remains at zero, even though early and absentee totals are displayed.

Commit both updated files to the GitHub repository after deployment.
