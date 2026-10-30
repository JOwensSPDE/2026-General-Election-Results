# Spotlight Delaware — 2026 General Election Results

A responsive election-night results page and Cloudflare Worker for Delaware's Nov. 3, 2026 general election. The front end is designed for GitHub Pages and can be embedded in Newspack with an iframe.

## Included

- 43 contested races and 90 qualified candidates from Delaware's candidate list, updated Oct. 26, 2026.
- Only races with at least two qualified candidates are displayed.
- 90 face-centered 400×400 headshots prepared from the supplied source images.
- Democratic, Republican and independent candidates are color-coded within each race.
- Candidates are alphabetical by last name before results arrive, then reorder by vote total as each race begins reporting; tied candidates remain alphabetical.
- Statewide and race-specific precinct reporting, including the number still outstanding in every race widget.
- A Cloudflare scheduled Worker that requests Delaware's source once per minute and serves all readers from KV.
- Responsive desktop/mobile layouts and iframe-aware jump links.

## Local preview

From the `election-night-results` folder:

```powershell
npx.cmd --yes http-server .\public -p 4173 -a 127.0.0.1 -c-1
```

Then open the fictional-data preview in Chrome:

```text
http://127.0.0.1:4173/index.html?demo=1
```

Do not publish or embed the `?demo=1` address.

## Tests

```powershell
npm.cmd install
npm.cmd test
npm.cmd run validate:headshots
```

## Cloudflare Worker

The package is configured with a separate Worker name:

```text
delaware-general-results-2026
```

It reuses the existing `RESULTS_CACHE` KV namespace safely because the general-election cache keys are different from the primary-election keys.

The expected Delaware public-results page is:

```text
https://elections.delaware.gov/results/enr/GE2026.html?group=Statewide&filter=
```

Delaware may not publish that page until closer to Election Day. Once the official URL appears, compare it with `worker/wrangler.toml` and update `RESULTS_SOURCE_URL` if necessary.

The Worker derives and requests three official JSON feeds from that URL:

```text
Election_StatewideResults_ID_GE2026.json
Election_DistrictReporting_ID_GE2026.json
Election_ByElectionDistrict_ID_GE2026.json
```

The statewide feed supplies the vote totals. The other two feeds are joined by election district and contest to calculate the reported, total and outstanding precinct counts for each race. If either auxiliary feed is unavailable temporarily, vote totals continue updating and affected cards display “Awaiting precinct data” instead of a misleading statewide percentage.

Deploy from the project folder:

```powershell
npm.cmd run worker:deploy
```

The two UTC cron schedules cover 7:45 p.m. Nov. 3 through 7:59 a.m. Nov. 4 Eastern time. The page begins reading the cached Worker response at 8 p.m. Eastern and polls it every 20 seconds.

After deployment, confirm that this address works:

```text
https://delaware-general-results-2026.spotlightdelaware.workers.dev/api/health
```

## GitHub Pages

Upload everything inside `public` to the desired GitHub repository. If `public` remains a folder in the repository, the published address will end in `/public/`. If the contents are uploaded to the repository root, use the repository-root Pages address.

## Newspack iframe

Replace `YOUR-GITHUB-PAGES-URL` with the published page address:

```html
<iframe
  id="delaware-general-results"
  src="YOUR-GITHUB-PAGES-URL"
  title="2026 Delaware general election results"
  loading="eager"
  style="width:100%;min-height:900px;border:0;display:block"
></iframe>

<script>
  window.addEventListener("message", function (event) {
    if (event.origin !== "https://jowensspde.github.io") return;

    var frame = document.getElementById("delaware-general-results");
    if (event.source !== frame.contentWindow) return;

    if (event.data && event.data.type === "spotlight-election-results-height") {
      frame.style.height = event.data.height + "px";
    }

    if (event.data && event.data.type === "spotlight-election-results-scroll") {
      var frameTop = frame.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({
        top: frameTop + Number(event.data.top || 0),
        behavior: "smooth"
      });
    }
  });
</script>
```

## Election-night checks

1. After 7:45 p.m., `/api/health` should show `cacheReady: true`, a recent `lastSuccessAt`, and `lastError: null`.
2. `/api/results` should contain `reporting`, `contests`, `sourceUpdatedAt`, and `stale: false`. Each contest should also contain its own `reporting` object once the auxiliary feeds are available.
3. After 8 p.m., compare several totals on the public page with Delaware's official page.
4. Do not describe the reporting percentage as ballots counted; it is the percentage of election districts reporting.
