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

const POS = 13;
const TIERS = [6, 5, 4, 3, 2, 1];
const RACKS = [
  { id: "N", name: "North rack", tiers: { 1: "Ice Plant", 2: "Ice Plant", 3: "Garland Chrysanthemum", 4: "Red Coral Lettuce", 5: "Crystal Green Lettuce", 6: "Mini Red Romaine Lettuce" } },
  { id: "S", name: "South rack", tiers: { 1: "Perilla", 2: "Mustard", 3: "Sorrel", 4: "Mizuna", 5: "Swiss Chard", 6: "Kale" } }
];
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const CUT = "2026-10-01";
const TOTAL = RACKS.length * TIERS.length * POS;

const cropAt = (r, t) => RACKS.find(x => x.id === r).tiers[t];
const ppt = (crop) => (crop === "Ice Plant" ? 80 : 120);
const isSalted = (r, t, p) => r === "N" && (t === 1 || t === 2) && (p <= 4 || p >= 10);
const keyOf = (r, t, p) => r + t + "-" + p;
function parseKey(k){ const m = /^([NS])(\d)-(\d+)$/.exec(k); return m ? { r: m[1], t: +m[2], p: +m[3] } : null; }
const cropOfKey = (k) => { const q = parseKey(k); return q ? cropAt(q.r, q.t) : ""; };

let state = { trays: {}, history: [] };
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
.l3m-cells{display:grid;grid-template-columns:repeat(13,minmax(40px,1fr));gap:4px}
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

const occ = () => Object.keys(state.trays).map(k => Object.assign({ k }, parseKey(k), state.trays[k])).filter(x => x.r).map(x => Object.assign(x, { crop: cropAt(x.r, x.t) }));
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
  let cls = "l3m-cell" + (isSalted(r, t, p) ? " salt" : "") + (tr ? (tr.ready ? " ready" : " grow") : "") + (sel.has(k) ? " sel" : "");
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
    for (let p = 1; p <= POS; p++){ const tr = state.trays[keyOf(rk.id, t, p)]; if (tr){ used.push(p); if (tr.ready) ready.push(p); } }
    h += '<div class="l3m-tier"><div class="l3m-th"><span class="t" data-action="tier" data-r="' + rk.id + '" data-t="' + t + '">T' + t + '</span><span class="c">' + esc(rk.tiers[t]) + '</span>' +
      '<span class="n">' + used.length + '/' + POS + (ready.length ? ' · ' + ready.length + ' ready' : '') + '</span>' +
      (rk.id === "N" && t <= 2 ? '<span class="salt">salted water: 1-4, 10-13</span>' : '') +
      (isAdmin ? '<button class="btn" data-action="fillTier" data-r="' + rk.id + '" data-t="' + t + '">+ Transplant</button>' + (ready.length ? '<button class="btn" data-action="harvestTier" data-r="' + rk.id + '" data-t="' + t + '">Harvest ready</button>' : '') : '') +
      '</div><div class="l3m-cells">';
    for (let p = 1; p <= POS; p++) h += cellHtml(rk.id, t, p);
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
  RACKS.forEach(rk => TIERS.forEach(t => { const c = rk.tiers[t]; crops[c] = (crops[c] || 0) + 1; }));
  const names = Object.keys(crops).sort((a, b) => a.localeCompare(b));
  let h = '<table class="nl-table"><thead><tr><th>Variety</th><th>Trays with crops</th><th>Before 1 Oct</th><th>From 1 Oct</th><th>Plants ready</th><th>Plants not ready</th><th>Total plants</th></tr></thead><tbody>';
  let tT = 0, tF = 0, tB = 0, tA = 0, tR = 0, tN = 0, tM = 0;
  names.forEach(v => {
    const l = list.filter(x => x.crop === v), maxT = crops[v] * POS, mp = maxT * ppt(v);
    const rp = l.filter(x => x.ready).length * ppt(v), np = l.filter(x => !x.ready).length * ppt(v);
    const fb = l.filter(x => x.date && x.date < CUT).length, fa = l.filter(x => x.date && x.date >= CUT).length;
    tT += maxT; tF += l.length; tB += fb; tA += fa; tR += rp; tN += np; tM += mp;
    h += '<tr><td>' + esc(v) + '</td><td>' + l.length + ' / ' + maxT + '</td><td>' + fb + '</td><td>' + fa + '</td><td>' + rp + '</td><td>' + np + '</td><td>' + (rp + np) + ' / ' + mp + '</td></tr>';
  });
  return h + '<tr class="nl-total"><td>Total</td><td>' + tF + ' / ' + tT + '</td><td>' + tB + '</td><td>' + tA + '</td><td>' + tR + '</td><td>' + tN + '</td><td>' + (tR + tN) + ' / ' + tM + '</td></tr></tbody></table>';
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
  h += '<p class="hint">North and South racks, 6 tiers, 13 trays per tier. Tap trays to select them, then Transplant, Mark ready or Harvest. Each tier grows one crop.</p>';
  if (loadError) h += '<div class="kiosk-message err">Couldn\'t load: ' + esc(loadError) + '</div>';
  if (!loaded && !loadError) h += '<p class="hint">Loading…</p>';
  h += blk("01", "Capacity", capCards(list));
  let actions = "";
  if (isAdmin){
    actions = '<div class="nl-actions">' + (last ? '<button class="btn" data-action="undo">Undo last change</button>' : '') +
      (!list.length ? '<button class="btn" data-action="import">Import from the old Level 3 tracker</button>' : '') + '</div>';
  }
  h += blk("02", "Tray map", actions +
    '<div class="l3m-leg"><span><u></u>Empty</span><span><u style="background:var(--blush,#ecd6cb)"></u>Growing</span><span><u style="background:var(--sage,#d3dccf)"></u>Ready</span><span><u style="border-style:dashed;border-color:#5b8db8"></u>Salted water</span><span>Number = tray position · small text = date planted</span></div>' +
    '<div class="' + (isAdmin ? "l3m-adm" : "") + '">' + rackHtml(RACKS[0]) + rackHtml(RACKS[1]) + '</div>' + selBar());
  h += '<section class="nl-block"><div class="nl-bh nl-toggle" data-action="toggleDates" style="cursor:pointer;"><span class="nl-no">03</span><span class="nl-bt">Dates by crop</span><span class="nl-count">' + plural(list.length, "tray") + ' · ' + (showDates ? "Hide ▴" : "Show ▾") + '</span></div>' + (showDates ? datesTable(list) : "") + '</section>';
  h += blk("04", "By variety", varietyTable(list));
  h += blk("05", "History", historySection());
  h += '</div>';
  root.innerHTML = h;
}

