(() => {
  "use strict";

  const API = "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard";
  const LIVE_REFRESH_MS = 15000;
  const IDLE_REFRESH_MS = 60000;
  const ODDS_CACHE_KEY = "nhl-pregame-odds-v1";

  const gamesEl = document.getElementById("games");
  const updatedEl = document.getElementById("updated");
  const dateLabelEl = document.getElementById("date-label");

  let selectedDate = startOfDay(new Date());
  let refreshTimer = null;
  // event id -> { seconds, syncedAt, running }
  const clocks = new Map();

  // ---------- helpers ----------

  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function ymd(d) {
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}${m}${day}`;
  }

  function isToday(d) {
    return ymd(d) === ymd(new Date());
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  function formatClock(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  function parseClock(display) {
    const m = /^(\d+):(\d{2})/.exec(display || "");
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  function periodLabel(period, detail) {
    if (!period) return "";
    if (period <= 3) return ["1st", "2nd", "3rd"][period - 1];
    if (/\bSO\b/i.test(detail || "")) return "SO";
    const ot = period - 3;
    return ot === 1 ? "OT" : `${ot}OT`;
  }

  function formatOdds(v) {
    if (v === null || v === undefined || v === "") return null;
    const s = String(v).trim();
    if (/^even$/i.test(s)) return "EVEN";
    const n = Number(s.replace(/^\+/, ""));
    if (!Number.isFinite(n)) return s;
    return n > 0 ? `+${n}` : String(n);
  }

  function formatTotal(v) {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(String(v).replace(/^[ou]/i, ""));
    return Number.isFinite(n) ? String(n) : null;
  }

  // ---------- pregame odds ----------
  // ESPN replaces or drops odds once a game starts, so lines seen while a game
  // is still "pre" are remembered locally and preferred afterwards.

  function loadOddsCache() {
    try {
      return JSON.parse(localStorage.getItem(ODDS_CACHE_KEY)) || {};
    } catch {
      return {};
    }
  }

  function saveOddsCache(cache) {
    try {
      // Keep only the last ~10 days of games.
      const cutoff = Date.now() - 10 * 864e5;
      for (const [id, v] of Object.entries(cache)) {
        if (!v.savedAt || v.savedAt < cutoff) delete cache[id];
      }
      localStorage.setItem(ODDS_CACHE_KEY, JSON.stringify(cache));
    } catch {
      /* storage unavailable: odds just won't persist */
    }
  }

  function extractOdds(competition, state) {
    const o = (competition.odds || [])[0];
    if (!o) return null;

    const ml = o.moneyline || {};
    const tot = o.total || {};
    const pick = (side, legacy) => {
      const close = ml[side]?.close?.odds;
      const open = ml[side]?.open?.odds;
      const current = legacy?.moneyLine;
      // Pregame: the current line is the pregame line.
      // In-game: "close" is the closing pregame line; the bare moneyLine may be live.
      return formatOdds(state === "pre" ? (close ?? current ?? open) : (close ?? open ?? current));
    };

    const odds = {
      home: pick("home", o.homeTeamOdds),
      away: pick("away", o.awayTeamOdds),
      total: formatTotal(
        state === "pre"
          ? (o.overUnder ?? tot.over?.close?.line ?? tot.over?.open?.line)
          : (tot.over?.close?.line ?? tot.over?.open?.line ?? o.overUnder)
      ),
      provider: o.provider?.name || null,
    };
    return odds.home || odds.away || odds.total ? odds : null;
  }

  // ---------- data ----------

  function toGame(event, oddsCache) {
    const comp = event.competitions?.[0] || {};
    const status = event.status || comp.status || {};
    const type = status.type || {};
    const state = type.state || "pre";

    const side = (homeAway) => {
      const c = (comp.competitors || []).find((x) => x.homeAway === homeAway) || {};
      const t = c.team || {};
      return {
        abbr: t.abbreviation || "",
        name: t.shortDisplayName || t.displayName || t.abbreviation || "TBD",
        logo: t.logo || "",
        score: c.score ?? "",
        record: (c.records || [])[0]?.summary || "",
        winner: !!c.winner,
      };
    };

    let odds = extractOdds(comp, state);
    if (state === "pre" && odds) {
      oddsCache[event.id] = { ...odds, savedAt: Date.now() };
    } else if (oddsCache[event.id]) {
      odds = oddsCache[event.id];
    }

    const clockSeconds = typeof status.clock === "number" ? status.clock : parseClock(status.displayClock);

    return {
      id: event.id,
      date: new Date(event.date),
      state,
      statusName: type.name || "",
      detail: type.shortDetail || type.detail || "",
      period: status.period || 0,
      clockSeconds,
      home: side("home"),
      away: side("away"),
      odds,
      tv: (comp.broadcasts || []).flatMap((b) => b.names || []).join(", "),
    };
  }

  async function fetchGames(date) {
    const res = await fetch(`${API}?dates=${ymd(date)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
    const data = await res.json();
    const cache = loadOddsCache();
    const games = (data.events || []).map((e) => toGame(e, cache));
    saveOddsCache(cache);
    const order = { in: 0, pre: 1, post: 2 };
    games.sort((a, b) => (order[a.state] - order[b.state]) || (a.date - b.date));
    return games;
  }

  // ---------- rendering ----------

  function clockRunning(g) {
    return g.state === "in" && g.statusName === "STATUS_IN_PROGRESS" && g.clockSeconds > 0;
  }

  function statusHtml(g) {
    if (g.state === "pre") {
      if (g.statusName === "STATUS_POSTPONED" || g.statusName === "STATUS_CANCELED") {
        return `<span class="state">${escapeHtml(g.detail)}</span>`;
      }
      const t = g.date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      return `<span class="state">${escapeHtml(t)}</span>`;
    }
    if (g.state === "post") {
      return `<span class="state">${escapeHtml(g.detail || "Final")}</span>`;
    }
    const per = periodLabel(g.period, g.detail);
    if (g.statusName === "STATUS_IN_PROGRESS" && g.clockSeconds !== null && per !== "SO") {
      return `<span class="state live"><span class="clock" data-clock="${escapeHtml(g.id)}">${formatClock(currentSeconds(g.id, g.clockSeconds))}</span> · ${per}</span>`;
    }
    // Intermission, end of period, shootout, delays, etc.
    return `<span class="state live">${escapeHtml(g.detail || per)}</span>`;
  }

  function teamRow(t, ml, g) {
    const showScore = g.state !== "pre";
    const loser = g.state === "post" && !t.winner;
    const logo = t.logo
      ? `<img src="${escapeHtml(t.logo)}" alt="" loading="lazy">`
      : `<span></span>`;
    return `
      <div class="team${loser ? " loser" : ""}">
        ${logo}
        <span class="name">${escapeHtml(t.name)}<span class="record">${escapeHtml(t.record)}</span></span>
        <span class="ml" title="Pregame moneyline">${escapeHtml(ml || "—")}</span>
        <span class="score">${showScore ? escapeHtml(t.score) : ""}</span>
      </div>`;
  }

  function cardHtml(g) {
    const o = g.odds || {};
    const total = o.total ? `O/U <strong>${escapeHtml(o.total)}</strong>` : "O/U <strong>—</strong>";
    const provider = o.provider ? ` <span>(${escapeHtml(o.provider)})</span>` : "";
    return `
      <article class="card${g.state === "in" ? " live" : ""}">
        <div class="card-head">
          ${statusHtml(g)}
          <span>${escapeHtml(g.tv)}</span>
        </div>
        <div class="teams">
          ${teamRow(g.away, o.away, g)}
          ${teamRow(g.home, o.home, g)}
        </div>
        <div class="card-foot">
          <span>${total}${provider}</span>
          <span>${g.state === "pre" ? "Pregame line" : "Closing pregame line"}</span>
        </div>
      </article>`;
  }

  function render(games) {
    if (!games.length) {
      gamesEl.innerHTML = `<p class="empty">No NHL games scheduled for this day.</p>`;
      return;
    }
    gamesEl.innerHTML = games.map(cardHtml).join("");
  }

  // ---------- running clock ----------

  function syncClocks(games) {
    const now = Date.now();
    clocks.clear();
    for (const g of games) {
      if (g.state === "in" && g.clockSeconds !== null) {
        clocks.set(g.id, { seconds: g.clockSeconds, syncedAt: now, running: clockRunning(g) });
      }
    }
  }

  function currentSeconds(id, fallback) {
    const c = clocks.get(id);
    if (!c) return fallback;
    if (!c.running) return c.seconds;
    return Math.max(0, c.seconds - (Date.now() - c.syncedAt) / 1000);
  }

  function tickClocks() {
    for (const el of gamesEl.querySelectorAll("[data-clock]")) {
      const id = el.getAttribute("data-clock");
      const c = clocks.get(id);
      if (c && c.running) el.textContent = formatClock(currentSeconds(id, c.seconds));
    }
  }

  // ---------- refresh loop ----------

  function updateDateLabel() {
    dateLabelEl.textContent = isToday(selectedDate)
      ? "Today"
      : selectedDate.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  }

  async function refresh() {
    clearTimeout(refreshTimer);
    const requested = ymd(selectedDate);
    let delay = IDLE_REFRESH_MS;
    try {
      const games = await fetchGames(selectedDate);
      if (requested !== ymd(selectedDate)) return; // user changed day mid-request
      syncClocks(games);
      render(games);
      const soon = Date.now() + 30 * 60000;
      if (games.some((g) => g.state === "in" || (g.state === "pre" && g.date.getTime() < soon))) {
        delay = LIVE_REFRESH_MS;
      }
      updatedEl.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`;
    } catch (err) {
      if (requested !== ymd(selectedDate)) return;
      if (!gamesEl.querySelector(".card")) {
        gamesEl.innerHTML = `<p class="error">Couldn't load scores: ${escapeHtml(err.message)}</p>`;
      }
      updatedEl.textContent = "Update failed — retrying";
      delay = LIVE_REFRESH_MS;
    }
    refreshTimer = setTimeout(refresh, delay);
  }

  function changeDay(offset) {
    selectedDate = offset === 0
      ? startOfDay(new Date())
      : new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate() + offset);
    updateDateLabel();
    clocks.clear();
    gamesEl.innerHTML = "";
    updatedEl.textContent = "Loading…";
    refresh();
  }

  document.getElementById("prev").addEventListener("click", () => changeDay(-1));
  document.getElementById("next").addEventListener("click", () => changeDay(1));
  document.getElementById("today").addEventListener("click", () => changeDay(0));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });

  setInterval(tickClocks, 1000);
  updateDateLabel();
  refresh();
})();
