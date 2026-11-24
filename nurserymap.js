// ============================================================================
// Level 1 — Nursery tray map. 4 tiers x 14 trays, shown right to left (14 ... 1),
// tier 1 at the bottom. One Firestore doc: meta/nurseryMap
//   { trays: { "T2-7": { date: "<seeded>", crop?: "<other crop>", plants?: n } },
//     history: [ { k, crop, plants, date, exitType: "level1"|"level3"|"disposed", exitDate, note } ],
//     log: [ { t, by, a, ... } ] }
// A tray holds up to 100 plants. Mounted into the slot nursery.js leaves (#nmSlot).
// ============================================================================
import { getApps, getApp, initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { getFirestore, doc, onSnapshot, setDoc } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const app = getApps().length ? getApp() : initializeApp(window.FIREBASE_CONFIG);
const auth = getAuth(app), db = getFirestore(app);
const REF = doc(db, "meta", "nurseryMap");

const POS = 14, PPT = 100;
const TIERS = [4, 3, 2, 1];                       // top to bottom
const TIER_CROP = { 1: "Swiss Chard", 2: "Mustard", 3: "Crystal Green Lettuce", 4: "Mini Red Romaine Lettuce" };
const CROPS = ["Perilla", "Mustard", "Sorrel", "Mizuna", "Swiss Chard", "Kale", "Ice Plant", "Red Coral Lettuce", "Crystal Green Lettuce", "Mini Red Romaine Lettuce", "Garland Chrysanthemum"];
const SHORT = { "Mini Red Romaine Lettuce": "Red Romaine", "Crystal Green Lettuce": "Crystal Green", "Red Coral Lettuce": "Red Coral", "Garland Chrysanthemum": "Garland", "Swiss Chard": "Swiss Chard" };
const EXIT = { level1: { word: "Sent to Level 1", btn: "To Level 1 (robot arm)", cls: "tp" }, level3: { word: "Sent to Level 3", btn: "To Level 3 (manual)", cls: "hv" }, disposed: { word: "Disposed", btn: "Dispose", cls: "dp" } };
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

let state = { trays: {}, history: [], log: [] };
const fltCrops = new Set();
let loaded = false, isAdmin = false, loadError = "", last = null, logN = 20, logWho = "all", showLog = false;

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));
const toDate = (s) => { const p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); };
const toKey = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
function today(){ const d = new Date(); if (d.getHours() < 7) d.setDate(d.getDate() - 1); return toKey(d); }
const fmtShort = (k) => { if (!k) return ""; const d = toDate(k); return d.getDate() + " " + MONTHS[d.getMonth()]; };
const fmtFull = (k) => { if (!k) return "No date"; const d = toDate(k); return d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear(); };
const daysBetween = (a, b) => (a && b) ? Math.round((toDate(b) - toDate(a)) / 86400000) : null;
const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");

const keyOf = (t, p) => "T" + t + "-" + p;
const parseKey = (k) => { const m = /^T(\d)-(\d+)$/.exec(k); return m ? { t: +m[1], p: +m[2] } : null; };
const label = (k) => { const q = parseKey(k); return q ? "T" + q.t + " #" + q.p : k; };
const cropOf = (k, trays) => { const q = parseKey(k); const tr = (trays || state.trays)[k]; return (tr && tr.crop) || (q ? TIER_CROP[q.t] : ""); };
const plOf = (tr) => (tr && Number(tr.plants) > 0) ? Number(tr.plants) : PPT;
function summarize(keys){
  const by = {}; keys.forEach(k => { const q = parseKey(k); if (q) (by[q.t] = by[q.t] || []).push(q.p); });
  return Object.keys(by).sort((a, b) => b - a).map(t => { const ps = by[t].sort((a, b) => a - b); const out = []; let i = 0; while (i < ps.length){ let j = i; while (j + 1 < ps.length && ps[j + 1] === ps[j] + 1) j++; out.push(j > i ? ps[i] + "–" + ps[j] : "" + ps[i]); i = j + 1; } return "T" + t + " #" + out.join(", "); }).join(" · ");
}

