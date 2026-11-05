// ============================================================================
// Level 3 — tray and plant tracker. Same idea as the Level 1 nursery log (nursery.js):
// one Firestore doc, meta/level3Log (meta is already public-read / admin-write).
//   { batches: [ { id, variety, trays, plants, plantedDate, ready (bool), readyDate, exitDate, exitType:
//                  "harvested"|"disposed"|null, note, tally? } ],
//     varieties: [names], totalTrays: N (trays installed), plantsPerTray: N (default per tray) }
// "Filled" trays = trays in batches that haven't left. Empty = totalTrays - filled.
// ============================================================================
import { getApps, getApp, initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { getFirestore, doc, onSnapshot, setDoc } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const app = getApps().length ? getApp() : initializeApp(window.FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);
const REF = doc(db, "meta", "level3Log");
const root = document.getElementById("level3LogRoot");

const DEFAULT_VARIETIES = ["Perilla", "Mustard", "Sorrel", "Mizuna", "Swiss Chard", "Kale", "Ice Plant", "Red Coral Lettuce", "Crystal Green Lettuce", "Mini Red Romaine Lettuce", "Garland Chrysanthemum"];
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DEFAULT_VARIETY_TRAYS = { "Crystal Green Lettuce": 11, "Garland Chrysanthemum": 11, "Ice Plant": 22, "Kale": 13, "Mini Red Romaine Lettuce": 11, "Red Coral Lettuce": 11 };
const EXIT_LABELS = { harvested: "Harvested", disposed: "Disposed" };

let state = { batches: [], varieties: DEFAULT_VARIETIES.slice(), totalTrays: 0, plantsPerTray: 0, varietyTrays: Object.assign({}, DEFAULT_VARIETY_TRAYS) };
let loaded = false, isAdmin = false, loadError = "", showHistory = false, quickReady = false;

function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function toDate(s){ const p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
function toKey(d){ return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0"); }
function today(){ const d = new Date(); if (d.getHours() < 7) d.setDate(d.getDate() - 1); return toKey(d); }
function fmt(key){ if (!key) return "date unknown"; const d = toDate(key); return d.getDate() + " " + MONTHS[d.getMonth()]; }
function daysBetween(a, b){ if (!a || !b) return null; return Math.round((toDate(b) - toDate(a)) / 86400000); }
function plural(n, w){ return n + " " + w + (n === 1 ? "" : "s"); }
function avg(arr){ return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null; }
function r1(n){ return n == null ? "–" : (Math.round(n * 10) / 10).toString(); }
const num = (x) => Number(x) || 0;

function init(){
  const ov = document.createElement("div");
  ov.className = "overlay"; ov.id = "l3Overlay";
  ov.innerHTML = '<div class="modal nl-modal" id="l3Modal"></div>';
  document.body.appendChild(ov);
  root.addEventListener("click", onClick);
  ov.addEventListener("click", onClick);
  onAuthStateChanged(auth, (user) => { isAdmin = !!user; render(); });
  onSnapshot(REF, (snap) => {
    if (snap.exists()){
      const d = snap.data();
      state = {
        batches: Array.isArray(d.batches) ? d.batches : [],
        varieties: Array.isArray(d.varieties) && d.varieties.length ? d.varieties : DEFAULT_VARIETIES.slice(),
        totalTrays: num(d.totalTrays),
        plantsPerTray: num(d.plantsPerTray),
        varietyTrays: d.varietyTrays && typeof d.varietyTrays === "object" ? d.varietyTrays : Object.assign({}, DEFAULT_VARIETY_TRAYS)
      };
    }
    loaded = true; loadError = "";
    render();
  }, (err) => { loadError = err.message; render(); });
  render();
}

async function mutate(fn){
  if (!isAdmin){ alert("Log in as admin to make changes."); return false; }
  if (!loaded){ alert("Still loading — try again in a moment."); return false; }
  const next = JSON.parse(JSON.stringify(state));
  fn(next);
  state = next;
  render();
  try { await setDoc(REF, next); return true; }
  catch (e){ alert("Couldn't save: " + e.message); return false; }
}

const active = () => state.batches.filter(b => !b.exitType);
const sumTrays = (arr) => arr.reduce((s, b) => s + num(b.trays), 0);
const effTotal = () => { const s = Object.values(state.varietyTrays || {}).reduce((a, x) => a + num(x), 0); return s || state.totalTrays; };
const sumPlants = (arr) => arr.reduce((s, b) => s + num(b.plants), 0);

function computeStats(){
  const by = {};
  state.batches.forEach(b => {
    if (b.exitType !== "harvested") return;
    const d = daysBetween(b.plantedDate, b.exitDate);
    if (d == null || d < 0) return;
    (by[b.variety] = by[b.variety] || []).push(d);
  });
  return by;
}

// ---------------------------------------------------------------- render
function blk(no, title, inner, extra){ return '<section class="nl-block"><div class="nl-bh"><span class="nl-no">' + no + '</span><span class="nl-bt">' + title + '</span>' + (extra || "") + '</div>' + inner + '</section>'; }

function bar(used, max){
  const pct = max ? Math.min(100, Math.round(used / max * 100)) : 0;
  return '<div class="nl-bar"><div class="nl-bar-fill ' + (max && used >= max ? "full" : (pct >= 85 ? "high" : "")) + '" style="width:' + pct + '%"></div></div>';
}

function capCards(filled, plants, readyPlants){
  const total = effTotal(), empty = total - filled;
  const msg = !total ? "Set total trays" : (empty > 0 ? empty + " empty" : (empty === 0 ? "All filled" : (-empty) + " over"));
  let h = '<div class="nl-caps" style="grid-template-columns:repeat(3,minmax(0,1fr));">';
  h += '<div class="nl-cap ' + (total && empty === 0 ? "ok" : (empty < 0 ? "over" : "")) + '"><div class="nl-cap-row"><span class="nl-cap-title">Trays filled</span>' +
    '<span class="nl-cap-num"><b>' + filled + '</b>' + (total ? '/' + total : "") + '</span><span class="nl-cap-sub">' + msg + '</span></div>' + bar(filled, total) + '</div>';
  h += '<div class="nl-cap"><div class="nl-cap-row"><span class="nl-cap-title">Plants</span><span class="nl-cap-num"><b>' + plants + '</b></span>' +
    '<span class="nl-cap-sub">' + (state.plantsPerTray ? state.plantsPerTray + " per tray" : "") + '</span></div>' + bar(0, 0) + '</div>';
  h += '<div class="nl-cap ' + (readyPlants ? "ok" : "") + '"><div class="nl-cap-row"><span class="nl-cap-title">Plants ready</span><span class="nl-cap-num"><b>' + readyPlants + '</b></span>' +
    '<span class="nl-cap-sub">' + (plants - readyPlants) + ' not ready</span></div>' + bar(readyPlants, plants) + '</div>';
  return h + '</div>';
}

function groupBatches(arr){
  const map = new Map();
  arr.forEach(b => {
    const k = [b.variety, b.plantedDate || "", b.ready ? "r" : "n"].join("|");
    if (!map.has(k)) map.set(k, Object.assign({}, b, { ids: [b.id], trays: 0, plants: 0 }));
    const g = map.get(k); g.trays += num(b.trays); g.plants += num(b.plants); if (!g.ids.includes(b.id)) g.ids.push(b.id);
  });
  return [...map.values()];
}

function batchCard(b, stats){
  const age = b.plantedDate ? daysBetween(b.plantedDate, today()) : null;
  const typ = stats[b.variety] ? avg(stats[b.variety]) : null;
  const due = age != null && typ != null && age >= Math.round(typ);
  const sub = "Planted " + fmt(b.plantedDate) + (age != null ? " · day " + age : "") + (b.plants ? " · " + b.plants + " plants" : "") + (typ != null ? " (typ. " + Math.round(typ) + "d)" : "");
  const tag = isAdmin ? "button" : "div";
  return '<' + tag + ' class="nl-card' + (b.ready ? " ready" : (due ? " due" : "")) + '" data-action="open" data-id="' + esc(b.id) + '" data-ids="' + esc(b.ids.join(",")) + '">' +
    '<span class="nl-card-name">' + esc(b.variety) + '</span><span class="nl-trays">' + b.trays + '</span>' +
    '<span class="nl-card-sub"><span class="nl-state ' + (b.ready ? "is-ready" : "not-ready") + '">' + (b.ready ? "Ready to harvest" : "Not ready") + '</span> ' + esc(sub) + (!b.ready && due ? ' <span class="nl-due">check?</span>' : "") + '</span></' + tag + '>';
}

function render(){
  if (!root) return;
  const stats = computeStats();
  const act = active().slice().sort((a, b) => (b.ready ? 1 : 0) - (a.ready ? 1 : 0) || (a.plantedDate || "9999").localeCompare(b.plantedDate || "9999"));
  const filled = sumTrays(act), plants = sumPlants(act), readyPlants = sumPlants(act.filter(b => b.ready));
  let h = '<div class="section nl-root"><h2>Level 3 — Trays &amp; plants</h2>';
  h += '<p class="hint">Record how many trays are installed, how many are filled, and the plants in them. Tap a batch to harvest or remove it.</p>';
  if (loadError) h += '<div class="kiosk-message err">Couldn\'t load: ' + esc(loadError) + '</div>';
  if (!loaded && !loadError) h += '<p class="hint">Loading…</p>';
  let capH = capCards(filled, plants, readyPlants);
  if (loaded && effTotal() && filled > effTotal()) capH += '<div class="nl-alerts">Filled trays are over the total installed. Check the numbers or raise the total.</div>';
  h += blk("01", "Capacity", capH);
  if (isAdmin) h += blk("02", "Actions",
    '<div class="nl-actions"><button class="btn primary" data-action="add">+ Add trays</button><button class="btn" data-action="settings">⚙ Trays per crop &amp; plants per tray</button></div>' + quickPanel());
  h += blk("03", "Filled trays now", '<div class="nl-list">' + (act.length ? groupBatches(act).map(b => batchCard(b, stats)).join("") : '<div class="empty-state">No filled trays recorded yet.</div>') + '</div>',
    '<span class="nl-count">' + filled + (effTotal() ? ' / ' + effTotal() : "") + ' trays</span>');
  h += blk("04", "By variety", varietyTable(act, filled, plants));
  h += blk("05", "History", historySection(stats));
  h += '</div>';
  root.innerHTML = h;
}

function quickPanel(){
  const counts = {};
  active().filter(b => !!b.ready === quickReady).forEach(b => { counts[b.variety] = (counts[b.variety] || 0) + num(b.trays); });
  let h = '<div class="nl-quick"><div class="nl-quick-head"><b>Quick count</b> — tap a crop for +1 tray, dated today' +
    '<span class="nl-seg"><button class="' + (!quickReady ? "on" : "") + '" data-action="qready" data-ready="0">Not ready</button>' +
    '<button class="' + (quickReady ? "on" : "") + '" data-action="qready" data-ready="1">Ready to harvest</button></span></div><div class="nl-qgrid">';
  state.varieties.forEach((v, i) => {
    const n = counts[v] || 0;
    h += '<div class="nl-qc"><button class="nl-qc-add" data-action="qadd" data-i="' + i + '"><span class="nl-qc-name">' + esc(v) + '</span><span class="nl-qc-row"><span class="nl-qc-n">' + n + '</span><span class="nl-qc-plus">+1</span></span></button>' +
      '<button class="nl-qc-minus" data-action="qsub" data-i="' + i + '" title="Remove 1 tray (undo)"' + (n ? "" : " disabled") + '>−</button></div>';
  });
  return h + '</div></div>';
}

function quickAdd(i){
  const v = state.varieties[i]; if (v == null) return;
  const t = today(), ppt = state.plantsPerTray;
  mutate(s => {
    let b = s.batches.find(x => !x.exitType && x.tally && x.variety === v && x.plantedDate === t && !!x.ready === quickReady);
    if (b){ b.trays = num(b.trays) + 1; b.plants = num(b.plants) + ppt; }
    else s.batches.push({ id: uid(), variety: v, trays: 1, plants: ppt, plantedDate: t, ready: quickReady, readyDate: quickReady ? t : null, exitDate: null, exitType: null, note: "", tally: true });
  });
}

function quickSub(i){
  const v = state.varieties[i]; if (v == null) return;
  mutate(s => {
    const list = s.batches.filter(x => !x.exitType && x.variety === v && !!x.ready === quickReady);
    if (!list.length) return;
    const b = list.find(x => x.tally && x.plantedDate === today()) || list[list.length - 1];
    const per = num(b.trays) ? num(b.plants) / num(b.trays) : 0;
    b.trays = num(b.trays) - 1; b.plants = Math.max(0, Math.round(num(b.plants) - per));
    if (b.trays <= 0) s.batches = s.batches.filter(x => x.id !== b.id);
  });
}

function varietyTable(act, filled, plants){
  const vt = state.varietyTrays || {};
  const names = [...new Set([...act.map(b => b.variety), ...Object.keys(vt).filter(v => num(vt[v]) > 0)])].sort((a, b) => a.localeCompare(b));
  if (!names.length) return '<div class="empty-state">No trays recorded yet.</div>';
  let h = '<table class="nl-table"><thead><tr><th>Variety</th><th>Trays filled</th><th>Plants ready</th><th>Plants not ready</th><th>Total plants</th></tr></thead><tbody>';
  let tT = 0, tF = 0, tR = 0, tN = 0;
  names.forEach(v => {
    const l = act.filter(b => b.variety === v), f = sumTrays(l), t = num(vt[v]);
    const rp = sumPlants(l.filter(b => b.ready)), np = sumPlants(l.filter(b => !b.ready));
    tT += t; tF += f; tR += rp; tN += np;
    h += '<tr><td>' + esc(v) + '</td><td' + (t && f > t ? ' style="color:#9a4a3a;font-weight:700;"' : "") + '>' + f + (t ? ' / ' + t : "") + '</td><td>' + rp + '</td><td>' + np + '</td><td>' + (rp + np) + '</td></tr>';
  });
  return h + '<tr class="nl-total"><td>Total</td><td>' + tF + (tT ? ' / ' + tT : "") + '</td><td>' + tR + '</td><td>' + tN + '</td><td>' + (tR + tN) + '</td></tr></tbody></table>';
}

function historySection(stats){
  const done = state.batches.filter(b => b.exitType).sort((a, b) => (b.exitDate || "").localeCompare(a.exitDate || ""));
  let h = '<p class="hint nl-toggle" data-action="history">' + (showHistory ? "Hide" : "Show") + ' trays that have left (' + done.length + ')</p>';
  if (!showHistory) return h;
  if (!done.length) return h + '<div class="empty-state">Nothing harvested or removed yet.</div>';
  const keys = Object.keys(stats).sort();
  if (keys.length){
    h += '<table class="nl-table" style="margin-bottom:14px;"><thead><tr><th>Variety</th><th>Avg days planted → harvest</th></tr></thead><tbody>' +
      keys.map(v => '<tr><td>' + esc(v) + '</td><td>' + r1(avg(stats[v])) + ' <span class="nl-n">(' + stats[v].length + ')</span></td></tr>').join("") + '</tbody></table>';
  }
  h += '<table class="nl-table"><thead><tr><th>Variety</th><th>Trays</th><th>Plants</th><th>Planted</th><th>Left</th><th>Result</th><th>Note</th>' + (isAdmin ? "<th></th>" : "") + '</tr></thead><tbody>';
  done.forEach(b => {
    h += '<tr><td>' + esc(b.variety) + '</td><td>' + b.trays + '</td><td>' + (num(b.plants) || "–") + '</td><td>' + fmt(b.plantedDate) + '</td><td>' + fmt(b.exitDate) + '</td><td>' + esc(EXIT_LABELS[b.exitType] || b.exitType) + '</td><td>' + esc(b.note || "") + '</td>' +
      (isAdmin ? '<td><button class="att-btn" data-action="undo" data-id="' + esc(b.id) + '">Undo</button></td>' : "") + '</tr>';
  });
  return h + '</tbody></table>';
}

// ---------------------------------------------------------------- modals
const $m = () => document.getElementById("l3Modal");
function openModal(html){ $m().innerHTML = html; document.getElementById("l3Overlay").classList.add("active"); const f = $m().querySelector("input,select"); if (f && f.type !== "date") setTimeout(() => f.focus(), 30); }
function closeModal(){ const o = document.getElementById("l3Overlay"); if (o) o.classList.remove("active"); }
const val = (id) => document.getElementById(id).value;

function varietyOptions(selected){
  const names = [...new Set([...state.varieties, ...state.batches.map(b => b.variety)])].sort((a, b) => a.localeCompare(b));
  return '<option value="">— Select variety —</option>' + names.map(n => '<option value="' + esc(n) + '"' + (n === selected ? " selected" : "") + '>' + esc(n) + '</option>').join("") + '<option value="__new">➕ New variety…</option>';
}
function wireVariety(){ const vs = document.getElementById("l3Variety"); vs.addEventListener("change", () => { document.getElementById("l3NewVariety").style.display = vs.value === "__new" ? "block" : "none"; }); }
function resolveVariety(){ let v = val("l3Variety"); if (v === "__new") v = val("l3NewVariety").trim(); return v; }

function openAdd(){
  openModal('<h3>Add filled trays</h3><div class="sub">Trays now holding plants on Level 3. Leave the date as today, or set when they were planted.</div>' +
    '<div class="field"><label>Variety</label><select id="l3Variety">' + varietyOptions("") + '</select><input type="text" id="l3NewVariety" placeholder="New variety name" style="display:none;margin-top:6px;"></div>' +
    '<div class="row2"><div class="field"><label>Number of trays</label><input type="number" id="l3Trays" min="1" step="1" value="1"></div>' +
    '<div class="field"><label>Plants per tray</label><input type="number" id="l3Ppt" min="0" step="1" value="' + (state.plantsPerTray || "") + '" placeholder="Optional"></div></div>' +
    '<div class="row2"><div class="field"><label>Date planted</label><input type="date" id="l3Planted" value="' + today() + '"></div>' +
    '<div class="field"><label>Status</label><select id="l3Ready"><option value="0">Not ready</option><option value="1">Ready to harvest</option></select></div></div>' +
    '<div class="modal-actions"><button class="btn" data-l3="cancel">Cancel</button><button class="btn primary" data-l3="saveAdd">Add</button></div>');
  wireVariety();
}

function saveAdd(){
  const variety = resolveVariety(), trays = parseInt(val("l3Trays"), 10), ppt = parseInt(val("l3Ppt"), 10) || 0, plantedDate = val("l3Planted") || null, ready = val("l3Ready") === "1";
  if (!variety){ alert("Pick or enter a variety."); return; }
  if (!(trays >= 1)){ alert("Enter the number of trays (1 or more)."); return; }
  const vt = num((state.varietyTrays || {})[variety]), vf = sumTrays(active().filter(b => b.variety === variety));
  if (vt && vf + trays > vt && !confirm("That puts " + variety + " at " + (vf + trays) + " of " + vt + " trays (over the total). Add anyway?")) return;
  mutate(s => {
    if (!s.varieties.some(x => x.toLowerCase() === variety.toLowerCase())) s.varieties.push(variety);
    const name = s.varieties.find(x => x.toLowerCase() === variety.toLowerCase());
    s.batches.push({ id: uid(), variety: name, trays, plants: trays * ppt, plantedDate, ready, readyDate: ready ? today() : null, exitDate: null, exitType: null, note: "" });
  }).then(ok => { if (ok) closeModal(); });
}

function openBatch(id){
  const b = state.batches.find(x => x.id === id);
  if (!b || b.exitType) return;
  const age = daysBetween(b.plantedDate, today());
  openModal('<h3>' + esc(b.variety) + ' — ' + plural(b.trays, "tray") + '</h3>' +
    '<div class="sub">' + (b.ready ? "Ready to harvest" : "Not ready") + ' · planted ' + fmt(b.plantedDate) + (age != null ? " · day " + age : "") + (b.plants ? " · " + b.plants + " plants" : "") + '</div>' +
    '<div class="row2"><div class="field"><label>Trays (status change or leaving)</label><input type="number" id="l3MoveTrays" min="1" max="' + b.trays + '" step="1" value="' + b.trays + '"></div>' +
    '<div class="field"><label>Date</label><input type="date" id="l3MoveDate" value="' + today() + '"></div></div>' +
    '<div class="field"><label>Note (optional)</label><input type="text" id="l3MoveNote" placeholder="e.g. reason if removing"></div>' +
    '<div class="nl-btnrow" data-id="' + esc(b.id) + '">' +
    (b.ready ? '<button class="btn" data-l3="setReady" data-ready="0">Mark as not ready</button>' : '<button class="btn" data-l3="setReady" data-ready="1">Mark as ready to harvest</button>') +
    '<button class="btn primary" data-l3="exit" data-type="harvested">Harvested</button><button class="btn danger" data-l3="exit" data-type="disposed">Remove / dispose</button></div>' +
    '<div class="modal-actions"><div style="display:flex;gap:6px;"><button class="btn" data-l3="edit" data-id="' + esc(b.id) + '">Edit</button><button class="btn danger" data-l3="delete" data-id="' + esc(b.id) + '">Delete entry</button></div><button class="btn" data-l3="cancel">Close</button></div>');
}

function exitBatch(id, type){
  const b = state.batches.find(x => x.id === id); if (!b) return;
  const n = parseInt(val("l3MoveTrays"), 10), date = val("l3MoveDate"), note = val("l3MoveNote").trim();
  if (!(n >= 1) || n > b.trays){ alert("Trays leaving must be between 1 and " + b.trays + "."); return; }
  if (!date){ alert("Pick a date."); return; }
  if (b.plantedDate && date < b.plantedDate){ alert("That date is before these trays were planted (" + fmt(b.plantedDate) + ")."); return; }
  if (type === "disposed" && !confirm("Remove " + plural(n, "tray") + " of " + b.variety + "?")) return;
  mutate(s => {
    const x = s.batches.find(y => y.id === id);
    const per = num(x.trays) ? num(x.plants) / num(x.trays) : 0;
    const patch = { exitType: type, exitDate: date, note };
    if (n >= x.trays){ Object.assign(x, patch); return; }
    const movedPlants = Math.round(per * n);
    x.trays -= n; x.plants = Math.max(0, num(x.plants) - movedPlants);
    s.batches.push(Object.assign({}, x, { id: uid(), trays: n, plants: movedPlants }, patch));
  }).then(ok => { if (ok) closeModal(); });
}

function setReady(id, ready){
  const b = state.batches.find(x => x.id === id); if (!b) return;
  const n = parseInt(val("l3MoveTrays"), 10), date = val("l3MoveDate") || today();
  if (!(n >= 1) || n > b.trays){ alert("Trays must be between 1 and " + b.trays + "."); return; }
  mutate(s => {
    const x = s.batches.find(y => y.id === id);
    const per = num(x.trays) ? num(x.plants) / num(x.trays) : 0;
    const patch = { ready, readyDate: ready ? date : null, tally: false };
    if (n >= x.trays){ Object.assign(x, patch); return; }
    const mp = Math.round(per * n);
    x.trays -= n; x.plants = Math.max(0, num(x.plants) - mp);
    s.batches.push(Object.assign({}, x, { id: uid(), trays: n, plants: mp }, patch));
  }).then(ok => { if (ok) closeModal(); });
}

function openEdit(id){
  const b = state.batches.find(x => x.id === id); if (!b) return;
  openModal('<h3>Edit batch</h3><div class="sub">Fix a mistake in this entry.</div>' +
    '<div class="field"><label>Variety</label><select id="l3Variety">' + varietyOptions(b.variety) + '</select><input type="text" id="l3NewVariety" placeholder="New variety name" style="display:none;margin-top:6px;"></div>' +
    '<div class="row2"><div class="field"><label>Number of trays</label><input type="number" id="l3Trays" min="1" step="1" value="' + b.trays + '"></div>' +
    '<div class="field"><label>Total plants</label><input type="number" id="l3Plants" min="0" step="1" value="' + num(b.plants) + '"></div></div>' +
    '<div class="field"><label>Date planted</label><input type="date" id="l3Planted" value="' + esc(b.plantedDate || "") + '"></div>' +
    '<div class="modal-actions"><button class="btn" data-l3="cancel">Cancel</button><button class="btn primary" data-l3="saveEdit" data-id="' + esc(id) + '">Save</button></div>');
  wireVariety();
}

function saveEdit(id){
  const variety = resolveVariety(), trays = parseInt(val("l3Trays"), 10), plants = parseInt(val("l3Plants"), 10) || 0, plantedDate = val("l3Planted") || null;
  if (!variety){ alert("Pick or enter a variety."); return; }
  if (!(trays >= 1)){ alert("Enter the number of trays."); return; }
  mutate(s => {
    if (!s.varieties.some(x => x.toLowerCase() === variety.toLowerCase())) s.varieties.push(variety);
    const b = s.batches.find(x => x.id === id);
    b.variety = s.varieties.find(x => x.toLowerCase() === variety.toLowerCase());
    b.trays = trays; b.plants = plants; b.plantedDate = plantedDate;
  }).then(ok => { if (ok) closeModal(); });
}

function openSettings(){
  const vt = state.varietyTrays || {};
  openModal('<h3>Level 3 setup</h3><div class="sub">Total trays per crop is how many trays that crop has on Level 3. Plants per tray is the default used by Quick count.</div>' +
    '<div class="field"><label>Plants per tray</label><input type="number" id="l3PptSet" min="0" step="1" value="' + (state.plantsPerTray || "") + '"></div>' +
    '<div class="nl-varlist">' + state.varieties.map((v, i) => '<div class="nl-varrow"><span>' + esc(v) + '</span><input type="number" min="0" step="1" style="width:84px;" data-vt="' + i + '" value="' + (num(vt[v]) || "") + '" placeholder="0"></div>').join("") + '</div>' +
    '<div class="modal-actions"><button class="btn" data-l3="cancel">Cancel</button><button class="btn primary" data-l3="saveSettings">Save</button></div>');
}

// ---------------------------------------------------------------- events
function onClick(e){
  const l3 = e.target.closest("[data-l3]");
  if (l3){
    const a = l3.dataset.l3;
    if (a === "cancel") return closeModal();
    if (a === "saveAdd") return saveAdd();
    if (a === "exit") return exitBatch(l3.closest("[data-id]").dataset.id, l3.dataset.type);
    if (a === "setReady") return setReady(l3.closest("[data-id]").dataset.id, l3.dataset.ready === "1");
    if (a === "edit") return openEdit(l3.dataset.id);
    if (a === "saveEdit") return saveEdit(l3.dataset.id);
    if (a === "delete"){
      if (!confirm("Delete this entry completely? (Use this only for a mistaken entry — to record trays leaving, use Harvested or Remove.)")) return;
      return mutate(s => { s.batches = s.batches.filter(x => x.id !== l3.dataset.id); }).then(ok => { if (ok) closeModal(); });
    }
    if (a === "saveSettings"){
      const p = parseInt(val("l3PptSet"), 10) || 0, vts = {};
      document.querySelectorAll("#l3Modal [data-vt]").forEach(inp => { const n = parseInt(inp.value, 10) || 0; if (n > 0) vts[state.varieties[parseInt(inp.dataset.vt, 10)]] = n; });
      return mutate(s => { s.plantsPerTray = p; s.varietyTrays = vts; }).then(ok => { if (ok) closeModal(); });
    }
    return;
  }
  if (e.target.id === "l3Overlay") return closeModal();
  const t = e.target.closest("[data-action]");
  if (!t) return;
  const a = t.dataset.action;
  if (a === "open" && isAdmin){
    const ids = (t.dataset.ids || t.dataset.id).split(",");
    if (ids.length > 1){
      const first = ids[0];
      mutate(st => {
        const keep = st.batches.find(x => x.id === first);
        ids.slice(1).forEach(id => { const o = st.batches.find(x => x.id === id); if (o){ keep.trays = num(keep.trays) + num(o.trays); keep.plants = num(keep.plants) + num(o.plants); } });
        st.batches = st.batches.filter(x => !ids.slice(1).includes(x.id));
      });
    }
    openBatch(ids[0]);
  }
  else if (a === "qadd" && isAdmin) quickAdd(parseInt(t.dataset.i, 10));
  else if (a === "qsub" && isAdmin) quickSub(parseInt(t.dataset.i, 10));
  else if (a === "qready"){ quickReady = t.dataset.ready === "1"; render(); }
  else if (a === "add") openAdd();
  else if (a === "settings") openSettings();
  else if (a === "history"){ showHistory = !showHistory; render(); }
  else if (a === "undo"){
    if (confirm("Put these trays back as filled?")) mutate(s => { const b = s.batches.find(x => x.id === t.dataset.id); b.exitType = null; b.exitDate = null; b.note = ""; });
  }
}

if (root) init();
