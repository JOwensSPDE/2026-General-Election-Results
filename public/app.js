(() => {
  const config = window.ELECTION_RESULTS_CONFIG || {};
  const seeds = window.SEED_CONTESTS || [];
  const headshots = window.CANDIDATE_HEADSHOTS || {};
  const demoMode = new URLSearchParams(location.search).get("demo") === "1";
  const groups = [
    { id: "us-senate", title: "U.S. Senate", match: c => isTitle(c, "U.S. Senator") },
    { id: "us-house", title: "U.S. House", match: c => /Representative in Congress/i.test(c.title) },
    { id: "statewide-offices", title: "Statewide Offices", match: c => ["Attorney General", "Auditor of Accounts", "State Treasurer"].some(title => isTitle(c, title)) },
    { id: "state-senate", title: "State Senate", match: c => /^State Senator District \d+$/i.test(c.title), districtSort: true },
    { id: "state-house", title: "State House of Representatives", match: c => /^State Representative District \d+$/i.test(c.title), districtSort: true },
    { id: "new-castle-county", title: "New Castle County Council", match: c => /^New Castle County Council District \d+$/i.test(c.title), districtSort: true },
    { id: "other-county-races", title: "Kent and Sussex County Races", match: c => /^(Kent|Sussex) County/i.test(c.title), districtSort: true }
  ];

  const els = {
    groups: document.querySelector("#race-groups"),
    nav: document.querySelector("#race-nav"),
    notice: document.querySelector("#notice"),
    refresh: document.querySelector("#refresh"),
    update: document.querySelector("#update-label"),
    liveLabel: document.querySelector("#live-label"),
    pulse: document.querySelector("#pulse"),
    statewidePercent: document.querySelector("#statewide-percent"),
    statewideMeter: document.querySelector("#statewide-meter"),
    statewideDetail: document.querySelector("#statewide-detail"),
    statewideStatus: document.querySelector("#statewide-status"),
    source: document.querySelector("#source-link")
  };

  let state = {
    contests: seeds,
    reporting: { reported: 0, total: 0, percentage: 0 },
    sourceUpdatedAt: null,
    fetchedAt: null,
    status: "Awaiting results",
    stale: false,
    live: false
  };

  buildNav();
  render();
  els.refresh.addEventListener("click", () => refreshResults(true));
  if ("ResizeObserver" in window) new ResizeObserver(postHeight).observe(document.body);
  window.addEventListener("load", postHeight);

  if (demoMode) {
    state = demoState();
    showNotice("Demo mode is on. These vote totals are fictional and are shown only to preview the design.");
    render();
  } else {
    schedulePolling();
  }

  function schedulePolling() {
    const starts = new Date(config.pollingStartsAt || "2026-11-03T20:00:00-05:00");
    const now = new Date();
    if (now >= starts) {
      refreshResults();
      setInterval(refreshResults, Math.max(15000, Number(config.pollIntervalMs) || 20000));
      return;
    }

    const formatter = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" });
    els.update.textContent = `Automatic updates begin ${formatter.format(starts)}.`;
    const delay = Math.min(starts.getTime() - now.getTime(), 2147483647);
    setTimeout(schedulePolling, delay);
  }

  async function refreshResults(manual = false) {
    if (!validApiUrl(config.apiUrl)) {
      showNotice("Deployment setup is incomplete: add the deployed Worker URL in config.js.", "error");
      return;
    }

    els.refresh.disabled = true;
    els.refresh.textContent = "Refreshing…";
    try {
      const response = await fetch(config.apiUrl, { cache: "no-store", headers: { accept: "application/json" } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Results service returned ${response.status}`);
      if (!Array.isArray(data.contests)) throw new Error("The results response did not include contests.");

      state = {
        ...data,
        contests: mergeWithSeeds(data.contests),
        live: true
      };
      showNotice(data.warning || "", data.stale ? "error" : "");
      render();
    } catch (error) {
      showNotice(`Live results could not be refreshed. ${error.message} The last displayed update remains on screen.`, "error");
      if (manual) els.update.textContent = "Manual refresh failed; the prior update is still displayed.";
    } finally {
      els.refresh.disabled = false;
      els.refresh.textContent = "Refresh now";
    }
  }

  function mergeWithSeeds(incoming) {
    return seeds.map(seed => {
      const result = incoming.find(item => contestKey(item) === contestKey(seed));
      if (!result) return seed;
      const candidates = seed.candidates.map(candidate => {
        const sourceName = candidate.sourceName || candidate.name;
        const found = result.candidates.find(item => normalizedName(item.name) === normalizedName(sourceName));
        return found ? { ...candidate, ...found, name: candidate.name, party: candidate.party || found.party } : candidate;
      });
      return { ...seed, ...result, candidates };
    });
  }

  function render() {
    const reporting = state.reporting || { reported: 0, total: 0, percentage: 0 };
    const pct = Number(reporting.percentage) || 0;
    els.statewidePercent.textContent = `${formatPercent(pct, true)}%`;
    els.statewideMeter.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    els.statewideDetail.textContent = reporting.total
      ? `${formatNumber(reporting.reported)} of ${formatNumber(reporting.total)} election districts reporting`
      : "Waiting for the first election-district update";
    els.statewideStatus.textContent = state.stale ? "Last good update" : (state.live ? "Updating live" : "Awaiting results");
    els.liveLabel.textContent = demoMode ? "DEMO DATA" : (state.live ? (state.stale ? "STALE UPDATE" : "LIVE") : "PRE-ELECTION");
    els.pulse.classList.toggle("live", state.live && !state.stale && !demoMode);
    els.source.href = state.sourceUrl || config.sourceUrl || els.source.href;

    if (state.sourceUpdatedAt) {
      els.update.textContent = `Delaware source updated ${state.sourceUpdatedAt}${state.stale ? " · showing cached results" : ""}`;
    } else if (state.fetchedAt) {
      els.update.textContent = `Checked ${formatTime(state.fetchedAt)}`;
    }

    els.groups.replaceChildren(...renderGroups(reporting));
    els.groups.setAttribute("aria-busy", "false");
    requestAnimationFrame(postHeight);
  }

  function renderGroups(reporting) {
    const rendered = [];
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      const next = groups[index + 1];
      const paired = group.id === "us-senate" && next?.id === "us-house";

      if (!paired) {
        rendered.push(renderGroup(group, reporting));
        continue;
      }

      const pair = element("div", "race-pair");
      pair.append(renderGroup(group, reporting), renderGroup(next, reporting));
      rendered.push(pair);
      index += 1;
    }
    return rendered;
  }

  function renderGroup(group, reporting) {
    const contests = state.contests.filter(group.match).sort((a, b) => {
      if (group.districtSort) {
        const districtDiff = district(a.title) - district(b.title);
        if (districtDiff) return districtDiff;
      }
      return (a.seedOrder ?? 0) - (b.seedOrder ?? 0);
    });
    const section = element("section", "race-group");
    section.id = group.id;
    const heading = element("h2", "group-title", group.title);
    const grid = element("div", "race-grid");
    contests.forEach(contest => grid.append(renderCard(contest, reporting)));
    section.append(heading, grid);
    return section;
  }

  function renderCard(contest, reporting) {
    const votesCast = contest.candidates.reduce((sum, candidate) => sum + (Number(candidate.votes) || 0), 0);
    const awaiting = votesCast === 0;
    const card = element("article", `race-card general${awaiting ? " awaiting" : ""}`);
    card.id = contest.id || contestKey(contest);

    const head = element("div", "card-head");
    const kicker = element("div", "card-kicker");
    kicker.append(
      element("span", "party-pill", "General election"),
      element("span", "reporting-mini", reporting.total ? `${formatPercent(reporting.percentage, true)}% reporting statewide` : "Awaiting reports")
    );
    head.append(kicker, element("h3", "", displayTitle(contest.title)));

    const bar = element("div", "share-bar");
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", awaiting ? "No votes reported" : voteShareLabel(contest.candidates, votesCast));
    contest.candidates.forEach((candidate, index) => {
      const share = candidateShare(candidate, votesCast);
      const segment = element("span", "share-segment");
      segment.style.width = `${share}%`;
      segment.style.background = candidateColor(candidate.party, index);
      bar.append(segment);
    });

    const list = element("ol", "candidate-list");
    [...contest.candidates].sort((a, b) => {
      if (awaiting) return 0;
      return (Number(b.votes) || 0) - (Number(a.votes) || 0);
    }).forEach((candidate, index) => list.append(renderCandidate(candidate, votesCast, index)));

    const foot = element("div", "card-foot");
    foot.append(element("span", "", awaiting ? "No votes reported" : `${formatNumber(votesCast)} votes counted`), element("span", "", "Unofficial"));
    card.append(head, bar, list, foot);
    return card;
  }

  function renderCandidate(candidate, totalVotes, index) {
    const item = element("li", "candidate");
    const portrait = element("div", "portrait", initials(candidate.name));
    const img = new Image();
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.src = photoFor(candidate.sourceName || candidate.name);
    img.addEventListener("error", () => img.remove());
    portrait.append(img);

    const detail = element("div", "candidate-detail");
    detail.append(
      element("div", "candidate-name", candidate.name),
      element("div", "candidate-votes", `${shortParty(candidate.party)} · ${totalVotes ? `${formatNumber(candidate.votes)} votes` : "Waiting for results"}`)
    );
    const pct = totalVotes ? candidateShare(candidate, totalVotes) : null;
    const share = element("div", "candidate-share", pct === null ? "—" : `${formatPercent(pct)}%`);
    share.style.color = totalVotes ? candidateColor(candidate.party, index) : "";
    item.append(portrait, detail, share);
    return item;
  }

  function buildNav() {
    els.nav.replaceChildren(...groups.map(group => {
      const link = element("a", "", shortNavTitle(group.title));
      link.href = `#${group.id}`;
      link.addEventListener("click", event => {
        const target = document.getElementById(group.id);
        if (!target || window.parent === window) return;
        event.preventDefault();
        window.parent.postMessage({
          type: "spotlight-election-results-scroll",
          top: Math.max(0, target.getBoundingClientRect().top + window.scrollY - 16),
        }, "*");
      });
      return link;
    }));
  }

  function demoState() {
    const contests = seeds.map((contest, contestIndex) => {
      const weights = contest.candidates.map((_, index) => 28 + ((contestIndex * 23 + index * 37) % 79));
      const totalWeight = weights.reduce((a, b) => a + b, 0);
      const totalVotes = 1900 + ((contestIndex * 977) % 23000);
      let allocated = 0;
      const candidates = contest.candidates.map((candidate, index) => {
        const votes = index === contest.candidates.length - 1 ? totalVotes - allocated : Math.round(totalVotes * weights[index] / totalWeight);
        allocated += votes;
        return { ...candidate, votes, percentage: Number((votes / totalVotes * 100).toFixed(2)) };
      });
      return { ...contest, candidates };
    });
    return {
      contests,
      reporting: { reported: 318, total: 530, percentage: 60 },
      sourceUpdatedAt: "11/03/2026 10:14:32 PM",
      fetchedAt: new Date().toISOString(),
      sourceUrl: config.sourceUrl,
      status: "DEMO DATA",
      stale: false,
      live: true
    };
  }

  function showNotice(message, kind = "") {
    els.notice.hidden = !message;
    els.notice.textContent = message;
    els.notice.className = `wrap notice${kind ? ` ${kind}` : ""}`;
  }

  function displayTitle(title) {
    return title.replace(/^State Senator/i, "State Senate").replace(/^State Representative/i, "State House");
  }

  function shortNavTitle(title) {
    return title.replace("New Castle County ", "NCC ").replace("State House of Representatives", "State House");
  }

  function contestKey(contest) {
    const title = contest.title.replace(/^U\. ?S\. Representative In Congress$/i, "Representative in Congress");
    return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  function normalizedName(name) {
    return name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
      .replace(/\b(jr|sr|ii|iii|iv)\b/g, "").replace(/[^a-z0-9]+/g, "").trim();
  }

  function photoFor(name) {
    const key = name.toUpperCase();
    return headshots[key] || `assets/headshots/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.jpg`;
  }

  function initials(name) {
    const words = name.replace(/"[^"]+"/g, "").replace(/\b(Jr|Sr|II|III|IV)\.?\b/gi, "").match(/[A-Za-zÀ-ÖØ-öø-ÿ]+/g) || [];
    return `${words[0]?.[0] || ""}${words.at(-1)?.[0] || ""}`.toUpperCase();
  }

  function candidateShare(candidate, total) {
    return total ? Number(((Number(candidate.votes) || 0) / total * 100).toFixed(2)) : 0;
  }

  function voteShareLabel(candidates, total) {
    return candidates.map(candidate => `${candidate.name}: ${formatPercent(candidateShare(candidate, total))} percent`).join("; ");
  }

  function candidateColor(party, index = 0) {
    if (/^Democratic/i.test(party || "")) return ["#0b4d78", "#1769aa"][index % 2];
    if (/^Republican/i.test(party || "")) return ["#972d29", "#c43d38"][index % 2];
    return ["#b57912", "#d29a32", "#7d689e"][index % 3];
  }

  function shortParty(party) {
    if (/^Democratic/i.test(party || "")) return "Democratic";
    if (/^Republican/i.test(party || "")) return "Republican";
    if (/Independent/i.test(party || "")) return "Independent";
    return party || "Other";
  }

  function district(title) {
    return Number(title.match(/District\s+(\d+)/i)?.[1] || 0);
  }

  function isTitle(contest, title) { return contest.title.toLowerCase() === title.toLowerCase(); }
  function validApiUrl(url) { return typeof url === "string" && /^https:\/\//.test(url) && !url.includes("YOUR-WORKER"); }
  function formatNumber(value) { return new Intl.NumberFormat("en-US").format(Number(value) || 0); }
  function formatPercent(value, whole = false) {
    const number = Number(value) || 0;
    return new Intl.NumberFormat("en-US", { minimumFractionDigits: whole ? 0 : 1, maximumFractionDigits: whole ? 1 : 1 }).format(number);
  }
  function formatTime(value) { return new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeStyle: "medium", timeZone: "America/New_York" }).format(new Date(value)); }
  function postHeight() {
    if (window.parent === window) return;
    window.parent.postMessage({ type: "spotlight-election-results-height", height: document.documentElement.scrollHeight }, "*");
  }
  function element(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== "") node.textContent = text;
    return node;
  }
})();
