# National-results fallback hotfix

Extract this ZIP into:

`C:\Users\Jake\OneDrive\Desktop\Spotlight Delaware 2026 General Results CivicAPI\election-night-results`

Choose **Replace the files in the destination** when Windows asks.

The ZIP updates:

- `worker\src\index.js`
- `worker\wrangler.toml`
- `public\app.js`
- `tests\parser.test.js`

Then open PowerShell and run:

```powershell
$project = "C:\Users\Jake\OneDrive\Desktop\Spotlight Delaware 2026 General Results CivicAPI\election-night-results"
Set-Location $project

npm.cmd test
npm.cmd run worker:deploy
```

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

Also upload `public/app.js` to the same location in the GitHub repository so the page can identify the fallback source in its status line.
