/* Bet Slip PWA: loads bets.json (bet definitions + server snapshot) and re-computes live
  progress every 30s from ESPN box scores (soccer: FotMob player stats first, ESPN fallback). */
"use strict";
const REFRESH_MS = 30000;
const TZ = "America/Toronto";
const STATS = { // stat -> [box-score group or null, keys summed, word]
  sog: [null, ["shotsTotal"], "shots"], saves: ["goalies", ["saves"], "saves"], receptions: ["receiving", ["receptions"], "receptions"], pass_tds: ["passing", ["passingTouchdowns"], "passing TDs"], points: [null, ["goals", "assists"], "points"],
  goals: [null, ["goals"], "goals"], hits: ["batting", ["hits"], "hits"],
  hr: ["batting", ["homeRuns"], "home runs"], k: ["pitching", ["strikeouts"], "strikeouts"],
  rush_yds: ["rushing", ["rushingYards"], "rush yds"], rec_yds: ["receiving", ["receivingYards"], "rec yds"],
  rush_rec_yds: ["multi", [], "rush+rec yds"], anytime_td: ["multi", [], "TDs"],
};
// NFL stats summed across ESPN box-score groups (rushing / receiving are separate groups)
const MULTI = {rush_rec_yds: [["rushing", "rushingYards"], ["receiving", "receivingYards"]],
  anytime_td: [["rushing", "rushingTouchdowns"], ["receiving", "receivingTouchdowns"], ["kickReturns", "kickReturnTouchdowns"], ["puntReturns", "puntReturnTouchdowns"]]};
// Soccer player props: FotMob matchDetails is primary (has tackles); ESPN rosters are the fallback.
const SOCCER = { // stat -> [FotMob playerStats key, ESPN roster stat key or null]
  shots: ["total_shots", "totalShots"], sot: ["ShotsOnTarget", "shotsOnTarget"],
  tackles: ["matchstats.headers.tackles", null], fouls_won: ["was_fouled", "foulsSuffered"],
  fouls_committed: ["fouls", "foulsCommitted"], goals: ["goals", "totalGoals"], assists: ["assists", "goalAssists"],
};
const FM_API = "https://www.fotmob.com/api/data/";
const TEAM_ALIAS = {LAK:"LA",SJS:"SJ",TBL:"TB",NJD:"NJ",CWS:"CHW",UTA:"UTAH",WAS:"WSH",AZ:"ARI",KCR:"KC",SDP:"SD",SFG:"SF",TBR:"TB"};
const NICK = {"Maple Leafs": "Leafs", "Golden Knights": "Knights", "Blue Jackets": "Jackets", "Red Wings": "Wings"};
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money = (x) => "$" + Number(x || 0).toFixed(2);
const wholeMoney = (x) => "$" + Number(x || 0).toFixed(0);
const etTime = (d) => new Intl.DateTimeFormat("en-US", {timeZone: TZ, hour: "numeric", minute: "2-digit"}).format(d) + " ET";
const espnTeam = (t) => TEAM_ALIAS[(t || "").toUpperCase()] || (t || "").toUpperCase();
const nick = (n) => NICK[n] || n;
const FOLD = {"ı": "i", "ł": "l", "Ł": "L", "ø": "o", "Ø": "O", "đ": "d", "Đ": "D", "ß": "ss", "æ": "ae"};
const fold = (s) => (s || "").replace(/[ıłŁøØđĐßæ]/g, (c) => FOLD[c]);
const norm = (s) => fold(s).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, "");
const lastNorm = (s) => {
  const p = fold(s).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").split(/\s+/)
    .filter((x) => x && !["jr", "sr", "ii", "iii", "iv"].includes(x.toLowerCase().replace(/\./g, "")));
  return p.length ? norm(p[p.length - 1]) : "";
};