const whoName = (u) => { const e = String((u && u.email) || "").toLowerCase(); if (e === "omegapeanut@gmail.com") return "YS"; if (e.includes("hasan")) return "Hasan"; if (e.includes("meraj")) return "Meraj"; const n = e.split("@")[0].replace(/[^a-z0-9]+/g, " ").trim(); return n ? n.charAt(0).toUpperCase() + n.slice(1) : "Unknown"; };
const AV = { YS: "#35473a", Hasan: "#2f7f86", Meraj: "#8a5a2b" };
const avCol = (n) => AV[n] || "#6b5bb0";

// ---------------------------------------------------------------- mounting
const mapEl = document.createElement("div");
mapEl.className = "nm-root";
function mount(){ const slot = document.getElementById("nmSlot"); if (slot && mapEl.parentNode !== slot){ slot.appendChild(mapEl); } }
window.addEventListener("nm-slot", mount);

const STYLE = `
.nm-root .l3m-cell var.nd{display:block;font-style:normal;font-size:9px;font-weight:800;line-height:1;color:#fff;background:#2f7f86;border-radius:5px;padding:2px 4px}
.nm-root .l3m-rack{margin-top:6px}
.nm-note{font-size:12.5px;opacity:.75;margin:2px 0 10px}
.nm-cells{display:grid;gap:4px}
.nm-hist-tog{cursor:pointer}
`;

