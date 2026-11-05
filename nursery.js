// ============================================================================
// Level 1 — Germination chamber + Nursery tray tracker (replaces the old Grow Log UI).
// Standalone module so app.js stays untouched. All data lives in ONE Firestore doc,
// meta/nurseryLog (the meta collection is already public-read / admin-write, so no
// security-rules change is needed):
//   { batches: [ { id, variety, trays, location: "germ"|"nursery", sownDate, nurseryDate,
//                  exitDate, exitType: "level1"|"level3"|"disposed"|null, note } ],
//     varieties: [names], capGerm: 24, capNursery: 56 }
// A batch that leaves the nursery keeps its record (exitType/exitDate set) so the
// history and day-count patterns can be calculated from it.
// ============================================================================
import { getApps, getApp, initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { getFirestore, doc, onSnapshot, setDoc } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const app = getApps().length ? getApp() : initializeApp(window.FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);
const REF = doc(db, "meta", "nurseryLog");

const root = document.getElementById("nurseryLogRoot");

// The farm's 11 crops, named exactly as in the existing Plant Types list.
const DEFAULT_VARIETIES = ["Perilla", "Mustard", "Sorrel", "Mizuna", "Swiss Chard", "Kale", "Ice Plant", "Red Coral Lettuce", "Crystal Green Lettuce", "Mini Red Romaine Lettuce", "Garland Chrysanthemum"];
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const EXIT_LABELS = { level1: "Level 1 (robot arm)", level3: "Level 3 (manual)", disposed: "Disposed" };

let state = { batches: [], varieties: DEFAULT_VARIETIES.slice(), capGerm: 24, capNursery: 56 };
let loaded = false, isAdmin = false, loadError = "", showLegacy = false, showHistory = false, quickLoc = "germ";

function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function toDate(s){ const p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
function toKey(d){ return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0"); }
// Night shift runs past midnight, so before 07:00 "today" is still yesterday's farm day.
function today(){ const d = new Date(); if (d.getHours() < 7) d.setDate(d.getDate() - 1); return toKey(d); }
function fmt(key){ if (!key) return "date unknown"; const d = toDate(key); return d.getDate() + " " + MONTHS[d.getMonth()]; }
function daysBetween(a, b){ if (!a || !b) return null; return Math.round((toDate(b) - toDate(a)) / 86400000); }
function plural(n, w){ return n + " " + w + (n === 1 ? "" : "s"); }
function avg(arr){ return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null; }
function r1(n){ return n == null ? "–" : (Math.round(n * 10) / 10).toString(); }

// ---------------------------------------------------------------- data
function init(){
  // The modal lives outside the re-rendered root so typing in it is never wiped by a
  // background refresh (e.g. a Firestore snapshot arriving).
  const ov = document.createElement("div");
  ov.className = "overlay"; ov.id = "nlOverlay";
  ov.innerHTML = '<div class="modal nl-modal" id="nlModal"></div>';
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
        capGerm: Number(d.capGerm) || 24,
        capNursery: Number(d.capNursery) || 56
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
const inLoc = (loc) => active().filter(b => b.location === loc);
const sumTrays = (arr) => arr.reduce((s, b) => s + (Number(b.trays) || 0), 0);

// Day-count patterns from every batch that has the dates to measure.
function computeStats(){
  const by = {};
  const get = (v) => (by[v] = by[v] || { germ: [], nursery: [], l1: 0, l3: 0, disp: 0, exited: 0 });
  state.batches.forEach(b => {
    const s = get(b.variety);
    if (b.location === "nursery" || b.exitType){
      const g = daysBetween(b.sownDate, b.nurseryDate);
      if (g != null && g >= 0) s.germ.push(g);
    }
    if (b.exitType){
      const n = daysBetween(b.nurseryDate, b.exitDate);
      if (n != null && n >= 0 && b.exitType !== "disposed") s.nursery.push(n);
      s.exited += Number(b.trays) || 0;
      if (b.exitType === "level1") s.l1 += Number(b.trays) || 0;
      if (b.exitType === "level3") s.l3 += Number(b.trays) || 0;
      if (b.exitType === "disposed") s.disp += Number(b.trays) || 0;
    }
  });
  return by;
}

// ---------------------------------------------------------------- render
function bar(used, max){
  const pct = max ? Math.min(100, Math.round(used / max * 100)) : 0;
  const cls = used >= max ? "full" : (pct >= 85 ? "high" : "");
  return '<div class="nl-bar"><div class="nl-bar-fill ' + cls + '" style="width:' + pct + '%"></div></div>';
}

function capCard(title, used, max){
  const left = max - used;
  const msg = left > 0 ? left + " free" : (left === 0 ? "Full" : (-left) + " over");
  return '<div class="nl-cap ' + (left === 0 ? "ok" : (left < 0 ? "over" : "")) + '"><div class="nl-cap-row"><span class="nl-cap-title">' + title + '</span>' +
    '<span class="nl-cap-num"><b>' + used + '</b>/' + max + '</span><span class="nl-cap-sub">' + msg + '</span></div>' + bar(used, max) + '</div>';
}

function batchCard(b, stats){
  const g = b.location === "germ";
  const startKey = g ? b.sownDate : (b.nurseryDate || b.sownDate);
  const age = startKey ? daysBetween(startKey, today()) : null;
  const st = stats[b.variety];
  const typical = st ? avg(g ? st.germ : st.nursery) : null;
  const due = age != null && typical != null && age >= Math.round(typical);
  const when = g ? ("Sown " + fmt(b.sownDate)) : (b.nurseryDate ? "In " + fmt(b.nurseryDate) : "date unknown");
  const sub = when + (age != null ? " · day " + age : "") + (typical != null ? " (typ. " + Math.round(typical) + "d)" : "");
  const tag = isAdmin ? "button" : "div";
  return '<' + tag + ' class="nl-card' + (due ? " due" : "") + '" data-action="open" data-id="' + esc(b.id) + '" data-ids="' + esc((b.ids || [b.id]).join(",")) + '">' +
    '<span class="nl-card-name">' + esc(b.variety) + '</span><span class="nl-trays">' + b.trays + '</span>' +
    '<span class="nl-card-sub">' + esc(sub) + (due ? ' <span class="nl-due">ready?</span>' : "") + '</span>' +
    '</' + tag + '>';
}

// Identical batches (same crop and dates) show as one row with the combined tray count.
function groupBatches(arr){
  const map = new Map();
  arr.forEach(b => {
    const k = [b.variety, b.sownDate || "", b.nurseryDate || ""].join("|");
    if (!map.has(k)) map.set(k, Object.assign({}, b, { ids: [b.id], trays: 0 }));
    const g = map.get(k); g.trays += Number(b.trays) || 0; if (!g.ids.includes(b.id)) g.ids.push(b.id);
  });
  return [...map.values()];
}

function sortBatches(arr){
  return arr.slice().sort((a, b) => (a.sownDate || "9999").localeCompare(b.sownDate || "9999"));
}

function blk(no,title,inner,extra){ return '<section class="nl-block"><div class="nl-bh"><span class="nl-no">'+no+'</span><span class="nl-bt">'+title+'</span>'+(extra||'')+'</div>'+inner+'</section>'; }

function render(){
  if (!root) return;
  const stats = computeStats();
  const germ = sortBatches(inLoc("germ")), nur = sortBatches(inLoc("nursery"));
  const gUsed = sumTrays(germ), nUsed = sumTrays(nur);
  let h = '<div class="section nl-root">';
  h += '<h2>Level 1 — Germination chamber &amp; Nursery</h2>';
  h += '<p class="hint">Tap a germination batch to move it to the nursery; tap a nursery batch to send it to Level 1, Level 3, or dispose.</p>';
  if (loadError) h += '<div class="kiosk-message err">Couldn\'t load: ' + esc(loadError) + '</div>';
  if (!loaded && !loadError) h += '<p class="hint">Loading…</p>';

  let capH = '<div class="nl-caps">' + capCard("Germination chamber", gUsed, state.capGerm) + capCard("Nursery", nUsed, state.capNursery) + '</div>';

  // actionable prompts only (free space is already shown in the capacity strip)
  const alerts = [];
  const gFree = state.capGerm - gUsed, nFree = state.capNursery - nUsed;
  if (loaded && gFree < 0) alerts.push("Germination is " + (-gFree) + " over capacity.");
  if (loaded && nFree < 0) alerts.push("Nursery is " + (-nFree) + " over capacity.");
  if (loaded && nFree > 0){
    const dueG = germ.filter(b => { const st = stats[b.variety]; const t = st ? avg(st.germ) : null; const a = b.sownDate ? daysBetween(b.sownDate, today()) : null; return t != null && a != null && a >= Math.round(t); });
    if (dueG.length) alerts.push("Ready to move to nursery (" + plural(nFree, "space") + " free): " + dueG.map(b => esc(b.variety) + " ×" + b.trays).join(", ") + ".");
  }
  if (alerts.length) capH += '<div class="nl-alerts">' + alerts.map(a => '<div>' + a + '</div>').join("") + '</div>';
  h += blk("01", "Capacity", capH);

  if (isAdmin){
    let act = '<div class="nl-actions"><button class="btn primary" data-action="sow">+ Sow into germination</button>' +
      '<button class="btn" data-action="existing">+ Add existing stock</button>' +
      '<button class="btn" data-action="settings">⚙ Varieties &amp; capacity</button></div>';
    h += blk("02", "Actions", act + quickCountPanel());
  }

  h += blk("03", "Germination chamber", '<div class="nl-list">' + (germ.length ? groupBatches(germ).map(b => batchCard(b, stats)).join("") : '<div class="empty-state">Empty — sow something.</div>') + '</div>', '<span class="nl-count">' + gUsed + ' / ' + state.capGerm + '</span>');
  h += blk("04", "Nursery", '<div class="nl-list">' + (nur.length ? groupBatches(nur).map(b => batchCard(b, stats)).join("") : '<div class="empty-state">Empty.</div>') + '</div>', '<span class="nl-count">' + nUsed + ' / ' + state.capNursery + '</span>');

  h += blk("05", "Tray count by variety", summaryTables(germ, nur, gUsed, nUsed));
  h += blk("06", "Patterns — from recorded dates", patternSection(stats));
  h += blk("07", "History", historySection());

  h += '<p class="nl-legacy"><button class="btn" data-action="legacy">' + (showLegacy ? "Hide" : "Show") + ' old Grow Log (hidden, nothing deleted)</button></p>';
  h += '</div>';
  root.innerHTML = h;
  const legacy = document.getElementById("legacyGrowLog");
  if (legacy) legacy.style.display = showLegacy ? "" : "none";
}

// One-tap tally: each press adds 1 tray of that crop to the chosen area, dated today.
// Taps on the same crop the same day merge into a single batch so the lists stay tidy.
function quickCountPanel(){
  const loc = quickLoc;
  const counts = {};
  inLoc(loc).forEach(b => { counts[b.variety] = (counts[b.variety] || 0) + (Number(b.trays) || 0); });
  let h = '<div class="nl-quick"><div class="nl-quick-head"><b>Quick count</b> — tap a crop for +1 tray, dated today' +
    '<span class="nl-seg"><button class="' + (loc === "germ" ? "on" : "") + '" data-action="qloc" data-loc="germ">Germination</button>' +
    '<button class="' + (loc === "nursery" ? "on" : "") + '" data-action="qloc" data-loc="nursery">Nursery</button></span></div><div class="nl-qgrid">';
  state.varieties.forEach((v, i) => {
    const n = counts[v] || 0;
    h += '<div class="nl-qc"><button class="nl-qc-add" data-action="qadd" data-i="' + i + '"><span class="nl-qc-name">' + esc(v) + '</span><span class="nl-qc-row"><span class="nl-qc-n">' + n + '</span><span class="nl-qc-plus">+1</span></span></button>' +
      '<button class="nl-qc-minus" data-action="qsub" data-i="' + i + '" title="Remove 1 tray (undo)"' + (n ? "" : " disabled") + '>−</button></div>';
  });
  return h + '</div></div>';
}

function quickAdd(i){
  const v = state.varieties[i]; if (v == null) return;
  const loc = quickLoc, t = today();
  mutate(s => {
    const key = loc === "nursery" ? "nurseryDate" : "sownDate";
    let b = s.batches.find(x => !x.exitType && x.tally && x.variety === v && x.location === loc && x[key] === t);
    if (b) b.trays = (Number(b.trays) || 0) + 1;
    else s.batches.push({ id: uid(), variety: v, trays: 1, location: loc, sownDate: loc === "germ" ? t : null, nurseryDate: loc === "nursery" ? t : null, exitDate: null, exitType: null, note: "", tally: true });
  });
}

function quickSub(i){
  const v = state.varieties[i]; if (v == null) return;
  const loc = quickLoc;
  mutate(s => {
    const key = loc === "nursery" ? "nurseryDate" : "sownDate";
    const list = s.batches.filter(x => !x.exitType && x.variety === v && x.location === loc);
    if (!list.length) return;
    // prefer today's tally batch, otherwise the most recently added one
    const b = list.find(x => x.tally && x[key] === today()) || list[list.length - 1];
    b.trays = (Number(b.trays) || 0) - 1;
    if (b.trays <= 0) s.batches = s.batches.filter(x => x.id !== b.id);
  });
}

function summaryTables(germ, nur, gUsed, nUsed){
  const names = new Set([...state.varieties, ...germ.map(b => b.variety), ...nur.map(b => b.variety)]);
  const rows = [...names].map(v => {
    const g = sumTrays(germ.filter(b => b.variety === v)), n = sumTrays(nur.filter(b => b.variety === v));
    return { v, g, n, t: g + n };
  }).filter(r => r.t > 0).sort((a, b) => b.t - a.t || a.v.localeCompare(b.v));
  let h = '';
  if (!rows.length) return h + '<div class="empty-state">No trays recorded yet.</div>';
  h += '<table class="nl-table"><thead><tr><th>Variety</th><th>Nursery (max ' + state.capNursery + ')</th><th>Germination (max ' + state.capGerm + ')</th><th>Total (max ' + (state.capNursery + state.capGerm) + ')</th></tr></thead><tbody>';
  rows.forEach(r => { h += '<tr><td>' + esc(r.v) + '</td><td>' + r.n + '</td><td>' + r.g + '</td><td>' + r.t + '</td></tr>'; });
  h += '<tr class="nl-total"><td>Total</td><td>' + nUsed + ' / ' + state.capNursery + '</td><td>' + gUsed + ' / ' + state.capGerm + '</td><td>' + (nUsed + gUsed) + ' / ' + (state.capNursery + state.capGerm) + '</td></tr></tbody></table>';
  return h;
}

function patternSection(stats){
  const rows = Object.keys(stats).filter(v => stats[v].germ.length || stats[v].nursery.length || stats[v].exited).sort();
  let h = '';
  if (!rows.length) return h + '<p class="hint">Average days will appear here once batches have dates and have moved through.</p>';
  h += '<table class="nl-table"><thead><tr><th>Variety</th><th>Avg days in germination</th><th>Avg days in nursery</th><th>→ L1</th><th>→ L3</th><th>Disposed</th></tr></thead><tbody>';
  rows.forEach(v => {
    const s = stats[v];
    h += '<tr><td>' + esc(v) + '</td><td>' + r1(avg(s.germ)) + (s.germ.length ? ' <span class="nl-n">(' + s.germ.length + ')</span>' : "") + '</td><td>' + r1(avg(s.nursery)) +
      (s.nursery.length ? ' <span class="nl-n">(' + s.nursery.length + ')</span>' : "") + '</td><td>' + s.l1 + '</td><td>' + s.l3 + '</td><td>' + s.disp + '</td></tr>';
  });
  return h + '</tbody></table>';
}

function historySection(){
  const done = state.batches.filter(b => b.exitType).sort((a, b) => (b.exitDate || "").localeCompare(a.exitDate || ""));
  let h = '<p class="hint nl-toggle" data-action="history">' + (showHistory ? "Hide" : "Show") + ' trays that have left (' + done.length + ')</p>';
  if (!showHistory) return h;
  if (!done.length) return h + '<div class="empty-state">Nothing has left the nursery yet.</div>';
  h += '<table class="nl-table"><thead><tr><th>Variety</th><th>Trays</th><th>Sown</th><th>To nursery</th><th>Left</th><th>Went to</th><th>Note</th>' + (isAdmin ? "<th></th>" : "") + '</tr></thead><tbody>';
  done.forEach(b => {
    h += '<tr><td>' + esc(b.variety) + '</td><td>' + b.trays + '</td><td>' + fmt(b.sownDate) + '</td><td>' + fmt(b.nurseryDate) + '</td><td>' + fmt(b.exitDate) +
      '</td><td>' + esc(EXIT_LABELS[b.exitType] || b.exitType) + '</td><td>' + esc(b.note || "") + '</td>' +
      (isAdmin ? '<td><button class="att-btn" data-action="undo" data-id="' + esc(b.id) + '">Undo</button></td>' : "") + '</tr>';
  });
  return h + '</tbody></table>';
}

// ---------------------------------------------------------------- modals
const $m = () => document.getElementById("nlModal");
function openModal(html){ $m().innerHTML = html; document.getElementById("nlOverlay").classList.add("active"); const f = $m().querySelector("input,select"); if (f && f.type !== "date") setTimeout(() => f.focus(), 30); }
function closeModal(){ const o = document.getElementById("nlOverlay"); if (o) o.classList.remove("active"); }
const val = (id) => document.getElementById(id).value;

function varietyOptions(selected){
  const names = [...new Set([...state.varieties, ...state.batches.map(b => b.variety)])].sort((a, b) => a.localeCompare(b));
  return '<option value="">— Select variety —</option>' + names.map(n => '<option value="' + esc(n) + '"' + (n === selected ? " selected" : "") + '>' + esc(n) + '</option>').join("") + '<option value="__new">➕ New variety…</option>';
}

function openAdd(preset){
  const nursery = preset === "nursery";
  openModal('<h3>' + (nursery ? "Add existing stock" : "Sow into germination") + '</h3>' +
    '<div class="sub">' + (nursery ? "Trays already sitting in the nursery or germination chamber. Leave dates blank if you don\'t know them." : "New sowing — the date defaults to today.") + '</div>' +
    '<div class="field"><label>Variety</label><select id="nlVariety">' + varietyOptions("") + '</select>' +
    '<input type="text" id="nlNewVariety" placeholder="New variety name" style="display:none;margin-top:6px;"></div>' +
    '<div class="field"><label>Number of trays</label><input type="number" id="nlTrays" min="1" step="1" value="1"></div>' +
    (nursery ? '<div class="field"><label>Where is it now?</label><select id="nlLoc"><option value="nursery">Nursery</option><option value="germ">Germination chamber</option></select></div>' : '<input type="hidden" id="nlLoc" value="germ">') +
    '<div class="row2"><div class="field"><label>Date sown</label><input type="date" id="nlSown" value="' + (nursery ? "" : today()) + '"></div>' +
    '<div class="field" id="nlNurseryDateWrap" style="' + (nursery ? "" : "display:none") + '"><label>Moved to nursery</label><input type="date" id="nlNurseryDate"></div></div>' +
    '<div class="modal-actions"><button class="btn" data-nl="cancel">Cancel</button><button class="btn primary" data-nl="saveAdd">Add</button></div>');
  const vs = document.getElementById("nlVariety");
  vs.addEventListener("change", () => { document.getElementById("nlNewVariety").style.display = vs.value === "__new" ? "block" : "none"; });
  const loc = document.getElementById("nlLoc");
  if (nursery) loc.addEventListener("change", () => { document.getElementById("nlNurseryDateWrap").style.display = loc.value === "nursery" ? "" : "none"; });
}

function resolveVariety(){
  let v = val("nlVariety");
  if (v === "__new") v = val("nlNewVariety").trim();
  return v;
}

function saveAdd(){
  const variety = resolveVariety();
  const trays = parseInt(val("nlTrays"), 10);
  const location = val("nlLoc");
  const sownDate = val("nlSown") || null;
  const nurseryDate = location === "nursery" ? (val("nlNurseryDate") || null) : null;
  if (!variety){ alert("Pick or enter a variety."); return; }
  if (!(trays >= 1)){ alert("Enter the number of trays (1 or more)."); return; }
  if (location === "germ" && !sownDate){ alert("Enter the date sown."); return; }
  if (nurseryDate && sownDate && nurseryDate < sownDate){ alert("Moved-to-nursery date can't be before the sown date."); return; }
  const used = sumTrays(inLoc(location)), cap = location === "germ" ? state.capGerm : state.capNursery;
  if (used + trays > cap && !confirm("That puts " + (location === "germ" ? "Germination" : "Nursery") + " at " + (used + trays) + "/" + cap + " trays (over capacity). Add anyway?")) return;
  mutate(s => {
    if (!s.varieties.some(x => x.toLowerCase() === variety.toLowerCase())) s.varieties.push(variety);
    const name = s.varieties.find(x => x.toLowerCase() === variety.toLowerCase());
    s.batches.push({ id: uid(), variety: name, trays, location, sownDate, nurseryDate, exitDate: null, exitType: null, note: "" });
  }).then(ok => { if (ok) closeModal(); });
}

function openBatch(id){
  const b = state.batches.find(x => x.id === id);
  if (!b || b.exitType) return;
  const g = b.location === "germ";
  const age = daysBetween(g ? b.sownDate : (b.nurseryDate || b.sownDate), today());
  openModal('<h3>' + esc(b.variety) + ' — ' + plural(b.trays, "tray") + '</h3>' +
    '<div class="sub">' + (g ? "In germination · sown " + fmt(b.sownDate) : "In nursery · " + (b.nurseryDate ? "since " + fmt(b.nurseryDate) : "date unknown") + " · sown " + fmt(b.sownDate)) + (age != null ? " · day " + age : "") + '</div>' +
    '<div class="row2"><div class="field"><label>Trays to move</label><input type="number" id="nlMoveTrays" min="1" max="' + b.trays + '" step="1" value="' + b.trays + '"></div>' +
    '<div class="field"><label>Date</label><input type="date" id="nlMoveDate" value="' + today() + '"></div></div>' +
    (g ? "" : '<div class="field"><label>Note (e.g. reason if disposing)</label><input type="text" id="nlMoveNote" placeholder="Optional"></div>') +
    '<div class="nl-btnrow" data-id="' + esc(b.id) + '">' +
    (g ? '<button class="btn primary" data-nl="toNursery">Transfer to Nursery →</button>' :
      '<button class="btn primary" data-nl="exit" data-type="level1">→ Level 1 (robot arm)</button>' +
      '<button class="btn primary" data-nl="exit" data-type="level3">→ Level 3 (manual)</button>' +
      '<button class="btn danger" data-nl="exit" data-type="disposed">Dispose</button>') + '</div>' +
    '<div class="modal-actions"><div style="display:flex;gap:6px;"><button class="btn" data-nl="edit" data-id="' + esc(b.id) + '">Edit</button><button class="btn danger" data-nl="delete" data-id="' + esc(b.id) + '">Delete entry</button></div>' +
    '<button class="btn" data-nl="cancel">Close</button></div>');
}

function readMove(b){
  const n = parseInt(val("nlMoveTrays"), 10), date = val("nlMoveDate");
  if (!(n >= 1) || n > b.trays){ alert("Trays to move must be between 1 and " + b.trays + "."); return null; }
  if (!date){ alert("Pick a date."); return null; }
  const start = b.location === "germ" ? b.sownDate : (b.nurseryDate || b.sownDate);
  if (start && date < start){ alert("That date is before this batch started (" + fmt(start) + ")."); return null; }
  return { n, date };
}

// Moves n trays out of batch b (splitting the batch if only some trays go) and applies
// patch to the moved portion.
function moveTrays(s, id, n, patch){
  const b = s.batches.find(x => x.id === id);
  if (n >= b.trays){ Object.assign(b, patch); return; }
  b.trays -= n;
  s.batches.push(Object.assign({}, b, { id: uid(), trays: n }, patch));
}

function toNursery(id){
  const b = state.batches.find(x => x.id === id); if (!b) return;
  const mv = readMove(b); if (!mv) return;
  const free = state.capNursery - sumTrays(inLoc("nursery"));
  if (mv.n > free && !confirm("Nursery only has " + Math.max(free, 0) + " free tray space(s). Moving " + mv.n + " puts it over capacity. Continue?")) return;
  mutate(s => moveTrays(s, id, mv.n, { location: "nursery", nurseryDate: mv.date })).then(ok => { if (ok) closeModal(); });
}

function exitBatch(id, type){
  const b = state.batches.find(x => x.id === id); if (!b) return;
  const mv = readMove(b); if (!mv) return;
  const note = (document.getElementById("nlMoveNote") || { value: "" }).value.trim();
  if (type === "disposed" && !confirm("Dispose " + plural(mv.n, "tray") + " of " + b.variety + "?")) return;
  mutate(s => moveTrays(s, id, mv.n, { exitType: type, exitDate: mv.date, note })).then(ok => { if (ok) closeModal(); });
}

function openEdit(id){
  const b = state.batches.find(x => x.id === id); if (!b) return;
  openModal('<h3>Edit batch</h3><div class="sub">Fix a mistake in this entry.</div>' +
    '<div class="field"><label>Variety</label><select id="nlVariety">' + varietyOptions(b.variety) + '</select><input type="text" id="nlNewVariety" placeholder="New variety name" style="display:none;margin-top:6px;"></div>' +
    '<div class="field"><label>Number of trays</label><input type="number" id="nlTrays" min="1" step="1" value="' + b.trays + '"></div>' +
    '<div class="row2"><div class="field"><label>Date sown</label><input type="date" id="nlSown" value="' + esc(b.sownDate || "") + '"></div>' +
    (b.location === "nursery" ? '<div class="field"><label>Moved to nursery</label><input type="date" id="nlNurseryDate" value="' + esc(b.nurseryDate || "") + '"></div>' : "") + '</div>' +
    '<div class="modal-actions"><button class="btn" data-nl="cancel">Cancel</button><button class="btn primary" data-nl="saveEdit" data-id="' + esc(id) + '">Save</button></div>');
  const vs = document.getElementById("nlVariety");
  vs.addEventListener("change", () => { document.getElementById("nlNewVariety").style.display = vs.value === "__new" ? "block" : "none"; });
}

function saveEdit(id){
  const variety = resolveVariety(), trays = parseInt(val("nlTrays"), 10);
  const sownDate = val("nlSown") || null;
  const nd = document.getElementById("nlNurseryDate");
  const nurseryDate = nd ? (nd.value || null) : undefined;
  if (!variety){ alert("Pick or enter a variety."); return; }
  if (!(trays >= 1)){ alert("Enter the number of trays."); return; }
  mutate(s => {
    if (!s.varieties.some(x => x.toLowerCase() === variety.toLowerCase())) s.varieties.push(variety);
    const b = s.batches.find(x => x.id === id);
    b.variety = s.varieties.find(x => x.toLowerCase() === variety.toLowerCase());
    b.trays = trays; b.sownDate = sownDate;
    if (nurseryDate !== undefined) b.nurseryDate = nurseryDate;
  }).then(ok => { if (ok) closeModal(); });
}

function openSettings(){
  const used = new Set(state.batches.map(b => b.variety));
  openModal('<h3>Varieties &amp; capacity</h3><div class="sub">' + state.varieties.length + ' varieties listed. A variety already used in a batch can\'t be removed.</div>' +
    '<div class="nl-varlist">' + state.varieties.map((v, i) => '<div class="nl-varrow"><span>' + esc(v) + '</span>' +
      (used.has(v) ? '<span class="nl-n">in use</span>' : '<button class="icon-btn" data-nl="rmVariety" data-i="' + i + '" title="Remove">✕</button>') + '</div>').join("") + '</div>' +
    '<div class="add-row"><input type="text" id="nlAddVariety" placeholder="Add a variety"><button data-nl="addVariety">Add</button></div>' +
    '<div class="row2" style="margin-top:12px;"><div class="field"><label>Germination capacity (trays)</label><input type="number" id="nlCapG" min="1" value="' + state.capGerm + '"></div>' +
    '<div class="field"><label>Nursery capacity (trays)</label><input type="number" id="nlCapN" min="1" value="' + state.capNursery + '"></div></div>' +
    '<div class="modal-actions"><button class="btn" data-nl="cancel">Close</button><button class="btn primary" data-nl="saveCaps">Save capacity</button></div>');
}

// ---------------------------------------------------------------- events
function onClick(e){
  const nl = e.target.closest("[data-nl]");
  if (nl){
    const a = nl.dataset.nl;
    if (a === "cancel") return closeModal();
    if (a === "saveAdd") return saveAdd();
    if (a === "toNursery") return toNursery(nl.closest("[data-id]").dataset.id);
    if (a === "exit") return exitBatch(nl.closest("[data-id]").dataset.id, nl.dataset.type);
    if (a === "edit") return openEdit(nl.dataset.id);
    if (a === "saveEdit") return saveEdit(nl.dataset.id);
    if (a === "delete"){
      if (!confirm("Delete this entry completely? (Use this only for a mistaken entry — to record trays leaving, use the transfer buttons.)")) return;
      return mutate(s => { s.batches = s.batches.filter(x => x.id !== nl.dataset.id); }).then(ok => { if (ok) closeModal(); });
    }
    if (a === "addVariety"){
      const v = val("nlAddVariety").trim(); if (!v) return;
      if (state.varieties.some(x => x.toLowerCase() === v.toLowerCase())) return alert("That variety is already listed.");
      return mutate(s => { s.varieties.push(v); }).then(() => openSettings());
    }
    if (a === "rmVariety") return mutate(s => { s.varieties.splice(parseInt(nl.dataset.i, 10), 1); }).then(() => openSettings());
    if (a === "saveCaps"){
      const g = parseInt(val("nlCapG"), 10), n = parseInt(val("nlCapN"), 10);
      if (!(g >= 1) || !(n >= 1)) return alert("Enter valid capacities.");
      return mutate(s => { s.capGerm = g; s.capNursery = n; }).then(ok => { if (ok) closeModal(); });
    }
    return;
  }
  if (e.target.id === "nlOverlay") return closeModal();
  const t = e.target.closest("[data-action]");
  if (!t) return;
  const a = t.dataset.action;
  if (a === "open" && isAdmin){
    const ids = (t.dataset.ids || t.dataset.id).split(",");
    if (ids.length > 1){
      const first = ids[0];
      mutate(st => {
        const keep = st.batches.find(x => x.id === first);
        ids.slice(1).forEach(id => { const o = st.batches.find(x => x.id === id); if (o){ keep.trays = (Number(keep.trays) || 0) + (Number(o.trays) || 0); } });
        st.batches = st.batches.filter(x => !ids.slice(1).includes(x.id));
      });
    }
    openBatch(ids[0]);
  }
  else if (a === "qadd" && isAdmin) quickAdd(parseInt(t.dataset.i, 10));
  else if (a === "qsub" && isAdmin) quickSub(parseInt(t.dataset.i, 10));
  else if (a === "qloc"){ quickLoc = t.dataset.loc; render(); }
  else if (a === "sow") openAdd("germ");
  else if (a === "existing") openAdd("nursery");
  else if (a === "settings") openSettings();
  else if (a === "history"){ showHistory = !showHistory; render(); }
  else if (a === "legacy"){ showLegacy = !showLegacy; render(); }
  else if (a === "undo"){
    if (confirm("Put this batch back where it was before it left?")) mutate(s => { const b = s.batches.find(x => x.id === t.dataset.id); b.exitType = null; b.exitDate = null; b.note = ""; });
  }
}

if (root) init();