let DATA = null, LIVE = {}, lastLiveOk = null, busy = false;
const isoET = () => new Intl.DateTimeFormat("en-CA", {timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date());
let viewDate = isoET(), DAY_INDEX = [];
const dateLabel = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", {weekday: "short", month: "short", day: "numeric", timeZone: "UTC"});
const shiftDate = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const emptyData = (d) => ({version: 1, date: d, title: "Bet Tracker", generated_at: new Date().toISOString(), generated_et: etTime(new Date()), summary: {bets: 0, staked: 0, potential_payout: 0, live_payout: 0, alive: 0, won: 0, lost: 0}, games: {}, bets: [], excluded: []});
function renderDayNav() { const el = $("#daynav"); if (!el) return; el.innerHTML = `<button data-day-shift="-1" aria-label="Previous day">‹</button><span class="daylabel">${esc(dateLabel(viewDate))}</span><button data-day-shift="1" aria-label="Next day">›</button><button data-day-today="1">Today</button>`; }

async function getJSON(url, ms = 15000) {
  const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  const t = ac && setTimeout(() => ac.abort(), ms);
  let r;
  try { r = await fetch(url, ac ? {cache: "no-store", signal: ac.signal} : {cache: "no-store"}); }
  finally { if (t) clearTimeout(t); }
  if (!r.ok) throw new Error(r.status + " " + url);
  return r.json();
}

function parseGame(d, sport) {
  const comp = d.header.competitions[0], st = comp.status, state = st.type.state;
  const detail = st.type.shortDetail || "";
  let clock;
  if (state === "pre") { const m = detail.match(/(\d{1,2}:\d{2}\s*[AP]M)/); clock = m ? m[1] + " ET" : detail; }
  else if (state === "post") clock = detail;
  else clock = detail.replace(" - ", " ");
  const t = {}; comp.competitors.forEach((c) => (t[c.homeAway] = c));
  const people = {}, lastP = {};
  for (const tm of (d.boxscore && d.boxscore.players) || []) {
    const tab = tm.team.abbreviation;
    for (const s of tm.statistics || []) {
      const keys = s.keys || [], gname = s.type || s.name || "", aths = s.athletes || [];
      if (gname === "pitching" && aths.length) lastP[tab] = norm(aths[aths.length - 1].athlete.displayName);
      for (const a of aths) {
        const nm = a.athlete.displayName, k = norm(nm);
        const p = people[k] || (people[k] = {name: nm, team: tab, groups: {}, strs: {}});
        const vals = a.stats || [], g = {};
        keys.forEach((kk, i) => { g[kk] = parseFloat(vals[i]) || 0; if (i < vals.length) p.strs[kk] = vals[i]; });
        p.groups[gname] = g;
      }
    }
  }
  for (const r of d.rosters || []) { // soccer: ESPN puts player stats in rosters, not boxscore.players
    const tab = r.team && r.team.abbreviation;
    for (const a of r.roster || []) {
      if (!a.athlete) continue;
      const nm = a.athlete.displayName, g = {};
      for (const x of a.stats || []) g[x.name] = Number(x.value) || 0;
      people[norm(nm)] = {name: nm, team: tab, groups: {espn: g}, strs: {}, played: !!(a.starter || a.subbedIn)};
    }
  }
  for (const p of Object.values(people)) if (p.groups.pitching) p.pulled = lastP[p.team] !== norm(p.name);
  return {state, clock, away: t.away.team.abbreviation, home: t.home.team.abbreviation,
          away_score: t.away.score || "0", home_score: t.home.score || "0", people, sport};
}

const toks = (s) => fold(s).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^a-z]+/).filter(Boolean);
function findIn(ppl, player, team) {
  if (!ppl) return null;
  const n = norm(player);
  if (ppl[n]) return ppl[n];
  const want = toks(player), all = Object.values(ppl);
  const sub = all.filter((p) => { const have = toks(p.name); return want.every((t) => have.includes(t)); });
  if (sub.length === 1) return sub[0];
  const ln = lastNorm(player);
  const c = all.filter((p) => lastNorm(p.name) === ln && (!team || !p.team || p.team === espnTeam(team)));
  return c.length === 1 ? c[0] : null;
}

function findPerson(g, player, team) {
  if (!g) return null;
  if (g.sport === "soccer") return findIn(g.people, player, team);
  const ppl = g.people, n = norm(player);
  if (ppl[n]) return ppl[n];
  const ln = lastNorm(player);
  const c = Object.values(ppl).filter((p) => lastNorm(p.name) === ln && (!team || p.team === espnTeam(team)));
  return c.length === 1 ? c[0] : null;
}

function statValue(p, stat) {
  if (MULTI[stat]) return Math.round(MULTI[stat].reduce((a, [g, k]) => a + ((p.groups[g] || {})[k] || 0), 0));
  const [group, keys] = STATS[stat] || [null, ["shotsTotal"]];
  const grps = group ? (p.groups[group] ? [p.groups[group]] : []) : Object.values(p.groups);
  for (const g of grps) if (keys.every((k) => k in g)) return Math.round(keys.reduce((a, k) => a + g[k], 0));
  return 0;
}