// ---------------------------------------------------------------- modals
const $m = () => document.getElementById("l3mModal");
function openModal(html){ $m().innerHTML = html; document.getElementById("l3mOverlay").classList.add("active"); }
function closeModal(){ const o = document.getElementById("l3mOverlay"); if (o) o.classList.remove("active"); }
const val = (id) => document.getElementById(id).value;
const typeSel = () => '<select id="l3mType"><option value="new">New crop</option><option value="old">Old crop</option></select>';

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
  const free = []; for (let p = 1; p <= POS; p++) if (!state.trays[keyOf(r, t, p)]) free.push(p);
  if (!free.length) return alert("This tier is full.");
  openModal('<h3>Transplant into T' + t + ' · ' + esc(cropAt(r, t)) + '</h3><div class="sub">' + (r === "N" ? "North" : "South") + ' rack. Trays fill the next empty positions, starting at ' + r + free[0] + '. ' + free.length + ' empty.</div>' +
    '<div class="row2"><div class="field"><label>Number of trays</label><input type="number" id="l3mN" min="1" max="' + free.length + '" step="1" value="1"></div>' +
    '<div class="field"><label>Date planted</label><input type="date" id="l3mDate" value="' + today() + '"></div></div>' +
    '<div class="field"><label>New or old crop</label>' + typeSel() + '</div>' +
    '<div class="modal-actions"><button class="btn" data-m="cancel">Cancel</button><button class="btn primary" data-m="saveFill" data-r="' + r + '" data-t="' + t + '">Transplant</button></div>');
}

function saveFill(r, t){
  const n = parseInt(val("l3mN"), 10), date = val("l3mDate") || today(), type = val("l3mType") === "old" ? "old" : "new";
  const free = []; for (let p = 1; p <= POS; p++) if (!state.trays[keyOf(r, t, p)]) free.push(p);
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
          for (let p = 1; p <= POS && n > 0; p++){
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
    if (a === "saveTransplant") return saveTransplant(m.dataset.keys.split(","));
    if (a === "saveFill") return saveFill(m.dataset.r, +m.dataset.t);
    if (a === "saveExit") return saveExit(m.dataset.kind, m.dataset.keys.split(","));
    return;
  }
  if (e.target.id === "l3mOverlay") return closeModal();
  const t = e.target.closest("[data-action]");
  if (!t) return;
  const a = t.dataset.action;
  if (a === "cell"){ if (!isAdmin) return; const k = t.dataset.k; sel.has(k) ? sel.delete(k) : sel.add(k); render(); }
  else if (a === "tier"){
    if (!isAdmin) return;
    const keys = []; for (let p = 1; p <= POS; p++) keys.push(keyOf(t.dataset.r, +t.dataset.t, p));
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
    sel.clear(); for (let p = 1; p <= POS; p++){ const k = keyOf(t.dataset.r, +t.dataset.t, p); if (state.trays[k] && state.trays[k].ready) sel.add(k); }
    openExit("harvested");
  }
  else if (a === "undo") undo();
  else if (a === "import") importOld();
  else if (a === "toggleDates"){ showDates = !showDates; render(); }
  else if (a === "history"){ showHistory = !showHistory; render(); }
}

if (root) init();