// ---------------------------------------------------------------- logging (who did what)
function logDiff(prev, next, by){
  const now = new Date().toISOString(), out = [];
  const mk = (a, o) => Object.assign({ t: now, by, a }, o);
  const sig = (tr, k, trays) => tr.date + "|" + cropOf(k, trays);
  const newHist = (next.history || []).slice((prev.history || []).length), exited = new Set(newHist.map(x => x.k));
  const hg = {};
  newHist.forEach(x => { const id = x.exitType + "|" + x.crop; const g = (hg[id] = hg[id] || { a: x.exitType, crop: x.crop, keys: [], plants: 0, partial: false }); if (!g.keys.includes(x.k)) g.keys.push(x.k); g.plants += x.plants || 0; if (/^partial/.test(x.note || "")) g.partial = true; });
  Object.values(hg).forEach(g => out.push(mk(g.a, { crop: g.crop, keys: g.keys, plants: g.plants, partial: g.partial })));
  const pk = Object.keys(prev.trays), nk = Object.keys(next.trays);
  const added = nk.filter(k => !prev.trays[k]), removed = pk.filter(k => !next.trays[k] && !exited.has(k));
  const changed = pk.filter(k => next.trays[k] && JSON.stringify(prev.trays[k]) !== JSON.stringify(next.trays[k]) && !exited.has(k));
  const moves = [], usedA = new Set(), usedR = new Set(), usedC = new Set();
  removed.forEach(r => { const sg = sig(prev.trays[r], r, prev.trays); const a = added.find(x => !usedA.has(x) && sig(next.trays[x], x, next.trays) === sg); if (a){ usedA.add(a); usedR.add(r); moves.push({ from: r, to: a, crop: cropOf(r, prev.trays) }); } });
  changed.forEach(x => { if (usedC.has(x)) return; const y = changed.find(z => z !== x && !usedC.has(z) && sig(next.trays[x], x, next.trays) === sig(prev.trays[z], z, prev.trays) && sig(next.trays[z], z, next.trays) === sig(prev.trays[x], x, prev.trays) && sig(prev.trays[x], x, prev.trays) !== sig(prev.trays[z], z, prev.trays)); if (y){ usedC.add(x); usedC.add(y); moves.push({ from: x, to: y, crop: cropOf(x, prev.trays), swap: cropOf(y, prev.trays) }); } });
  if (moves.length) out.push(mk("shift", { mv: moves }));
  const tg = {};
  added.filter(k => !usedA.has(k)).forEach(k => { const c = cropOf(k, next.trays), tr = next.trays[k], id = c + "|" + tr.date; const g = (tg[id] = tg[id] || { crop: c, date: tr.date, keys: [], plants: 0 }); g.keys.push(k); g.plants += plOf(tr); });
  Object.values(tg).forEach(g => out.push(mk("seed", { crop: g.crop, keys: g.keys, plants: g.plants, date: g.date })));
  const rm = removed.filter(k => !usedR.has(k));
  if (rm.length) out.push(mk("remove", { keys: rm, plants: rm.reduce((a, k) => a + plOf(prev.trays[k]), 0) }));
  const ed = changed.filter(k => !usedC.has(k));
  if (ed.length){
    const chg = (k) => {
      const a = prev.trays[k], b = next.trays[k], ca = cropOf(k, prev.trays), cb = cropOf(k, next.trays), f = [];
      if (a.date !== b.date) f.push("Date seeded " + fmtShort(a.date) + " → " + fmtShort(b.date));
      if (ca !== cb) f.push("Crop " + ca + " → " + cb);
      if (plOf(a) !== plOf(b)) f.push("Plants " + plOf(a) + " → " + plOf(b));
      return { k, c: f };
    };
    out.push(mk("edit", { keys: ed, ch: ed.map(chg) }));
  }
  return out;
}
const ACT = {
  seed: { word: "Seeded", cls: "tp", icon: "＋" }, level1: { word: "To Level 1", cls: "tp", icon: "→" }, level3: { word: "To Level 3", cls: "hv", icon: "→" },
  disposed: { word: "Disposed", cls: "dp", icon: "✕" }, shift: { word: "Shifted", cls: "sh", icon: "⇄" }, edit: { word: "Edited", cls: "ed", icon: "✎" }, remove: { word: "Cleared", cls: "rm", icon: "−" }
};
function logLine(e){
  const n = (e.keys || []).length, tr = n === 1 ? "1 tray" : n + " trays", crop = e.crop ? "<b>" + esc(e.crop) + "</b>" : "";
  if (e.a === "seed") return { head: "Seeded " + tr + (e.crop ? " of " + crop : ""), sub: esc(summarize(e.keys)) + " · " + (e.plants || 0) + " plants · seeded " + esc(fmtFull(e.date)) };
  if (e.a === "level1" || e.a === "level3" || e.a === "disposed"){
    const w = e.a === "disposed" ? "Disposed" : e.a === "level1" ? "Sent to Level 1:" : "Sent to Level 3:";
    return { head: w + " <b>" + (e.plants || 0) + "</b> plants" + (e.crop ? " of " + crop : ""), sub: esc(summarize(e.keys)) + (e.partial ? " · partial, balance stays in tray" : " · " + tr) };
  }
  if (e.a === "shift"){
    const mv = e.mv || [], one = (m) => m.swap ? "<b>" + esc(label(m.from)) + "</b> ⇄ <b>" + esc(label(m.to)) + "</b> (" + esc(m.crop) + " ⇄ " + esc(m.swap) + ")" : "<b>" + esc(label(m.from)) + "</b> → <b>" + esc(label(m.to)) + "</b> (" + esc(m.crop) + ")";
    return { head: mv.length === 1 ? (mv[0].swap ? "Swapped two trays" : "Shifted " + esc(mv[0].crop) + " to another tray") : "Shifted " + mv.length + " trays", sub: mv.slice(0, 6).map(one).join(" · ") };
  }
  if (e.a === "edit"){
    const ch = (e.ch || []).filter(x => x.c && x.c.length);
    if (!ch.length) return { head: "Edited details of " + tr, sub: esc(summarize(e.keys)) };
    const one = (x) => "<b>" + esc(label(x.k)) + "</b> — " + x.c.map(esc).join(" · ");
    return { head: "Edited " + tr, sub: ch.slice(0, 6).map(one).join("<br>") + (ch.length > 6 ? "<br>+" + (ch.length - 6) + " more" : "") };
  }
  return { head: "Cleared " + tr + " (mistaken entry)", sub: esc(summarize(e.keys)) };
}
function logTime(iso){
  const d = new Date(iso); if (isNaN(d)) return { day: "", clock: "", rel: "" };
  const sd = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(), diff = Math.round((sd(new Date()) - sd(d)) / 86400000);
  const m = Math.floor((Date.now() - d.getTime()) / 60000);
  return { day: diff === 0 ? "Today" : diff === 1 ? "Yesterday" : fmtFull(toKey(d)), clock: String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"), rel: m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.floor(m / 60) + " h ago" : diff + " d ago" };
}
function logHtml(){
  const all = state.log || [];
  if (!all.length) return '<p class="hint">No actions recorded yet. Every seeding, move-out, dispose and shift will be listed here with the name of the person who did it.</p>';
  const who = {}; all.forEach(e => { who[e.by] = (who[e.by] || 0) + 1; });
  const names = Object.keys(who).sort((a, b) => who[b] - who[a]);
  const list = logWho === "all" ? all : all.filter(e => e.by === logWho), shown = list.slice(0, logN);
  let h = '<div class="al-chips"><button class="al-chip' + (logWho === "all" ? " on" : "") + '" data-action="who" data-who="all">Everyone <small>' + all.length + '</small></button>' +
    names.map(n => '<button class="al-chip' + (logWho === n ? " on" : "") + '" data-action="who" data-who="' + esc(n) + '"><i style="background:' + avCol(n) + '">' + esc(n.charAt(0)) + '</i>' + esc(n) + ' <small>' + who[n] + '</small></button>').join("") + '</div><div class="al-list">';
  let lastDay = "";
  shown.forEach(e => {
    const L = logLine(e), T = logTime(e.t), A = ACT[e.a] || ACT.edit;
    if (T.day !== lastDay){ h += '<div class="al-day">' + esc(T.day) + '</div>'; lastDay = T.day; }
    h += '<div class="al-row"><span class="al-av" style="background:' + avCol(e.by) + '">' + esc(String(e.by || "?").charAt(0)) + '</span><div class="al-mid"><div class="al-top"><span class="al-by">' + esc(e.by || "Unknown") + '</span><span class="al-bd ' + A.cls + '">' + A.icon + ' ' + A.word + '</span></div><div class="al-hd">' + L.head + '</div><div class="al-sub">' + L.sub + '</div></div><div class="al-tm"><b>' + T.clock + '</b><span>' + T.rel + '</span></div></div>';
  });
  return h + '</div><div class="al-foot">Showing ' + shown.length + ' of ' + list.length + ' actions' + (list.length > shown.length ? '<button class="btn" data-action="more">Show more actions</button>' : '') + '</div>';
}

// ---------------------------------------------------------------- data
async function mutate(fn){
  if (!isAdmin){ alert("Log in as admin to make changes."); return false; }
  if (!loaded){ alert("Still loading — try again in a moment."); return false; }
  last = clone(state);
  const next = clone(state);
  fn(next);
  try { const ents = logDiff(state, next, whoName(auth.currentUser)); if (ents.length) next.log = ents.concat(next.log || []).slice(0, 600); } catch (err){ console.warn("log", err); }
  state = next; publish(); render();
  try { await setDoc(REF, next); return true; }
  catch (e){ alert("Couldn't save: " + e.message); return false; }
}
async function undo(){
  if (!last || !confirm("Undo the last change?")) return;
  const prev = last; last = null; state = prev; publish(); render();
  try { await setDoc(REF, prev); } catch (e){ alert("Couldn't save: " + e.message); }
}
function publish(){ window.NM_LIST = Object.keys(state.trays).map(k => cropOf(k)); window.NM_USED = window.NM_LIST.length; window.dispatchEvent(new Event("nm-used")); }

// ---------------------------------------------------------------- rendering
function cellHtml(t, p){
  const k = keyOf(t, p), tr = state.trays[k];
  const fo = fltCrops.size > 0, hit = fo && tr && fltCrops.has(cropOf(k));
  const fc = fo ? (hit ? " hl" : " dim") : "";
  if (!tr) return '<button type="button" class="l3m-cell' + fc + '" data-action="cell" data-k="' + k + '" title="' + esc("T" + t + " #" + p + " · " + TIER_CROP[t] + " · empty") + '"><span class="tp"></span><b>' + p + '</b><i>&nbsp;</i><span class="ft"></span></button>';
  const crop = cropOf(k), off = crop !== TIER_CROP[t], age = daysBetween(tr.date, today()), pl = plOf(tr);
  const title = "T" + t + " #" + p + " · " + crop + (off ? " (not this tier's crop)" : "") + " · seeded " + fmtFull(tr.date) + (age != null ? " (" + age + " days ago)" : "") + " · " + pl + " plants";
  return '<button type="button" class="l3m-cell ready' + (off ? " off" : "") + fc + '" data-action="cell" data-k="' + k + '" title="' + esc(title) + '"><span class="tp">' + (pl !== PPT ? '<em>' + pl + '</em>' : "") + '</span><b>' + p + '</b><i>' + esc(fmtShort(tr.date)) + '</i><span class="ft">' + (off ? '<s class="cr">' + esc(SHORT[crop] || crop) + '</s>' : "") + (age != null && age >= 0 ? '<var class="nd">' + age + 'd</var>' : "") + '</span></button>';
}
function cropPanel(){
  const n = {}, tierN = {}; let plants = 0, total = 0;
  Object.keys(state.trays).forEach(k => { const c = cropOf(k); n[c] = (n[c] || 0) + 1; if (fltCrops.has(c)){ total++; plants += plOf(state.trays[k]); const q = parseKey(k); tierN[q.t] = (tierN[q.t] || 0) + 1; } });
  const names = [...TIERS.map(t => TIER_CROP[t]), ...CROPS.filter(c => !TIERS.some(t => TIER_CROP[t] === c) && ((n[c] || 0) > 0 || fltCrops.has(c)))];
  const chip = (c) => '<button class="flt-chip' + (fltCrops.has(c) ? " on" : "") + '" data-action="fltCrop" data-c="' + esc(c) + '" aria-pressed="' + (fltCrops.has(c) ? "true" : "false") + '">' + esc(c) + '<b>' + (n[c] || 0) + '</b></button>';
  let h = '<div class="flt-croprow"><span class="flt-lbl">Crop</span>' + names.map(chip).join("") + (fltCrops.size ? '<button class="flt-clear" data-action="fltCropClear">Clear crops</button>' : '') + '</div>';
  if (fltCrops.size){
    const tiers = TIERS.filter(t => tierN[t]).map(t => "T" + t + " " + tierN[t]).join(" · ");
    h += '<div class="flt-total"><div class="flt-num"><b>' + total + '</b><span>' + (total === 1 ? "tray" : "trays") + ' highlighted</span></div><div class="flt-det"><div>' + esc([...fltCrops].join(" + ")) + '</div><div>' + (tiers ? tiers + ' · ' : '') + plants + ' plants in these trays</div></div></div>';
  }
  return h;
}
function render(){
  const used = Object.keys(state.trays).length, plants = Object.values(state.trays).reduce((s, x) => s + plOf(x), 0);
  let h = '<section class="nl-block"><div class="nl-bh"><span class="nl-no">03</span><span class="nl-bt">Nursery — tray map</span><span class="nl-count">' + used + ' / ' + (TIERS.length * POS) + ' trays · ' + plants + ' plants</span></div>';
  if (loadError) h += '<div class="kiosk-message err">Couldn\'t load: ' + esc(loadError) + '</div>';
  if (!loaded && !loadError) h += '<p class="hint">Loading…</p>';
  h += '<p class="nm-note">4 tiers, 14 trays each, shown right to left (14 … 1) with tier 1 at the bottom. One tray holds up to ' + PPT + ' plants. Each tray shows the date it was seeded for germination and how many days ago.' + (isAdmin ? ' Tap a tray to seed or change it; press and hold a tray, then drop it on another slot to shift it.' : '') + '</p>';
  if (isAdmin && last) h += '<div class="nl-actions"><button class="btn" data-action="undo">Undo last change</button></div>';
  h += cropPanel();
  h += '<div class="l3m-leg"><span><u></u>Empty</span><span><u style="background:var(--sage,#d3dccf)"></u>Seeded</span><span><u style="background:#f7d9a6;border-color:#d4871c"></u>Not this tier\'s crop</span><span><u style="background:#2f7f86"></u>Days since seeded</span></div>';
  h += '<div class="l3m-rack' + (fltCrops.size ? ' filtering' : '') + '"><div class="l3m-scroll ' + (isAdmin ? "l3m-adm" : "") + '">';
  TIERS.forEach(t => {
    let u = 0; for (let p = 1; p <= POS; p++) if (state.trays[keyOf(t, p)]) u++;
    h += '<div class="l3m-tier"><div class="l3m-th"><span class="t">T' + t + '</span><span class="c">' + esc(TIER_CROP[t]) + '</span><span class="n">' + u + '/' + POS + ' · ' + (POS - u) + ' free</span>' + (isAdmin && u < POS ? '<button class="btn" data-action="seedTier" data-t="' + t + '">+ Seed trays</button>' : '') + '</div>' +
      '<div class="l3m-cells" style="grid-template-columns:repeat(' + POS + ',minmax(40px,1fr));">';
    for (let p = POS; p >= 1; p--) h += cellHtml(t, p);
    h += '</div></div>';
  });
  h += '</div></div></section>';
  const n = (state.log || []).length;
  h += '<section class="nl-block"><div class="nl-bh nm-hist-tog" data-action="log" style="cursor:pointer;"><span class="nl-no">03a</span><span class="nl-bt">Nursery action history</span><span class="nl-count">' + plural(n, "action") + ' · ' + (showLog ? "Hide ▴" : "Show ▾") + '</span></div>' + (showLog ? logHtml() : "") + '</section>';
  mapEl.innerHTML = h;
}

// ---------------------------------------------------------------- modals
let ov;
function openModal(html){ ov.querySelector(".modal").innerHTML = html; ov.classList.add("active"); }
function closeModal(){ ov.classList.remove("active"); }
const val = (id) => document.getElementById(id).value;
const cropSel = (cur) => '<select id="nmCrop">' + CROPS.map(c => '<option' + (c === cur ? " selected" : "") + '>' + esc(c) + '</option>').join("") + '</select>';
const plantsInput = (v) => '<input type="number" inputmode="numeric" id="nmPl" min="1" max="' + PPT + '" value="' + v + '">';

function openTray(k){
  const q = parseKey(k), tr = state.trays[k], tierCrop = TIER_CROP[q.t], head = '<h3>' + label(k) + ' · ' + esc(tr ? cropOf(k) : tierCrop) + '</h3>';
  if (!tr){
    openModal(head + '<div class="sub">Empty tray, tier ' + q.t + ' (' + esc(tierCrop) + '), position ' + q.p + '.</div>' +
      '<div class="row2"><div class="field"><label>Date seeded</label><input type="date" id="nmDate" value="' + today() + '"></div><div class="field"><label>Plants (max ' + PPT + ')</label>' + plantsInput(PPT) + '</div></div>' +
      '<div class="field"><label>Crop</label>' + cropSel(tierCrop) + '</div>' +
      '<div class="modal-actions"><button class="btn" data-m="cancel">Cancel</button><button class="btn primary" data-m="save" data-k="' + k + '">Seed tray</button></div>');
    return;
  }
  const crop = cropOf(k), age = daysBetween(tr.date, today());
  openModal(head + '<div class="sub">Seeded ' + esc(fmtFull(tr.date)) + (age != null ? ' · ' + age + ' days ago' : '') + ' · ' + plOf(tr) + ' plants.</div>' +
    '<div class="row2"><div class="field"><label>Date seeded</label><input type="date" id="nmDate" value="' + esc(tr.date) + '"></div><div class="field"><label>Plants (max ' + PPT + ')</label>' + plantsInput(plOf(tr)) + '</div></div>' +
    '<div class="field"><label>Crop</label>' + cropSel(crop) + '</div>' +
    '<div class="modal-actions" style="margin-top:6px;"><button class="btn" data-m="cancel">Close</button><button class="btn primary" data-m="save" data-k="' + k + '">Save changes</button></div>' +
    '<hr style="border:0;border-top:1px solid #e3ddd5;margin:14px 0 10px;">' +
    '<div class="field"><label>Plants moving out or disposed (blank = whole tray, ' + plOf(tr) + ')</label><input type="number" inputmode="numeric" id="nmOut" min="1" max="' + plOf(tr) + '" placeholder="' + plOf(tr) + '"></div>' +
    '<div class="nl-btnrow"><button class="btn primary" data-m="exit" data-kind="level1" data-k="' + k + '">' + EXIT.level1.btn + '</button><button class="btn primary" data-m="exit" data-kind="level3" data-k="' + k + '">' + EXIT.level3.btn + '</button><button class="btn danger" data-m="exit" data-kind="disposed" data-k="' + k + '">' + EXIT.disposed.btn + '</button><button class="btn danger" data-m="wipe" data-k="' + k + '" style="font-size:12px;opacity:.8;">Remove entry (mistake, not recorded)</button></div>');
}
function saveTray(k){
  const date = val("nmDate"), pl = Math.round(Number(val("nmPl"))), crop = val("nmCrop"), q = parseKey(k);
  if (!date){ alert("Pick the date it was seeded."); return; }
  if (!(pl >= 1 && pl <= PPT)){ alert("Plants must be between 1 and " + PPT + "."); return; }
  mutate(s => { const t = { date }; if (crop !== TIER_CROP[q.t]) t.crop = crop; if (pl !== PPT) t.plants = pl; s.trays[k] = t; }).then(ok => { if (ok) closeModal(); });
}
function exitTray(k, kind){
  const tr = state.trays[k]; if (!tr) return;
  const have = plOf(tr), raw = val("nmOut").trim(), out = raw === "" ? have : Math.round(Number(raw));
  if (!(out >= 1 && out <= have)){ alert("Enter a number from 1 to " + have + ", or leave it blank for the whole tray."); return; }
  const crop = cropOf(k);
  if (!confirm(EXIT[kind].word + ": " + out + " of " + have + " plants from " + label(k) + "?" + (out < have ? " " + (have - out) + " stay in the tray." : ""))) return;
  mutate(s => {
    const t = s.trays[k]; if (!t) return;
    const base = { k, crop, plants: out, date: t.date, exitType: kind, exitDate: today(), note: out < have ? "partial (" + out + " of " + have + ")" : "" };
    s.history.push(base);
    if (out >= have) delete s.trays[k]; else t.plants = have - out;
  }).then(ok => { if (ok) closeModal(); });
}
function openSeedTier(t){
  const free = []; for (let p = 1; p <= POS; p++) if (!state.trays[keyOf(t, p)]) free.push(p);
  openModal('<h3>Seed trays · T' + t + ' · ' + esc(TIER_CROP[t]) + '</h3><div class="sub">' + free.length + ' free trays. Trays are filled from the lowest free number upwards.</div>' +
    '<div class="row2"><div class="field"><label>How many trays</label><input type="number" inputmode="numeric" id="nmN" min="1" max="' + free.length + '" value="1"></div><div class="field"><label>Plants per tray (max ' + PPT + ')</label>' + plantsInput(PPT) + '</div></div>' +
    '<div class="field"><label>Date seeded</label><input type="date" id="nmDate" value="' + today() + '"></div>' +
    '<div class="modal-actions"><button class="btn" data-m="cancel">Cancel</button><button class="btn primary" data-m="seedTier" data-t="' + t + '">Seed</button></div>');
}
function doSeedTier(t){
  const n = Math.round(Number(val("nmN"))), pl = Math.round(Number(val("nmPl"))), date = val("nmDate");
  const free = []; for (let p = 1; p <= POS; p++) if (!state.trays[keyOf(t, p)]) free.push(p);
  if (!date){ alert("Pick the date it was seeded."); return; }
  if (!(n >= 1 && n <= free.length)){ alert("Choose 1 to " + free.length + " trays."); return; }
  if (!(pl >= 1 && pl <= PPT)){ alert("Plants must be between 1 and " + PPT + "."); return; }
  mutate(s => { free.slice(0, n).forEach(p => { const tr = { date }; if (pl !== PPT) tr.plants = pl; s.trays[keyOf(t, p)] = tr; }); }).then(ok => { if (ok) closeModal(); });
}

// ---------------------------------------------------------------- events
let suppressClick = 0;
function onClick(e){
  const m = e.target.closest("[data-m]");
  if (m){
    const a = m.dataset.m;
    if (a === "cancel") return closeModal();
    if (a === "save") return saveTray(m.dataset.k);
    if (a === "exit") return exitTray(m.dataset.k, m.dataset.kind);
    if (a === "seedTier") return doSeedTier(+m.dataset.t);
    if (a === "wipe"){ if (!confirm("Empty this tray without recording it in the history? Use this for a mistaken entry.")) return; return mutate(s => { delete s.trays[m.dataset.k]; }).then(ok => { if (ok) closeModal(); }); }
    return;
  }
  if (e.target === ov) return closeModal();
  const t = e.target.closest("[data-action]"); if (!t) return;
  const a = t.dataset.action;
  if (a === "cell"){ if (!isAdmin || Date.now() - suppressClick < 400 || t.classList.contains("dim")) return; openTray(t.dataset.k); }
  else if (a === "seedTier" && isAdmin) openSeedTier(+t.dataset.t);
  else if (a === "fltCrop"){ const c = t.dataset.c; if (fltCrops.has(c)) fltCrops.delete(c); else fltCrops.add(c); render(); }
  else if (a === "fltCropClear"){ fltCrops.clear(); render(); }
  else if (a === "undo") undo();
  else if (a === "log"){ showLog = !showLog; render(); }
  else if (a === "more"){ logN += 20; render(); }
  else if (a === "who"){ logWho = t.dataset.who || "all"; logN = 20; render(); }
}

// press-and-hold to drag a tray to another slot
const HOLD_MS = 450;
let dnd = null;
const cellAt = (x, y) => { const el = document.elementFromPoint(x, y); return el ? el.closest('.l3m-cell[data-k]') : null; };
function dndClear(){ if (!dnd) return; clearTimeout(dnd.timer); if (dnd.ghost) dnd.ghost.remove(); if (dnd.src) dnd.src.classList.remove("lp"); if (dnd.over) dnd.over.classList.remove("drop"); dnd = null; }
function dndStart(e){
  if (!isAdmin || (e.pointerType === "mouse" && e.button !== 0)) return;
  const cell = e.target.closest('.l3m-cell[data-k]'); if (!cell || !mapEl.contains(cell) || cell.classList.contains('dim')) return;
  const k = cell.dataset.k; if (!state.trays[k]) return;
  dnd = { k, src: cell, x: e.clientX, y: e.clientY, active: false, over: null, ghost: null };
  dnd.timer = setTimeout(() => {
    if (!dnd) return; dnd.active = true; cell.classList.add("lp");
    const g = document.createElement("div"); g.className = "l3m-ghost"; g.textContent = "Move " + label(k) + " · " + cropOf(k); g.style.left = dnd.x + "px"; g.style.top = dnd.y + "px"; document.body.appendChild(g); dnd.ghost = g;
    if (navigator.vibrate) navigator.vibrate(30);
  }, HOLD_MS);
}
function dndMove(e){
  if (!dnd) return;
  if (!dnd.active){ if (Math.abs(e.clientX - dnd.x) > 10 || Math.abs(e.clientY - dnd.y) > 10) dndClear(); return; }
  dnd.x = e.clientX; dnd.y = e.clientY; dnd.ghost.style.left = e.clientX + "px"; dnd.ghost.style.top = e.clientY + "px";
  const c = cellAt(e.clientX, e.clientY);
  if (dnd.over && dnd.over !== c) dnd.over.classList.remove("drop");
  dnd.over = c && c !== dnd.src ? c : null; if (dnd.over) dnd.over.classList.add("drop");
  if (e.clientY < 70) window.scrollBy(0, -14); else if (e.clientY > window.innerHeight - 70) window.scrollBy(0, 14);
}
function moveTray(from, to){
  const tf = parseKey(from).t, tt = parseKey(to).t;
  mutate(s => {
    const a = s.trays[from], b = s.trays[to]; if (!a) return;
    const ca = cropOf(from, s.trays), cb = b ? cropOf(to, s.trays) : null;
    delete s.trays[from];
    if (b){ if (cb !== TIER_CROP[tf]) b.crop = cb; else delete b.crop; s.trays[from] = b; }
    if (ca !== TIER_CROP[tt]) a.crop = ca; else delete a.crop;
    s.trays[to] = a;
  });
}
function dndEnd(){
  if (!dnd) return;
  const was = dnd.active, from = dnd.k, over = dnd.over; dndClear();
  if (!was) return;
  suppressClick = Date.now();
  if (!over) return;
  const to = over.dataset.k;
  if (state.trays[to] && !confirm("Swap " + label(from) + " with " + label(to) + "?")) return;
  moveTray(from, to);
}

function init(){
  const st = document.createElement("style"); st.textContent = STYLE; document.head.appendChild(st);
  ov = document.createElement("div"); ov.className = "overlay"; ov.innerHTML = '<div class="modal nl-modal"></div>'; document.body.appendChild(ov);
  mapEl.addEventListener("click", onClick); ov.addEventListener("click", onClick);
  mapEl.addEventListener("pointerdown", dndStart);
  document.addEventListener("pointermove", dndMove); document.addEventListener("pointerup", dndEnd);
  document.addEventListener("pointercancel", () => { if (dnd && dnd.active) suppressClick = Date.now(); dndClear(); });
  document.addEventListener("touchmove", (e) => { if (dnd && dnd.active) e.preventDefault(); }, { passive: false });
  mapEl.addEventListener("contextmenu", (e) => { if (e.target.closest(".l3m-cell")) e.preventDefault(); });
  onAuthStateChanged(auth, (u) => { isAdmin = !!u; render(); });
  onSnapshot(REF, (snap) => {
    if (snap.exists()){ const d = snap.data(); state = { trays: d.trays && typeof d.trays === "object" ? d.trays : {}, history: Array.isArray(d.history) ? d.history : [], log: Array.isArray(d.log) ? d.log : [] }; }
    loaded = true; loadError = ""; publish(); render(); mount();
  }, (err) => { loadError = err.message; render(); });
  render(); mount();
}
init();