function detail(p, stat, g) {
  const s = p.strs;
  if (stat === "points" && "goals" in s) return `${s.goals || 0}G ${s.assists || 0}A`;
  if ((stat === "hits" || stat === "hr") && s["hits-atBats"] && g.state !== "pre") return s["hits-atBats"] + " at bat";
  if ((stat === "rush_yds" || stat === "rush_rec_yds" || stat === "anytime_td") && g.state !== "pre") { const r = p.groups.rushing || {}, c = p.groups.receiving || {}; return `${r.rushingAttempts || 0} car ${r.rushingYards || 0} yds, ${c.receptions || 0} rec ${c.receivingYards || 0} yds`; }
  if (stat === "k" && g.state !== "pre") return `${s["fullInnings.partInnings"] || ""} IP` + (p.pulled ? " · pulled" : "");
  return "";
}

// Re-evaluate one leg against a live game; returns null to keep the server snapshot.
function evalSoccer(leg, g) {
  const [fk, ek] = SOCCER[leg.stat] || [null, null];
  const team = leg.sheet_team || leg.team;
  const fp = g.fm ? findIn(g.fm.people, leg.player, team) : null;
  const ep = findIn(g.people, leg.player, team);
  const started = g.state === "in" || g.state === "post";
  let val = null, src = "";
  if (fp && fk) { val = Number(fp.stats[fk]) || 0; src = "FotMob"; }
  else if (ep && ek) { val = Math.round(ep.groups.espn[ek] || 0); src = "ESPN"; }
  const found = !!(fp || ep);
  let status, note = "";
  if (!started) { status = "PENDING"; val = val || 0; }
  else if (val === null) {
    status = g.state === "post" ? "VOID?" : "LIVE";
    note = !found ? "not in lineup data yet" : "n/a live";
  } else if (val >= leg.target) status = "HIT";
  else if (g.state === "post") status = (ep && ep.played === false && !fp) ? "VOID?" : "MISS";
  else status = "LIVE";
  if (started && val !== null && found && ep && ep.played === false && !fp) note = "on bench";
  return {...leg, value: val === null ? "n/a" : val, status, note, src, team: ep ? ep.team : leg.team};
}

function evalLeg(leg, g) {
  if (!g) return null;
  if (g.sport === "soccer" || SOCCER[leg.stat] && !STATS[leg.stat]) return evalSoccer(leg, g);
  const p = findPerson(g, leg.player, leg.sheet_team || leg.team);
  const val = p && (g.state === "in" || g.state === "post") ? statValue(p, leg.stat) : 0;
  let status;
  if (val >= leg.target) status = "HIT";
  else if (g.state === "post") status = p ? "MISS" : "VOID?";
  else if (g.state === "in") status = p ? "LIVE" : "NOT FOUND";
  else status = "PENDING";
  if (status === "LIVE" && leg.stat === "k" && p && p.pulled) status = "MISS"; // starter relieved: no more Ks
  const noBox = !Object.keys(g.people).length;
  if (status === "NOT FOUND" && (noBox || g.sport === "nfl")) status = "PENDING"; // early NFL box score may omit offensive stats
  let note = leg.note;
  if (g.state !== "pre") note = p ? detail(p, leg.stat, g) : noBox ? "box score not posted yet" : (g.state === "post" ? "not in box score" : "not in box score yet");
  return {...leg, value: val, status, note, team: p ? p.team : leg.team};
}

function recompute() {
  const bets = DATA.bets.map((b) => {
    const legs = b.legs.map((l) => evalLeg(l, LIVE[l.game]) || l);
    const sts = legs.map((l) => l.status);
    const hit = sts.filter((s) => s === "HIT").length, live = sts.filter((s) => s === "LIVE").length,
          lost = sts.filter((s) => s === "MISS").length;
    let status;
    if (lost) status = "lost";
    else if (sts.every((s) => s === "HIT" || s === "VOID?")) status = "won";
    else status = "alive";
    return {...b, legs, hit, live, lost, pending: legs.length - hit - live - lost, status,
            anyStarted: sts.some((s) => s !== "PENDING")};
  });
  return bets;
}

function gameInfo(key) {
  const s = DATA.games[key] || {}, l = LIVE[key] || {};
  return {...s, ...Object.fromEntries(Object.entries(l).filter(([k]) => k !== "people"))};
}

