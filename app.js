/* Bet Slip PWA: loads bets.json (bet definitions + server snapshot) and re-computes live
   progress straight from ESPN box scores every 60s (same rules as live_tracker.py). */
"use strict";
const REFRESH_MS = 60000;
const TZ = "America/Toronto";
const STATS = { // stat -> [box-score group or null, keys summed, word]
  sog: [null, ["shotsTotal"], "shots"], points: [null, ["goals", "assists"], "points"],
  goals: [null, ["goals"], "goals"], hits: ["batting", ["hits"], "hits"],
  hr: ["batting", ["homeRuns"], "home runs"], k: ["pitching", ["strikeouts"], "strikeouts"],
};
const TEAM_ALIAS = {LAK:"LA",SJS:"SJ",TBL:"TB",NJD:"NJ",CWS:"CHW",UTA:"UTAH",WAS:"WSH",AZ:"ARI",KCR:"KC",SDP:"SD",SFG:"SF",TBR:"TB"};
const NICK = {"Maple Leafs": "Leafs", "Golden Knights": "Knights", "Blue Jackets": "Jackets", "Red Wings": "Wings"};
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money = (x) => "$" + Number(x || 0).toFixed(2);
const etTime = (d) => new Intl.DateTimeFormat("en-US", {timeZone: TZ, hour: "numeric", minute: "2-digit"}).format(d) + " ET";
const espnTeam = (t) => TEAM_ALIAS[(t || "").toUpperCase()] || (t || "").toUpperCase();
const nick = (n) => NICK[n] || n;
const norm = (s) => (s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, "");
const lastNorm = (s) => {
  const p = (s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").split(/\s+/)
    .filter((x) => x && !["jr", "sr", "ii", "iii", "iv"].includes(x.toLowerCase().replace(/\./g, "")));
  return p.length ? norm(p[p.length - 1]) : "";
};

let DATA = null, LIVE = {}, lastLiveOk = null, busy = false;

async function getJSON(url) {
  const r = await fetch(url, {cache: "no-store"});
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
  for (const p of Object.values(people)) if (p.groups.pitching) p.pulled = lastP[p.team] !== norm(p.name);
  return {state, clock, away: t.away.team.abbreviation, home: t.home.team.abbreviation,
          away_score: t.away.score || "0", home_score: t.home.score || "0", people, sport};
}

function findPerson(g, player, team) {
  if (!g) return null;
  const ppl = g.people, n = norm(player);
  if (ppl[n]) return ppl[n];
  const ln = lastNorm(player);
  const c = Object.values(ppl).filter((p) => lastNorm(p.name) === ln && (!team || p.team === espnTeam(team)));
  return c.length === 1 ? c[0] : null;
}

function statValue(p, stat) {
  const [group, keys] = STATS[stat] || [null, ["shotsTotal"]];
  const grps = group ? (p.groups[group] ? [p.groups[group]] : []) : Object.values(p.groups);
  for (const g of grps) if (keys.every((k) => k in g)) return Math.round(keys.reduce((a, k) => a + g[k], 0));
  return 0;
}

function detail(p, stat, g) {
  const s = p.strs;
  if (stat === "points" && "goals" in s) return `${s.goals || 0}G ${s.assists || 0}A`;
  if ((stat === "hits" || stat === "hr") && s["hits-atBats"] && g.state !== "pre") return s["hits-atBats"] + " at bat";
  if (stat === "k" && g.state !== "pre") return `${s["fullInnings.partInnings"] || ""} IP` + (p.pulled ? " · pulled" : "");
  return "";
}

// Re-evaluate one leg against a live game; returns null to keep the server snapshot.
function evalLeg(leg, g) {
  if (!g) return null;
  const p = findPerson(g, leg.player, leg.sheet_team || leg.team);
  const val = p && (g.state === "in" || g.state === "post") ? statValue(p, leg.stat) : 0;
  let status;
  if (val >= leg.target) status = "HIT";
  else if (g.state === "post") status = p ? "MISS" : "VOID?";
  else if (g.state === "in") status = p ? "LIVE" : "NOT FOUND";
  else status = "PENDING";
  if (status === "LIVE" && leg.stat === "k" && p && p.pulled) status = "MISS"; // starter relieved: no more Ks
  let note = leg.note;
  if (g.state !== "pre") note = p ? detail(p, leg.stat, g) : (g.state === "post" ? "not in box score" : "not in box score yet");
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

function gameLine(key) {
  const g = gameInfo(key);
  const names = g.away_name ? `${esc(g.away_name)} @ ${esc(g.home_name)}` : esc(key.replace("@", " @ "));
  const start = g.start_utc ? etTime(new Date(g.start_utc)) : (g.start_et || "");
  let state = "";
  if (g.state === "in") state = ` · <span class="gc in">${esc(g.away_score)}-${esc(g.home_score)} ${esc(g.clock)}</span>`;
  else if (g.state === "post") state = ` · <span class="gc">${esc(g.away_score)}-${esc(g.home_score)} ${esc(g.clock)}</span>`;
  return `${names} · ${esc(start)}${state}`;
}

function legHTML(l) {
  const g = gameInfo(l.game);
  const tname = l.team === g.away ? g.away_name : l.team === g.home ? g.home_name : (l.team_name || l.team);
  const last = l.player.split(" ").slice(1).join(" ") || l.player;
  const word = (STATS[l.stat] || [0, 0, "shots"])[2];
  const cls = {"VOID?": "VOID", "NOT FOUND": "NF"}[l.status] || l.status;
  const pillTxt = {HIT: "HIT", LIVE: "LIVE", MISS: "LOST", PENDING: "UPCOMING", "VOID?": "VOID?", "NOT FOUND": "NOT FOUND"}[l.status];
  const frac = l.target ? Math.min(l.value / l.target, 1) : 1;
  let ticks = "";
  if (l.target > 1 && l.target <= 12) for (let k = 1; k < l.target; k++) ticks += `<s style="left:calc(${(100 * k) / l.target}% - 1px)"></s>`;
  const need = l.stat === "k" ? `over ${l.line ?? l.target - 0.5}` : l.stat === "goals" ? "to score" : l.stat === "hr" ? "to homer" : `needs ${l.target}+`;
  return `<div class="leg ${cls}">
    <div class="lrow"><div class="who">${esc(l.player)} <span class="tm">(${esc(nick(tname || l.team))})</span></div><span class="lpill">${pillTxt}</span></div>
    <div class="what"><span class="lbl">${esc(last)} ${esc(word)} <span class="muted">· ${esc(need)}</span></span><span class="num">${l.value}/${l.target}</span></div>
    <div class="bar"><i style="width:${(frac * 100).toFixed(1)}%"></i>${ticks}</div>
    <div class="game">${gameLine(l.game)}${l.note ? ` · <span class="note">${esc(l.note)}</span>` : ""}</div>
  </div>`;
}

function render() {
  if (!DATA) return;
  const bets = recompute();
  const order = {alive: 0, won: 0, lost: 1};
  const sorted = bets.map((b, i) => [b, i]).sort((a, b) => order[a[0].status] - order[b[0].status] || a[1] - b[1]).map((x) => x[0]);
  const staked = bets.reduce((a, b) => a + b.stake, 0), pot = bets.reduce((a, b) => a + b.payout, 0);
  const alive = bets.filter((b) => b.status === "alive"), won = bets.filter((b) => b.status === "won"), lost = bets.filter((b) => b.status === "lost");
  const stillLive = alive.concat(won).reduce((a, b) => a + b.payout, 0);
  $("#title").textContent = DATA.title && DATA.title !== "Bet Tracker" ? DATA.title : "Bet Slip";
  const day = DATA.date ? new Date(DATA.date + "T12:00:00Z").toLocaleDateString("en-US", {weekday: "short", month: "short", day: "numeric", timeZone: "UTC"}) : "";
  $("#summary").innerHTML = `
    <div class="stat"><div class="k">Staked</div><div class="v">${money(staked)}</div></div>
    <div class="stat"><div class="k">Potential</div><div class="v" style="color:var(--green)">${money(pot)}</div></div>
    <div class="stat"><div class="k">Still live</div><div class="v" style="color:var(--blue)">${money(stillLive)}</div></div>
    <div class="counts"><span>${esc(day)}</span><span><b>${bets.length}</b> bets</span><span><b style="color:var(--amber)">${alive.length}</b> alive</span><span><b style="color:var(--green)">${won.length}</b> won</span><span><b style="color:var(--red)">${lost.length}</b> lost</span></div>`;
  const upd = lastLiveOk && lastLiveOk > new Date(DATA.generated_at) ? lastLiveOk : new Date(DATA.generated_at);
  const stale = Date.now() - upd.getTime() > 5 * 60000;
  $("#updated").innerHTML = `<span class="dot${stale ? " stale" : ""}"></span>Updated ${etTime(upd)}${lastLiveOk ? " · live from ESPN" : ""} · auto-refresh 60s`;
  // games strip
  $("#games").innerHTML = Object.keys(DATA.games).map((k) => {
    const g = gameInfo(k);
    const start = g.start_utc ? etTime(new Date(g.start_utc)) : g.start_et || "";
    const sc = g.state === "in" || g.state === "post" ? `<span class="sc">${esc(g.away_score)}-${esc(g.home_score)}</span>` : " ";
    const cl = g.state === "pre" ? start : g.clock;
    return `<div class="gchip ${esc(g.state)}">${esc(g.away)} @ ${esc(g.home)}${sc}<span class="cl">${esc(cl)}</span></div>`;
  }).join("");
  $("#bets").innerHTML = sorted.map((b) => {
    const cls = b.status === "alive" && !b.anyStarted ? "pending" : b.status;
    const pill = {alive: b.anyStarted ? "ALIVE" : "ALIVE · NOT STARTED", won: "WON", lost: "LOST"}[b.status];
    return `<article class="card ${cls}">
      <div class="chead">
        <div class="crow"><div><div class="ctitle">${esc(b.title)}</div><div class="cid">${esc(b.book)} · ${b.n}-leg · ${esc(b.id)}</div></div><span class="pill">${pill}</span></div>
        <div class="money"><div>Stake<b>${money(b.stake)}</b></div><div>Odds<b>${esc(b.odds)}</b></div><div class="pay">Payout<b>${money(b.payout)}</b></div></div>
        <div class="legcounts"><span class="h">✓ ${b.hit} hit</span><span class="l">● ${b.live} live</span><span class="x">✗ ${b.lost} lost</span><span>${b.pending} to start</span></div>
      </div>
      ${b.legs.map(legHTML).join("")}
    </article>`;
  }).join("");
  const ex = (DATA.excluded || []).length ? "Not shown (not live bets): " + DATA.excluded.map(esc).join("; ") + "<br>" : "";
  $("#foot").innerHTML = `${ex}Stats: ESPN box scores. LOST = game over (or pitcher pulled) short of target. Informational only.<br>Data file generated ${esc(DATA.generated_et || "")}.`;
}

async function refresh() {
  if (busy) return; busy = true;
  $("#refresh").classList.add("spin");
  try {
    try { DATA = await getJSON("bets.json?t=" + Date.now()); }
    catch (e) { if (!DATA) throw e; }
    const keys = Object.keys(DATA.games);
    const res = await Promise.allSettled(keys.map(async (k) => {
      const g = DATA.games[k];
      if (!g.summary_url) throw new Error("no url");
      return [k, parseGame(await getJSON(g.summary_url + (g.summary_url.includes("?") ? "&" : "?") + "_=" + Date.now()), g.sport)];
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
refresh();
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
