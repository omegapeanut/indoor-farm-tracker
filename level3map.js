// ============================================================================
// Level 3 — tray map. Every tray on the two racks is a square you tap.
//   North rack and South rack, 6 tiers each, 13 trays per tier (positions 1-13).
//   Each tier grows ONE crop, so the tier tells you the crop; plants per tray are
//   120 (Ice Plant 80). All data lives in one Firestore doc, meta/level3Map:
//     { trays: { "N2-7": { date, ready, readyDate, type: "new"|"old" } },
//       history: [ { k, crop, plants, date, readyDate, type, exitType, exitDate, note } ] }
//   A key is rack + tier + "-" + position, e.g. "N2-7" = North rack, tier 2, tray 7.
// ============================================================================
import { getApps, getApp, initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { getFirestore, doc, onSnapshot, setDoc, getDoc } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const app = getApps().length ? getApp() : initializeApp(window.FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);
const REF = doc(db, "meta", "level3Map");
const root = document.getElementById("level3LogRoot");

const POSMAX = 13;
const posOf = (r) => (r === "N" ? 11 : 13);   // North rack 11 trays per tier, South rack 13
const TIERS = [6, 5, 4, 3, 2, 1];
const RACKS = [
  { id: "N", name: "North rack", tiers: { 1: "Ice Plant", 2: "Ice Plant", 3: "Garland Chrysanthemum", 4: "Red Coral Lettuce", 5: "Crystal Green Lettuce", 6: "Mini Red Romaine Lettuce" } },
  { id: "S", name: "South rack", tiers: { 1: "Perilla", 2: "Mustard", 3: "Sorrel", 4: "Mizuna", 5: "Swiss Chard", 6: "Kale" } }
];
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const CUT = "2026-10-01";
const TOTAL = TIERS.length * (11 + 13);

const cropAt = (r, t) => RACKS.find(x => x.id === r).tiers[t];
const ppt = (crop) => (crop === "Ice Plant" ? 80 : 120);
const isSalted = (r, t) => r === "N" && (t === 1 || t === 2);
const keyOf = (r, t, p) => r + t + "-" + p;
function parseKey(k){ const m = /^([NS])(\d)-(\d+)$/.exec(k); return m ? { r: m[1], t: +m[2], p: +m[3] } : null; }
const cropOfKey = (k) => { const q = parseKey(k); return q ? cropAt(q.r, q.t) : ""; };

let state = { trays: {}, history: [] };
let multi = false;
let loaded = false, isAdmin = false, loadError = "", showHistory = false, showDates = true, last = null;
const sel = new Set();

function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function toDate(s){ const p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
function toKey(d){ return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0"); }
function today(){ const d = new Date(); if (d.getHours() < 7) d.setDate(d.getDate() - 1); return toKey(d); }
function fmtShort(key){ if (!key) return ""; const d = toDate(key); return d.getDate() + " " + MONTHS[d.getMonth()]; }
function fmtFull(key){ if (!key) return "No date"; const d = toDate(key); return d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear(); }
function daysBetween(a, b){ if (!a || !b) return null; return Math.round((toDate(b) - toDate(a)) / 86400000); }
function plural(n, w){ return n + " " + w + (n === 1 ? "" : "s"); }
const clone = (o) => JSON.parse(JSON.stringify(o));
const label = (r, t, p) => "T" + t + " " + r + p;

const STYLE = `
.l3m-rack{margin:6px 0 18px}
.l3m-rack h4{margin:0 0 6px;font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:600}
.l3m-scroll{overflow-x:auto;padding-bottom:4px}
.l3m-tier{min-width:560px;margin:0 0 10px}
.l3m-th{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 4px;font-size:13px}
.l3m-th .t{font-weight:700;cursor:pointer;padding:2px 8px;border-radius:999px;background:var(--card2,#f1ebe4);border:1px solid rgba(0,0,0,.12)}
.l3m-th .c{font-weight:600}
.l3m-th .n{opacity:.7}
.l3m-th .salt{font-size:11px;color:#3d6a94}
.l3m-th button{font-size:12px;padding:3px 9px}
.l3m-cells{display:grid;gap:4px}
.l3m-cell{border:1.5px solid rgba(0,0,0,.2);border-radius:8px;background:var(--card,#f7f3ee);padding:4px 0 3px;text-align:center;line-height:1.15;min-height:46px;font:inherit;color:inherit;cursor:default}
.l3m-cell b{display:block;font-size:13px}
.l3m-cell i{display:block;font-style:normal;font-size:9.5px;opacity:.75;white-space:nowrap}
.l3m-cell.salt{border-style:dashed;border-color:#5b8db8}
.l3m-cell.grow{background:var(--blush,#ecd6cb)}
.l3m-cell.ready{background:var(--sage,#d3dccf)}
.l3m-cell.sel{outline:3px solid var(--green,#35473a);outline-offset:1px}
.l3m-adm .l3m-cell{cursor:pointer}
.l3m-bar{position:sticky;bottom:64px;z-index:5;display:flex;gap:6px;flex-wrap:wrap;align-items:center;background:var(--card,#f7f3ee);border:1.5px solid var(--green,#35473a);border-radius:14px;padding:8px 10px;margin:8px 0;box-shadow:0 4px 14px rgba(0,0,0,.12)}
.l3m-bar .cnt{font-weight:600;margin-right:6px}
.l3m-leg{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;margin:4px 0 10px}
.l3m-leg span{display:inline-flex;align-items:center;gap:5px}
.l3m-leg u{display:inline-block;width:14px;height:14px;border-radius:4px;border:1.5px solid rgba(0,0,0,.25);text-decoration:none}
`;

// ---------------------------------------------------------------- data
function init(){
  const st = document.createElement("style"); st.textContent = STYLE; document.head.appendChild(st);
  const ov = document.createElement("div");
  ov.className = "overlay"; ov.id = "l3mOverlay";
  ov.innerHTML = '<div class="modal nl-modal" id="l3mModal"></div>';
  document.body.appendChild(ov);
  root.addEventListener("click", onClick);
  ov.addEventListener("click", onClick);
  onAuthStateChanged(auth, (user) => { isAdmin = !!user; if (!isAdmin) sel.clear(); render(); });
  onSnapshot(REF, (snap) => {
    if (snap.exists()){
      const d = snap.data();
      state = { trays: d.trays && typeof d.trays === "object" ? d.trays : {}, history: Array.isArray(d.history) ? d.history : [] };
    }
    loaded = true; loadError = "";
    render();
  }, (err) => { loadError = err.message; render(); });
  render();
}

async function mutate(fn){
  if (!isAdmin){ alert("Log in as admin to make changes."); return false; }
  if (!loaded){ alert("Still loading — try again in a moment."); return false; }
  last = clone(state);
  const next = clone(state);
  fn(next);
  state = next;
  render();
  try { await setDoc(REF, next); return true; }
  catch (e){ alert("Couldn't save: " + e.message); return false; }
}

async function undo(){
  if (!last) return;
  if (!confirm("Undo the last change?")) return;
  const prev = last; last = null;
  state = prev; sel.clear(); render();
  try { await setDoc(REF, prev); } catch (e){ alert("Couldn't save: " + e.message); }
}

const occ = () => Object.keys(state.trays).map(k => Object.assign({ k }, parseKey(k), state.trays[k])).filter(x => x.r && x.p >= 1 && x.p <= posOf(x.r)).map(x => Object.assign(x, { crop: cropAt(x.r, x.t) }));
const trayPlants = (x) => ppt(x.crop);

// ---------------------------------------------------------------- render
function blk(no, title, inner, extra){ return '<section class="nl-block"><div class="nl-bh"><span class="nl-no">' + no + '</span><span class="nl-bt">' + title + '</span>' + (extra || "") + '</div>' + inner + '</section>'; }
function bar(used, max){
  const pct = max ? Math.min(100, Math.round(used / max * 100)) : 0;
  return '<div class="nl-bar"><div class="nl-bar-fill ' + (max && used >= max ? "full" : (pct >= 85 ? "high" : "")) + '" style="width:' + pct + '%"></div></div>';
}

function capCards(list){
  const filled = list.length, plants = list.reduce((s, x) => s + trayPlants(x), 0);
  const rp = list.filter(x => x.ready).reduce((s, x) => s + trayPlants(x), 0);
  const empty = TOTAL - filled;
  let h = '<div class="nl-caps" style="grid-template-columns:repeat(3,minmax(0,1fr));">';
  h += '<div class="nl-cap ' + (empty === 0 ? "ok" : "") + '"><div class="nl-cap-row"><span class="nl-cap-title">Trays with crops</span><span class="nl-cap-num"><b>' + filled + '</b>/' + TOTAL + '</span><span class="nl-cap-sub">' + empty + ' empty</span></div>' + bar(filled, TOTAL) + '</div>';
  h += '<div class="nl-cap"><div class="nl-cap-row"><span class="nl-cap-title">Plants</span><span class="nl-cap-num"><b>' + plants + '</b></span><span class="nl-cap-sub">120 per tray · Ice Plant 80</span></div>' + bar(0, 0) + '</div>';
  h += '<div class="nl-cap ' + (rp ? "ok" : "") + '"><div class="nl-cap-row"><span class="nl-cap-title">Plants ready</span><span class="nl-cap-num"><b>' + rp + '</b></span><span class="nl-cap-sub">' + (plants - rp) + ' not ready</span></div>' + bar(rp, plants) + '</div>';
  return h + '</div>';
}

function cellHtml(r, t, p){
  const k = keyOf(r, t, p), tr = state.trays[k];
  let cls = "l3m-cell" + (isSalted(r, t) ? " salt" : "") + (tr ? (tr.ready ? " ready" : " grow") : "") + (sel.has(k) ? " sel" : "");
  let title = label(r, t, p) + " · " + cropAt(r, t);
  if (tr){
    const age = daysBetween(tr.date, today());
    title += " · planted " + fmtFull(tr.date) + (age != null ? " (day " + age + ")" : "") + " · " + (tr.ready ? "ready" : "not ready") + " · " + (tr.type === "old" ? "old crop" : "new crop");
  } else title += " · empty";
  return '<button type="button" class="' + cls + '" data-action="cell" data-k="' + k + '" title="' + esc(title) + '"><b>' + p + '</b><i>' + (tr ? esc(fmtShort(tr.date)) : "&nbsp;") + '</i></button>';
}

function rackHtml(rk){
  let h = '<div class="l3m-rack"><h4>' + rk.name + '</h4><div class="l3m-scroll">';
  TIERS.forEach(t => {
    const used = [], ready = [];
    for (let p = 1; p <= posOf(rk.id); p++){ const tr = state.trays[keyOf(rk.id, t, p)]; if (tr){ used.push(p); if (tr.ready) ready.push(p); } }
    h += '<div class="l3m-tier"><div class="l3m-th"><span class="t" data-action="tier" data-r="' + rk.id + '" data-t="' + t + '">T' + t + '</span><span class="c">' + esc(rk.tiers[t]) + '</span>' +
      '<span class="n">' + used.length + '/' + posOf(rk.id) + (ready.length ? ' · ' + ready.length + ' ready' : '') + '</span>' +
      (rk.id === "N" && t <= 2 ? '<span class="salt">salted water tank (3N1)</span>' : '') +
      (isAdmin ? '<button class="btn" data-action="fillTier" data-r="' + rk.id + '" data-t="' + t + '">+ Transplant</button>' + (ready.length ? '<button class="btn" data-action="harvestTier" data-r="' + rk.id + '" data-t="' + t + '">Harvest ready</button>' : '') : '') +
      '</div><div class="l3m-cells" style="grid-template-columns:repeat(' + posOf(rk.id) + ',minmax(40px,1fr));">';
    for (let p = 1; p <= posOf(rk.id); p++) h += cellHtml(rk.id, t, p);
    h += '</div></div>';
  });
  return h + '</div></div>';
}

function selBar(){
  if (!isAdmin || !sel.size) return "";
  let e = 0, f = 0; sel.forEach(k => { if (state.trays[k]) f++; else e++; });
  return '<div class="l3m-bar"><span class="cnt">' + sel.size + ' selected</span><span class="n" style="opacity:.7;margin-right:6px;">' + e + ' empty · ' + f + ' with crops</span>' +
    (e ? '<button class="btn primary" data-action="act" data-a="transplant">Transplant ' + e + '</button>' : '') +
    (f ? '<button class="btn" data-action="act" data-a="ready">Mark ready</button><button class="btn" data-action="act" data-a="notready">Not ready</button><button class="btn primary" data-action="act" data-a="harvest">Harvest ' + f + '</button><button class="btn danger" data-action="act" data-a="dispose">Dispose</button>' : '') +
    '<button class="btn" data-action="clearSel">Clear</button></div>';
}

function ranges(arr){
  const a = arr.slice().sort((x, y) => x - y), out = [];
  for (let i = 0; i < a.length;){ let j = i; while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++; out.push(i === j ? "" + a[i] : a[i] + "–" + a[j]); i = j + 1; }
  return out.join(", ");
}

function datesTable(list){
  if (!list.length) return '<div class="empty-state">No trays recorded yet. Tap squares on the map, then Transplant.</div>';
  const g = new Map();
  list.forEach(x => {
    const k = [x.crop, x.r, x.t, x.date || "", x.ready ? "r" : "n", x.type === "old" ? "old" : "new"].join("|");
    if (!g.has(k)) g.set(k, { crop: x.crop, r: x.r, t: x.t, date: x.date, ready: !!x.ready, type: x.type === "old" ? "old" : "new", ps: [] });
    g.get(k).ps.push(x.p);
  });
  const order = (r, t) => (r === "N" ? 0 : 100) + t;
  const rows = [...g.values()].sort((a, b) => a.crop.localeCompare(b.crop) || order(a.r, a.t) - order(b.r, b.t) || (a.date || "9999").localeCompare(b.date || "9999"));
  const totals = {}; rows.forEach(r => { totals[r.crop] = (totals[r.crop] || 0) + r.ps.length; });
  let h = '<div style="overflow-x:auto;"><table class="nl-table"><thead><tr><th>Crop</th><th>Date planted</th><th>Day</th><th>Tier &amp; trays</th><th>Trays</th><th>Plants</th><th>Status</th><th>Type</th></tr></thead><tbody>', prev = null;
  rows.forEach(r => {
    const first = r.crop !== prev; prev = r.crop;
    const age = r.date ? daysBetween(r.date, today()) : null;
    h += '<tr style="' + (first ? "border-top:2px solid rgba(0,0,0,.12);" : "") + '"><td>' + (first ? '<b>' + esc(r.crop) + '</b> <span class="nl-n">' + plural(totals[r.crop], "tray") + '</span>' : "") + '</td>' +
      '<td>' + fmtFull(r.date) + '</td><td>' + (age != null ? age : "–") + '</td><td>T' + r.t + ' · ' + r.r + ranges(r.ps).replace(/(, )(\d)/g, "$1" + r.r + "$2").replace(/–(\d)/g, "–" + r.r + "$1") + '</td><td>' + r.ps.length + '</td><td>' + r.ps.length * ppt(r.crop) + '</td>' +
      '<td><span class="nl-state ' + (r.ready ? "is-ready" : "not-ready") + '">' + (r.ready ? "Ready" : "Not ready") + '</span></td><td>' + (r.type === "old" ? "Old crop" : "New crop") + '</td></tr>';
  });
  return h + '</tbody></table></div>';
}

function varietyTable(list){
  const crops = {};
  RACKS.forEach(rk => TIERS.forEach(t => { const c = rk.tiers[t]; crops[c] = (crops[c] || 0) + posOf(rk.id); }));
  const names = Object.keys(crops).sort((a, b) => a.localeCompare(b));
  let h = '<table class="nl-table"><thead><tr><th>Variety</th><th>Trays with crops</th><th>Before 1 Oct</th><th>From 1 Oct</th><th>Plants ready</th><th>Plants not ready</th><th>Total plants</th></tr></thead><tbody>';
  let tT = 0, tF = 0, tB = 0, tA = 0, tR = 0, tN = 0, tM = 0;
  names.forEach(v => {
    const l = list.filter(x => x.crop === v), maxT = crops[v], mp = maxT * ppt(v);
    const rp = l.filter(x => x.ready).length * ppt(v), np = l.filter(x => !x.ready).length * ppt(v);
    const fb = l.filter(x => x.date && x.date < CUT).length, fa = l.filter(x => x.date && x.date >= CUT).length;
    tT += maxT; tF += l.length; tB += fb; tA += fa; tR += rp; tN += np; tM += mp;
    h += '<tr><td>' + esc(v) + '</td><td>' + l.length + ' / ' + maxT + '</td><td>' + fb + '</td><td>' + fa + '</td><td>' + rp + '</td><td>' + np + '</td><td>' + (rp + np) + ' / ' + mp + '</td></tr>';
  });
  return h + '<tr class="nl-total"><td>Total</td><td>' + tF + ' / ' + tT + '</td><td>' + tB + '</td><td>' + tA + '</td><td>' + tR + '</td><td>' + tN + '</td><td>' + (tR + tN) + ' / ' + tM + '</td></tr></tbody></table>';
}

// Floor plan: both racks with their water tanks, showing which trays are free.
const SHORT = { "Mini Red Romaine Lettuce": "Red Romaine", "Crystal Green Lettuce": "Crystal Green", "Red Coral Lettuce": "Red Coral", "Garland Chrysanthemum": "Garland", "Ice Plant": "Ice Plant", "Perilla": "Perilla", "Mustard": "Mustard", "Sorrel": "Sorrel", "Mizuna": "Mizuna", "Swiss Chard": "Swiss Chard", "Kale": "Kale" };
function floorPlan(){
  const BW = 140, BH = 100, GAP = 14, X0 = 45;
  const cx = (i) => X0 + i * (BW + GAP) + BW / 2;
  const stat = (r, t) => { let u = 0, rd = 0; const n = posOf(r); for (let p = 1; p <= n; p++){ const tr = state.trays[keyOf(r, t, p)]; if (tr){ u++; if (tr.ready) rd++; } } return { u, rd, n, free: n - u }; };
  let s = '<svg viewBox="0 0 1000 600" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;min-width:760px;font-family:Inter,system-ui,sans-serif;">';
  const text = (x, y, str, size, weight, fill, anchor) => '<text x="' + x + '" y="' + y + '" font-size="' + size + '" font-weight="' + (weight || 400) + '" fill="' + (fill || "#2c3a30") + '" text-anchor="' + (anchor || "middle") + '">' + str + '</text>';
  const line = (x1, y1, x2, y2, dash) => '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="#35473a" stroke-width="2.5"' + (dash ? ' stroke-dasharray="7 5"' : "") + '/>';
  const tierBox = (rk, t, i, y) => {
    const st = stat(rk.id, t), x = X0 + i * (BW + GAP), crop = rk.tiers[t];
    const tip = rk.name + " T" + t + " · " + crop + " · " + st.u + " of " + st.n + " trays used, " + st.free + " free, " + st.rd + " ready";
    let g = '<g data-action="jump" data-r="' + rk.id + '" data-t="' + t + '" style="cursor:pointer"><title>' + esc(tip) + '</title>' +
      '<rect x="' + x + '" y="' + y + '" width="' + BW + '" height="' + BH + '" rx="10" fill="#f1ebe4" stroke="#35473a" stroke-width="2"/>' +
      text(x + BW / 2, y + 18, "T" + t + " · " + esc(SHORT[crop] || crop), 12, 700) +
      text(x + BW / 2, y + 38, "free " + st.free + " / " + st.n, 14, 700, st.free === 0 ? "#9a4a3a" : "#35473a") +
      text(x + BW / 2, y + 53, st.rd + " ready · " + (st.u - st.rd) + " growing", 10, 400, "#555");
    const sq = 8, gap = 1.9, w0 = st.n * sq + (st.n - 1) * gap, sx = x + (BW - w0) / 2;
    for (let p = 1; p <= st.n; p++){
      const tr = state.trays[keyOf(rk.id, t, p)];
      g += '<rect x="' + (sx + (p - 1) * (sq + gap)).toFixed(1) + '" y="' + (y + 62) + '" width="' + sq + '" height="' + sq + '" rx="1.5" fill="' + (tr ? (tr.ready ? "#b9c9b3" : "#ecd6cb") : "#ffffff") + '" stroke="' + (tr ? (tr.ready ? "#6d8f6a" : "#c3836b") : "#9aa59c") + '" stroke-width="1"/>';
    }
    g += text(sx, y + 88, rk.id + "1", 9, 400, "#555", "start") + text(sx + w0, y + 88, rk.id + st.n, 9, 400, "#555", "end") + '</g>';
    return g;
  };
  const tank = (xc, y, name, sub, share, ids, dashed, blue) => {
    let free = 0, total = 0; ids.forEach(([r, t]) => { const st = stat(r, t); free += st.free; total += st.n; });
    const w = 150, x = xc - w / 2;
    return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="66" rx="6" fill="' + (blue ? "#2f5fc4" : "#ffffff") + '" stroke="#35473a" stroke-width="2.5"' + (dashed ? ' stroke-dasharray="7 5"' : "") + '/>' +
      text(xc, y + 17, name, 15, 700, blue ? "#fff" : "#2c3a30") + text(xc, y + 30, sub, 9.5, 400, blue ? "#dbe6ff" : "#555") + text(xc, y + 42, share, 9.5, 400, blue ? "#dbe6ff" : "#555") +
      (ids.length ? text(xc, y + 58, "free " + free + " of " + total + " trays", 11, 700, blue ? "#fff" : "#35473a") : text(xc, y + 58, "backup for slot 1", 10, 600, "#fff"));
  };
  const N = RACKS[0], S = RACKS[1];
  s += text(40, 20, "NORTH RACK", 11, 600, "#777", "start");
  // north tiers, tanks and pipes
  TIERS.forEach((t, i) => { s += tierBox(N, t, i, 30); });
  const pipe = (from, to, yBoxEdge, yBus, yTank, tcx, dashed) => {
    let o = ""; for (let i = from; i <= to; i++) o += line(cx(i), yBoxEdge, cx(i), yBus, dashed);
    o += line(cx(from), yBus, cx(to), yBus, dashed) + line(tcx, yBus, tcx, yTank, dashed); return o;
  };
  s += pipe(0, 3, 130, 152, 172, (cx(0) + cx(3)) / 2, false) + pipe(4, 5, 130, 152, 172, (cx(4) + cx(5)) / 2, true);
  s += tank((cx(0) + cx(3)) / 2, 172, "3N2", "L3 North side tank-2", "5 tanks sharing", [["N", 6], ["N", 5], ["N", 4], ["N", 3]], false, false);
  s += tank((cx(4) + cx(5)) / 2, 172, "3N1", "L3 North side tank-1", "2 tanks sharing · salted", [["N", 2], ["N", 1]], true, false);
  // rails, AGV
  s += line(45, 262, 955, 262, true).replace('stroke-width="2.5"', 'stroke-width="1.5" opacity=".5"') + text(50, 255, "Robot rail (north)", 10, 400, "#777", "start") +
    '<rect x="45" y="278" width="200" height="50" rx="6" fill="#fff" stroke="#35473a" stroke-width="2.5"/>' + text(145, 299, "AGV TROLLEY", 13, 700) + text(145, 316, "MAIN ENTRANCE", 11, 600) +
    line(45, 346, 955, 346, true).replace('stroke-width="2.5"', 'stroke-width="1.5" opacity=".5"') + text(50, 339, "Robot rail (south)", 10, 400, "#777", "start");
  // south tanks, pipes, tiers
  s += tank(115, 368, "Buffer", "Slot 1", "2 tanks sharing", [], false, true);
  s += tank((cx(0) + cx(2)) / 2, 368, "3S2", "L3 South side tank-2", "3 tanks sharing", [["S", 6], ["S", 5], ["S", 4]], false, false);
  s += tank((cx(3) + cx(5)) / 2, 368, "3S1", "L3 South side tank-1", "3 tanks sharing", [["S", 3], ["S", 2], ["S", 1]], true, false);
  const pipeS = (from, to, tcx, dashed) => { let o = ""; for (let i = from; i <= to; i++) o += line(cx(i), 452, cx(i), 476, dashed); return o + line(cx(from), 452, cx(to), 452, dashed) + line(tcx, 434, tcx, 452, dashed); };
  s += pipeS(0, 2, (cx(0) + cx(2)) / 2, false) + pipeS(3, 5, (cx(3) + cx(5)) / 2, true);
  TIERS.forEach((t, i) => { s += tierBox(S, t, i, 476); });
  s += text(40, 596, "SOUTH RACK", 11, 600, "#777", "start");
  s += '</svg>';
  return '<div style="overflow-x:auto;">' + s + '</div><p class="hint" style="margin-top:6px;">Each box is one tier (one crop). The small squares are its trays, numbered from 1; white = free, pink = growing, green = ready. Dashed pipes are the salted / shared tanks. Tap a box to jump to that tier in the tray map.</p>';
}

// Crops consolidated by planting period: before 1 Oct vs from 1 Oct, with the dates and totals.
function consolidation(list){
  const names = [...new Set(list.map(x => x.crop))].sort((a, b) => a.localeCompare(b));
  if (!names.length) return '<div class="empty-state">No trays recorded yet.</div>';
  const dateLines = (l) => {
    const m = {}; l.forEach(x => { const d = x.date || ""; m[d] = (m[d] || 0) + 1; });
    return Object.keys(m).sort().map(d => (d ? fmtFull(d) : "No date") + " <b>×" + m[d] + "</b>").join("<br>") || "–";
  };
  let h = '<div style="overflow-x:auto;"><table class="nl-table"><thead><tr><th rowspan="2">Crop</th><th colspan="3" style="text-align:center;">Before 1 Oct</th><th colspan="3" style="text-align:center;">From 1 Oct</th><th colspan="2" style="text-align:center;">Total</th></tr>' +
    '<tr><th>Dates planted (×trays)</th><th>Trays</th><th>Plants</th><th>Dates planted (×trays)</th><th>Trays</th><th>Plants</th><th>Trays</th><th>Plants</th></tr></thead><tbody>';
  const T = { bt: 0, bp: 0, at: 0, ap: 0 };
  names.forEach(c => {
    const l = list.filter(x => x.crop === c);
    const b = l.filter(x => x.date && x.date < CUT), a = l.filter(x => !(x.date && x.date < CUT));
    const bp = b.length * ppt(c), ap = a.length * ppt(c);
    T.bt += b.length; T.bp += bp; T.at += a.length; T.ap += ap;
    h += '<tr style="vertical-align:top;"><td><b>' + esc(c) + '</b></td><td>' + dateLines(b) + '</td><td>' + b.length + '</td><td>' + bp + '</td><td>' + dateLines(a) + '</td><td>' + a.length + '</td><td>' + ap + '</td><td><b>' + l.length + '</b></td><td><b>' + (bp + ap) + '</b></td></tr>';
  });
  return h + '<tr class="nl-total"><td>Total</td><td></td><td>' + T.bt + '</td><td>' + T.bp + '</td><td></td><td>' + T.at + '</td><td>' + T.ap + '</td><td>' + (T.bt + T.at) + '</td><td>' + (T.bp + T.ap) + '</td></tr></tbody></table></div>';
}

function historySection(){
  const h0 = state.history.slice().sort((a, b) => (b.exitDate || "").localeCompare(a.exitDate || ""));
  let h = '<p class="hint nl-toggle" data-action="history">' + (showHistory ? "Hide" : "Show") + ' trays that have left (' + h0.length + ')</p>';
  if (!showHistory) return h;
  if (!h0.length) return h + '<div class="empty-state">Nothing harvested or removed yet.</div>';
  h += '<div style="overflow-x:auto;"><table class="nl-table"><thead><tr><th>Left</th><th>Crop</th><th>Tray</th><th>Planted</th><th>Plants</th><th>Type</th><th>Result</th></tr></thead><tbody>';
  h0.slice(0, 200).forEach(x => {
    const q = parseKey(x.k);
    h += '<tr><td>' + fmtFull(x.exitDate) + '</td><td>' + esc(x.crop) + '</td><td>' + (q ? label(q.r, q.t, q.p) : esc(x.k)) + '</td><td>' + fmtFull(x.date) + '</td><td>' + (x.plants || "") + '</td><td>' + (x.type === "old" ? "Old crop" : "New crop") + '</td><td>' + (x.exitType === "harvested" ? "Harvested" : "Disposed") + '</td></tr>';
  });
  return h + '</tbody></table></div>';
}

function render(){
  if (!root) return;
  const list = occ();
  let h = '<div class="section nl-root"><h2>Level 3 — Tray map</h2>';
  h += '<p class="hint">North rack 11 trays per tier, South rack 13, 6 tiers each. Tap a tray to see and change its details. Use Select many to update several at once. Each tier grows one crop.</p>';
  if (loadError) h += '<div class="kiosk-message err">Couldn\'t load: ' + esc(loadError) + '</div>';
  if (!loaded && !loadError) h += '<p class="hint">Loading…</p>';
  h += blk("01", "Capacity", capCards(list));
  let actions = "";
  if (isAdmin){
    actions = '<div class="nl-actions"><button class="btn' + (multi ? " primary" : "") + '" data-action="multi">' + (multi ? "Selecting many: ON (tap trays, then choose an action)" : "Select many trays") + '</button>' + (last ? '<button class="btn" data-action="undo">Undo last change</button>' : '') +
      (!list.length ? '<button class="btn" data-action="import">Import from the old Level 3 tracker</button>' : '') + '</div>';
  }
  h += blk("02", "Floor plan — what is free", floorPlan());
  h += blk("03", "Tray map", actions +
    '<div class="l3m-leg"><span><u></u>Empty</span><span><u style="background:var(--blush,#ecd6cb)"></u>Growing</span><span><u style="background:var(--sage,#d3dccf)"></u>Ready</span><span><u style="border-style:dashed;border-color:#5b8db8"></u>Salted water</span><span>Number = tray position · small text = date planted</span></div>' +
    '<div class="' + (isAdmin ? "l3m-adm" : "") + '">' + rackHtml(RACKS[0]) + rackHtml(RACKS[1]) + '</div>' + selBar());
  h += '<section class="nl-block"><div class="nl-bh nl-toggle" data-action="toggleDates" style="cursor:pointer;"><span class="nl-no">04</span><span class="nl-bt">Dates by crop</span><span class="nl-count">' + plural(list.length, "tray") + ' · ' + (showDates ? "Hide ▴" : "Show ▾") + '</span></div>' + (showDates ? datesTable(list) : "") + '</section>';
  h += blk("05", "Consolidation — before 1 Oct vs from 1 Oct", consolidation(list));
  h += blk("06", "By variety", varietyTable(list));
  h += blk("07", "History", historySection());
  h += '</div>';
  root.innerHTML = h;
}

// ---------------------------------------------------------------- modals
const $m = () => document.getElementById("l3mModal");
function openModal(html){ $m().innerHTML = html; document.getElementById("l3mOverlay").classList.add("active"); }
function closeModal(){ const o = document.getElementById("l3mOverlay"); if (o) o.classList.remove("active"); }
const val = (id) => document.getElementById(id).value;
const typeSel = (v) => '<select id="l3mType"><option value="new"' + (v !== "old" ? " selected" : "") + '>New crop</option><option value="old"' + (v === "old" ? " selected" : "") + '>Old crop</option></select>';

function openTray(k){
  const q = parseKey(k); if (!q) return;
  const tr = state.trays[k], crop = cropAt(q.r, q.t);
  const head = '<h3>' + label(q.r, q.t, q.p) + ' · ' + esc(crop) + '</h3>';
  const status = '<div class="field"><label>Status</label><select id="l3mStatus"><option value="0"' + (!tr || !tr.ready ? " selected" : "") + '>Not ready</option><option value="1"' + (tr && tr.ready ? " selected" : "") + '>Ready to harvest</option></select></div>';
  if (!tr){
    openModal(head + '<div class="sub">Empty tray (' + (q.r === "N" ? "North" : "South") + ' rack, tier ' + q.t + ', position ' + q.p + '). Transplant a crop into it.</div>' +
      '<div class="row2"><div class="field"><label>Date planted</label><input type="date" id="l3mDate" value="' + today() + '"></div><div class="field"><label>New or old crop</label>' + typeSel("new") + '</div></div>' + status +
      '<div class="modal-actions"><button class="btn" data-m="cancel">Cancel</button><button class="btn primary" data-m="saveTray" data-k="' + k + '">Transplant</button></div>');
    return;
  }
  const age = daysBetween(tr.date, today());
  openModal(head + '<div class="sub">' + plural(1, "tray") + ' · ' + ppt(crop) + ' plants · planted ' + fmtFull(tr.date) + (age != null ? " (day " + age + ")" : "") + '</div>' +
    '<div class="row2"><div class="field"><label>Date planted</label><input type="date" id="l3mDate" value="' + esc(tr.date || "") + '"></div><div class="field"><label>New or old crop</label>' + typeSel(tr.type === "old" ? "old" : "new") + '</div></div>' + status +
    '<div class="nl-btnrow"><button class="btn primary" data-m="trayExit" data-kind="harvested" data-k="' + k + '">Harvested</button><button class="btn danger" data-m="trayExit" data-kind="disposed" data-k="' + k + '">Dispose</button></div>' +
    '<div class="modal-actions"><div style="display:flex;gap:6px;"><button class="btn danger" data-m="trayRemove" data-k="' + k + '">Entered by mistake — empty it</button></div><div style="display:flex;gap:6px;"><button class="btn" data-m="cancel">Cancel</button><button class="btn primary" data-m="saveTray" data-k="' + k + '">Save</button></div></div>');
}

function saveTray(k){
  const date = val("l3mDate") || today(), type = val("l3mType") === "old" ? "old" : "new", ready = val("l3mStatus") === "1", d = today();
  mutate(s => {
    const tr = s.trays[k];
    if (tr){ const was = !!tr.ready; tr.date = date; tr.type = type; tr.ready = ready; if (ready && !was) tr.readyDate = d; if (!ready) tr.readyDate = null; }
    else s.trays[k] = { date, ready, readyDate: ready ? d : null, type };
  }).then(ok => { if (ok) closeModal(); });
}

function emptyKeys(){ return [...sel].filter(k => !state.trays[k]); }
function fullKeys(){ return [...sel].filter(k => state.trays[k]); }

function summarize(keys){
  const by = {}; keys.forEach(k => { const c = cropOfKey(k); by[c] = (by[c] || 0) + 1; });
  return Object.keys(by).map(c => by[c] + " × " + c).join(", ");
}

function openTransplant(keys){
  openModal('<h3>Transplant ' + plural(keys.length, "tray") + '</h3><div class="sub">' + esc(summarize(keys)) + '</div>' +
    '<div class="row2"><div class="field"><label>Date planted</label><input type="date" id="l3mDate" value="' + today() + '"></div>' +
    '<div class="field"><label>New or old crop</label>' + typeSel() + '</div></div>' +
    '<div class="modal-actions"><button class="btn" data-m="cancel">Cancel</button><button class="btn primary" data-m="saveTransplant" data-keys="' + esc(keys.join(",")) + '">Transplant</button></div>');
}

function saveTransplant(keys){
  const date = val("l3mDate") || today(), type = val("l3mType") === "old" ? "old" : "new";
  mutate(s => { keys.forEach(k => { if (!s.trays[k]) s.trays[k] = { date, ready: false, readyDate: null, type }; }); }).then(ok => { if (ok){ sel.clear(); closeModal(); render(); } });
}

function openFillTier(r, t){
  const free = []; for (let p = 1; p <= posOf(r); p++) if (!state.trays[keyOf(r, t, p)]) free.push(p);
  if (!free.length) return alert("This tier is full.");
  openModal('<h3>Transplant into T' + t + ' · ' + esc(cropAt(r, t)) + '</h3><div class="sub">' + (r === "N" ? "North" : "South") + ' rack. Trays fill the next empty positions, starting at ' + r + free[0] + '. ' + free.length + ' empty.</div>' +
    '<div class="row2"><div class="field"><label>Number of trays</label><input type="number" id="l3mN" min="1" max="' + free.length + '" step="1" value="1"></div>' +
    '<div class="field"><label>Date planted</label><input type="date" id="l3mDate" value="' + today() + '"></div></div>' +
    '<div class="field"><label>New or old crop</label>' + typeSel() + '</div>' +
    '<div class="modal-actions"><button class="btn" data-m="cancel">Cancel</button><button class="btn primary" data-m="saveFill" data-r="' + r + '" data-t="' + t + '">Transplant</button></div>');
}

function saveFill(r, t){
  const n = parseInt(val("l3mN"), 10), date = val("l3mDate") || today(), type = val("l3mType") === "old" ? "old" : "new";
  const free = []; for (let p = 1; p <= posOf(r); p++) if (!state.trays[keyOf(r, t, p)]) free.push(p);
  if (!(n >= 1) || n > free.length) return alert("Enter 1 to " + free.length + " trays.");
  mutate(s => { free.slice(0, n).forEach(p => { s.trays[keyOf(r, t, p)] = { date, ready: false, readyDate: null, type }; }); }).then(ok => { if (ok) closeModal(); });
}

function openExit(kind){
  const keys = fullKeys(); if (!keys.length) return;
  const harvest = kind === "harvested";
  openModal('<h3>' + (harvest ? "Harvest " : "Dispose ") + plural(keys.length, "tray") + '</h3><div class="sub">' + esc(summarize(keys)) + '. They become empty and move to the history.</div>' +
    '<div class="row2"><div class="field"><label>Date</label><input type="date" id="l3mDate" value="' + today() + '"></div>' +
    '<div class="field"><label>Note (optional)</label><input type="text" id="l3mNote" placeholder="e.g. reason"></div></div>' +
    '<div class="modal-actions"><button class="btn" data-m="cancel">Cancel</button><button class="btn ' + (harvest ? "primary" : "danger") + '" data-m="saveExit" data-kind="' + kind + '" data-keys="' + esc(keys.join(",")) + '">' + (harvest ? "Harvest" : "Dispose") + '</button></div>');
}

function saveExit(kind, keys){
  const date = val("l3mDate") || today(), note = val("l3mNote").trim();
  mutate(s => {
    keys.forEach(k => {
      const tr = s.trays[k]; if (!tr) return;
      const crop = cropOfKey(k);
      s.history.push({ k, crop, plants: ppt(crop), date: tr.date, readyDate: tr.readyDate || null, type: tr.type === "old" ? "old" : "new", exitType: kind, exitDate: date, note });
      delete s.trays[k];
    });
  }).then(ok => { if (ok){ sel.clear(); closeModal(); render(); } });
}

function setReady(flag){
  const keys = fullKeys(); if (!keys.length) return;
  const d = today();
  mutate(s => { keys.forEach(k => { const tr = s.trays[k]; if (tr){ tr.ready = flag; tr.readyDate = flag ? d : null; } }); }).then(ok => { if (ok){ sel.clear(); render(); } });
}

async function importOld(){
  if (!confirm("Import the trays from the old Level 3 tracker? They are placed automatically into the next empty positions of each crop's tier. Crops that overflow a tier are skipped.")) return;
  try {
    const snap = await getDoc(doc(db, "meta", "level3Log"));
    const batches = snap.exists() && Array.isArray(snap.data().batches) ? snap.data().batches.filter(b => !b.exitType) : [];
    if (!batches.length) return alert("The old tracker has no trays to import.");
    let placed = 0, skipped = 0;
    await mutate(s => {
      batches.forEach(b => {
        let n = Math.round(Number(b.trays) || 0);
        for (const rk of RACKS) for (const t of [1, 2, 3, 4, 5, 6]){
          if (rk.tiers[t] !== b.variety) continue;
          for (let p = 1; p <= posOf(rk.id) && n > 0; p++){
            const k = keyOf(rk.id, t, p);
            if (!s.trays[k]){ s.trays[k] = { date: b.plantedDate || today(), ready: !!b.ready, readyDate: b.ready ? (b.readyDate || today()) : null, type: b.crop === "old" ? "old" : "new" }; placed++; n--; }
          }
        }
        skipped += n;
      });
    });
    alert("Imported " + placed + " trays" + (skipped ? ". " + skipped + " didn't fit (their crop's tiers were full)." : "."));
  } catch (e){ alert("Couldn't import: " + e.message); }
}

// ---------------------------------------------------------------- events
function onClick(e){
  const m = e.target.closest("[data-m]");
  if (m){
    const a = m.dataset.m;
    if (a === "cancel") return closeModal();
    if (a === "saveTray") return saveTray(m.dataset.k);
    if (a === "trayExit"){ sel.clear(); sel.add(m.dataset.k); return openExit(m.dataset.kind); }
    if (a === "trayRemove"){
      if (!confirm("Empty this tray without recording it in the history? Use this for a mistaken entry.")) return;
      return mutate(s => { delete s.trays[m.dataset.k]; }).then(ok => { if (ok) closeModal(); });
    }
    if (a === "saveTransplant") return saveTransplant(m.dataset.keys.split(","));
    if (a === "saveFill") return saveFill(m.dataset.r, +m.dataset.t);
    if (a === "saveExit") return saveExit(m.dataset.kind, m.dataset.keys.split(","));
    return;
  }
  if (e.target.id === "l3mOverlay") return closeModal();
  const t = e.target.closest("[data-action]");
  if (!t) return;
  const a = t.dataset.action;
  if (a === "cell"){ if (!isAdmin) return; const k = t.dataset.k; if (multi){ sel.has(k) ? sel.delete(k) : sel.add(k); render(); } else openTray(k); }
  else if (a === "multi"){ multi = !multi; if (!multi) sel.clear(); render(); }
  else if (a === "tier"){
    if (!isAdmin) return;
    const keys = []; for (let p = 1; p <= posOf(t.dataset.r); p++) keys.push(keyOf(t.dataset.r, +t.dataset.t, p));
    const all = keys.every(k => sel.has(k)); keys.forEach(k => all ? sel.delete(k) : sel.add(k)); render();
  }
  else if (a === "clearSel"){ sel.clear(); render(); }
  else if (a === "act"){
    const x = t.dataset.a;
    if (x === "transplant") openTransplant(emptyKeys());
    else if (x === "ready") setReady(true);
    else if (x === "notready") setReady(false);
    else if (x === "harvest") openExit("harvested");
    else if (x === "dispose") openExit("disposed");
  }
  else if (a === "fillTier" && isAdmin) openFillTier(t.dataset.r, +t.dataset.t);
  else if (a === "harvestTier" && isAdmin){
    sel.clear(); for (let p = 1; p <= posOf(t.dataset.r); p++){ const k = keyOf(t.dataset.r, +t.dataset.t, p); if (state.trays[k] && state.trays[k].ready) sel.add(k); }
    openExit("harvested");
  }
  else if (a === "jump"){
    const el = root.querySelector('.l3m-th .t[data-r="' + t.dataset.r + '"][data-t="' + t.dataset.t + '"]');
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  else if (a === "undo") undo();
  else if (a === "import") importOld();
  else if (a === "toggleDates"){ showDates = !showDates; render(); }
  else if (a === "history"){ showHistory = !showHistory; render(); }
}

if (root) init();