const ABBR = {shots: "SHOTS", sot: "SOT", tackles: "TACKLES", fouls_won: "FOULS WON", fouls_committed: "FOULS", assists: "AST", sog: "SOG", receptions: "REC", pass_tds: "TD", rush_yds: "RUSH YDS", rec_yds: "REC YDS", rush_rec_yds: "R+R YDS", anytime_td: "ANY TD", points: "PTS", goals: "G", hits: "H", hr: "HR", k: "K"};
const COLLAPSE_KEY = "betslip-collapsed";
let collapsed = {};
try { collapsed = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "{}"); } catch (e) { collapsed = {}; }
const params = new URLSearchParams(location.search);
const focusId = params.get("focus");

function startET(g) { return g.start_utc ? etTime(new Date(g.start_utc)) : (g.start_et || ""); }

function gameHead(key) {
  const g = gameInfo(key);
  const names = g.away_name ? `${nick(g.away_name)} @ ${nick(g.home_name)}` : key.replace("@", " @ ");
  let st = "";
  if (g.state === "in") st = `<span class="s in">${esc(g.away_score)}-${esc(g.home_score)} · ${esc(g.clock)}</span>`;
  else if (g.state === "post") st = `<span class="s">${esc(g.away_score)}-${esc(g.home_score)} · ${esc(g.clock)}</span>`;
  else st = `<span class="s">not started</span>`;
  return `<div class="ghead"><span class="m">${esc(names)}</span><span class="t">${esc(startET(g))}</span>${st}</div>`;
}

function legHTML(l) {
  const cls = {"VOID?": "VOID", "NOT FOUND": "NF"}[l.status] || l.status;
  const na = typeof l.value !== "number";
  const frac = na ? 0 : l.target ? Math.min(l.value / l.target, 1) : 1;
  const stat = l.stat === "k" ? `K o${l.line ?? l.target - 0.5}` : (ABBR[l.stat] || String(l.stat || "SOG").toUpperCase());
  const tm = espnTeam(l.team || l.sheet_team);
  const note = l.note && !["on roster", "in lineup"].includes(l.note) ? `<span class="nt">${esc(l.note)}</span>` : "";
  const title = `${l.player} (${tm}) ${stat} ${l.value}/${l.target} ${l.status}`;
  return `<div class="leg ${cls}" title="${esc(title)}"><span class="dot"></span>` +
    `<span class="nm">${esc(l.player)} <span class="tm">(${esc(tm)})</span><span class="st">${esc(stat)}</span>${note}</span>` +
    `<span class="v">${na ? "–" : l.value}<span class="tg">/${l.target}</span></span>` +
    `<span class="bar"><i style="width:${(frac * 100).toFixed(1)}%"></i></span></div>`;
}

function isCollapsed(b) {
  if (focusId && b.id === focusId) return false;
  return b.id in collapsed ? collapsed[b.id] : b.status !== "alive"; // live/alive bets open by default
}

function render() {
  if (!DATA) return;
  renderDayNav();
  const bets = recompute();
  const order = {alive: 0, won: 0, lost: 1};
  const pin = (b) => (focusId && b.id === focusId ? 0 : 1); // ?focus=Row%2088 pins that bet to the top
  const sorted = bets.map((b, i) => [b, i]).sort((a, b) => pin(a[0]) - pin(b[0]) || order[a[0].status] - order[b[0].status] || a[1] - b[1]).map((x) => x[0]);
  const staked = bets.reduce((a, b) => a + b.stake, 0), pot = bets.reduce((a, b) => a + b.payout, 0);
  const alive = bets.filter((b) => b.status === "alive"), won = bets.filter((b) => b.status === "won"), lost = bets.filter((b) => b.status === "lost");
  const stillLive = alive.concat(won).reduce((a, b) => a + b.payout, 0);
  $("#title").textContent = DATA.title && DATA.title !== "Bet Tracker" ? DATA.title : "Bet Slip";
  const day = DATA.date ? new Date(DATA.date + "T12:00:00Z").toLocaleDateString("en-US", {weekday: "short", month: "short", day: "numeric", timeZone: "UTC"}) : "";
  $("#summary").innerHTML = `<div class="summary">
    <div class="stat"><div class="k">Staked</div><div class="v">${money(staked)}</div></div>
    <div class="stat"><div class="k">Potential</div><div class="v" style="color:var(--green)">${money(pot)}</div></div>
    <div class="stat"><div class="k">Still live</div><div class="v" style="color:var(--blue)">${money(stillLive)}</div></div></div>
    <div class="counts"><span>${esc(day)}</span><span><b>${bets.length}</b> bets</span><span><b style="color:var(--amber)">${alive.length}</b> alive</span><span><b style="color:var(--green)">${won.length}</b> won</span><span><b style="color:var(--red)">${lost.length}</b> lost</span></div>`;
  const upd = lastLiveOk && lastLiveOk > new Date(DATA.generated_at) ? lastLiveOk : new Date(DATA.generated_at);
  const stale = Date.now() - upd.getTime() > 5 * 60000;
  $("#updated").innerHTML = `<span class="dot${stale ? " stale" : ""}"></span>${etTime(upd)}${lastLiveOk ? " · live" : ""}`;
  $("#games").innerHTML = Object.keys(DATA.games).map((k) => {
    const g = gameInfo(k);
    const sc = g.state === "in" || g.state === "post" ? `<span class="sc">${esc(g.away_score)}-${esc(g.home_score)}</span>` : " ";
    const cl = g.state === "pre" ? startET(g) : g.clock;
    return `<div class="gchip ${esc(g.state)}">${esc(g.away)} @ ${esc(g.home)}${sc}<span class="cl">${esc(cl)}</span></div>`;
  }).join("");
  $("#bets").innerHTML = sorted.length ? sorted.map((b) => {
    const cls = b.status === "alive" && !b.anyStarted ? "pending" : b.status;
    const pill = {alive: b.anyStarted ? "ALIVE" : "NOT STARTED", won: "WON", lost: "LOST"}[b.status];
    const games = [...new Set(b.legs.map((l) => l.game))];
    const body = games.map((gk) => gameHead(gk) + b.legs.filter((l) => l.game === gk).map(legHTML).join("")).join("");
    const bonus = b.bonus || Number(b.bonus_stake || 0) > 0;
    const payChip = bonus ? `<span class="chip pay bonus-pay"><b>${wholeMoney(b.bonus_stake || b.stake)}</b> → <b>${money(b.payout)}</b></span>` : `<span class="chip pay">${money(b.stake)} → <b>${money(b.payout)}</b></span>`;
    return `<article class="card ${cls}${isCollapsed(b) ? " collapsed" : ""}" id="${esc(b.id.replace(/\s+/g, "-"))}" data-id="${esc(b.id)}">
      <button class="chead" aria-expanded="${!isCollapsed(b)}">
        <div class="crow"><span class="chev">▼</span><span class="ctitle">${esc(b.title)}</span><span class="pill">${pill}</span></div>
        <div class="chips"><span class="chip"><span class="h"><b>✓${b.hit}</b></span> <span class="l"><b>●${b.live}</b></span> <span class="x"><b>✗${b.lost}</b></span>${b.pending ? ` · ${b.pending} to go` : ""}</span><span class="chip"><b>${esc(b.odds)}</b></span>${payChip}</div>
      </button>
      <div class="legs">${body}</div>
    </article>`;
  }).join("") : `<div class="empty">No bets this day</div>`;
  const ex = (DATA.excluded || []).length ? "Not shown (not live bets): " + DATA.excluded.map(esc).join("; ") + "<br>" : "";
  $("#foot").innerHTML = `<div class="legend"><span style="--c:var(--green)">hit</span><span style="--c:var(--amber)">live</span><span style="--c:var(--red)">lost</span><span style="--c:var(--grey)">not started</span></div>${ex}${esc(DATA.bets[0] && DATA.bets[0].book || "FanDuel")} · stats from ${Object.values(DATA.games).some((g) => g.sport === "soccer") ? "FotMob (primary) + ESPN" : "ESPN box scores"}. LOST = game over (or pitcher pulled) short of target. Tap a bet to collapse/expand.<br>Data file generated ${esc(DATA.generated_et || "")}.`;
  document.documentElement.style.setProperty("--hdr", $("header").offsetHeight + "px");
}

document.addEventListener("click", (e) => {
  const shift = e.target.closest("[data-day-shift]");
  if (shift) { viewDate = shiftDate(viewDate, Number(shift.dataset.dayShift)); LIVE = {}; refresh(); return; }
  const todayBtn = e.target.closest("[data-day-today]");
  if (todayBtn) { viewDate = isoET(); LIVE = {}; refresh(); return; }
  const h = e.target.closest(".chead");
  if (!h) return;
  const card = h.closest(".card"), id = card.dataset.id;
  const now = !card.classList.contains("collapsed");
  card.classList.toggle("collapsed", now);
  h.setAttribute("aria-expanded", String(!now));
  collapsed[id] = now;
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed)); } catch (err) { /* private mode */ }
});

// FotMob (CORS-open JSON). Match id comes from bets.json (fotmob_id) or is looked up by date + team names.
const FM_IDS = {};
async function fotmobId(k, g) {
  if (g.fotmob_id) return g.fotmob_id;
  if (FM_IDS[k]) return FM_IDS[k];
  const day = (g.start_utc ? new Date(g.start_utc) : new Date());
  const ymd = new Intl.DateTimeFormat("en-CA", {timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"}).format(day).replace(/-/g, "");
  const d = await getJSON(`${FM_API}matches?date=${ymd}&timezone=${encodeURIComponent(TZ)}`);
  const hn = norm(g.home_full || g.home_name), an = norm(g.away_full || g.away_name);
  const same = (a, b) => a && b && (a === b || a.startsWith(b) || b.startsWith(a) || (a.slice(0, 4) === b.slice(0, 4)));
  for (const lg of d.leagues || []) for (const m of lg.matches || [])
    if (same(norm(m.home.name), hn) && same(norm(m.away.name), an)) return (FM_IDS[k] = m.id);
  throw new Error("fotmob match not found");
}

async function fotmobGame(k, g) {
  const id = await fotmobId(k, g);
  const d = await getJSON(`${FM_API}matchDetails?matchId=${id}&_=${Date.now()}`);
  const people = {};
  for (const p of Object.values((d.content && d.content.playerStats) || {})) {
    const st = {};
    for (const sec of p.stats || []) for (const v of Object.values(sec.stats || {})) if (v.key && v.stat) st[v.key] = v.stat.value;
    people[norm(p.name)] = {name: p.name, team: null, stats: st};
  }
  const h = d.header || {}, s = h.status || {}, tm = h.teams || [];
  const state = s.finished ? "post" : s.started ? "in" : "pre";
  const lt = ((s.liveTime && s.liveTime.short) || "").replace(/[\u200e\u200f]/g, "");
  const head = {state, clock: state === "post" ? "FT" : state === "in" ? lt : (g.start_et || ""),
    home_score: String(tm[0] ? tm[0].score ?? 0 : 0), away_score: String(tm[1] ? tm[1].score ?? 0 : 0)};
  return {id, people, head};
}

async function refresh() {
  if (busy) return; busy = true;
  $("#refresh").classList.add("spin");
  try {
    const today = isoET();
    const dataURL = viewDate === today ? "bets.json?t=" + Date.now() : `days/${viewDate}.json?t=${Date.now()}`;
    try { DATA = await getJSON(dataURL); }
    catch (e) { if (viewDate === today && DATA) { /* keep last current-day data */ } else { DATA = emptyData(viewDate); LIVE = {}; render(); return; } }
    const openDay = DATA.bets.some((b) => b.status === "alive" || b.raw_status === "LIVE" || b.raw_status === "PENDING");
    if (viewDate !== today && !openDay) { LIVE = {}; render(); return; }
    const keys = Object.keys(DATA.games);
    const res = await Promise.allSettled(keys.map(async (k) => {
      const g = DATA.games[k];
      const [es, fm] = await Promise.allSettled([
        g.summary_url ? getJSON(g.summary_url + (g.summary_url.includes("?") ? "&" : "?") + "_=" + Date.now()).then((d) => parseGame(d, g.sport)) : Promise.reject(new Error("no url")),
        g.sport === "soccer" ? fotmobGame(k, g) : Promise.reject(new Error("n/a")),
      ]);
      if (es.status !== "fulfilled" && fm.status !== "fulfilled") throw es.reason;
      const out = es.status === "fulfilled" ? es.value : {...fm.value.head, people: {}, sport: g.sport};
      if (fm.status === "fulfilled") { out.fm = fm.value; if (!out.state || out.state === "pre") Object.assign(out, fm.value.head); }
      else if (LIVE[k] && LIVE[k].fm) out.fm = LIVE[k].fm; // keep last good FotMob data on a blip
      return [k, out];
    }));
    let ok = 0;
    for (const r of res) if (r.status === "fulfilled") { LIVE[r.value[0]] = r.value[1]; ok++; }
    if (ok) lastLiveOk = new Date();
    render();
  } catch (e) {
    $("#bets").innerHTML = `<div class="err">Couldn't load bets: ${esc(e.message)}</div>` + $("#bets").innerHTML;
  } finally { busy = false; $("#refresh").classList.remove("spin"); }
}

$("#refresh").addEventListener("click", refresh);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
getJSON("days/index.json").then((d) => { DAY_INDEX = d.dates || []; }).catch(() => {});
refresh();
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));