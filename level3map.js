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
// Ice Plant tiers (North T1, T2): trays 1-3 and 9-11 are on the salted tank 3N1, the middle trays 4-8 on the normal nutrient tank 3N2.
const AGE_ALERT = 40;
const isBuffer = (r, t, p) => r === "S" && p <= 1;
const isSalted = (r, t, p) => r === "N" && (t === 1 || t === 2) && (p <= 3 || p >= 9);
const keyOf = (r, t, p) => r + t + "-" + p;
function parseKey(k){ const m = /^([NS])(\d)-(\d+)$/.exec(k); return m ? { r: m[1], t: +m[2], p: +m[3] } : null; }
const cropOfKey = (k, trays) => { const q = parseKey(k); if (!q) return ""; const tr = (trays || state.trays)[k]; return (tr && tr.crop) || cropAt(q.r, q.t); };
const tierCropOfKey = (k) => { const q = parseKey(k); return q ? cropAt(q.r, q.t) : ""; };

let state = { trays: {}, history: [], empties: {}, log: [] };
let multi = false;
let logN = 20, logWho = "all";
let loaded = false, isAdmin = false, loadError = "", showHistory = false, showDates = true, last = null;
const sel = new Set();

function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function toDate(s){ const p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
function toKey(d){ return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0"); }
function today(){ const d = new Date(); if (d.getHours() < 7) d.setDate(d.getDate() - 1); return toKey(d); }
const empOf = (v) => { const p = String(v || "").split("|"); return p[0] === "dirty" || p[0] === "clean" ? { st: p[0], d: p[1] || "" } : null; };
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
.l3r{position:fixed;inset:0;z-index:2000;background:var(--bg,#eee8e2);overflow:auto;display:none;-webkit-overflow-scrolling:touch;touch-action:manipulation}
.l3r.on{display:block}
.l3r-in{max-width:920px;margin:0 auto;padding:16px 18px 140px}
.l3r h2{font-family:'Cormorant Garamond',serif;font-size:38px;margin:14px 0 6px}
.l3r h3{font-size:22px;margin:22px 0 8px}
.l3r .sub{font-size:19px;opacity:.75;margin:0 0 10px}
.l3r button{font:inherit;font-size:22px;min-height:72px;padding:10px 18px;border-radius:18px;border:2.5px solid var(--green,#35473a);background:var(--card,#f7f3ee);color:var(--ink,#2c3a30);cursor:pointer}
.l3r button:active{transform:scale(.97)}
.l3r button[disabled]{opacity:.35}
.l3r button.on{background:var(--green,#35473a);color:#fff}
.l3r button.go{background:var(--green,#35473a);color:#fff;font-size:26px;font-weight:700;min-height:84px;width:100%}
.l3r-top{display:flex;justify-content:space-between;gap:10px}
.l3r-top button{min-width:140px}
.l3r-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(210px,1fr))}
.l3r-grid button{display:flex;flex-direction:column;align-items:flex-start;gap:4px;text-align:left;min-height:96px}
.l3r-grid button b{font-size:24px}
.l3r-grid button span{font-size:17px;opacity:.8}
.l3r-nums{display:grid;gap:10px;grid-template-columns:repeat(5,1fr)}
.l3r-nums button{font-size:30px;font-weight:700;min-height:84px}
.l3r-two{display:grid;gap:12px;grid-template-columns:1fr 1fr}
.l3r-date{display:grid;grid-template-columns:84px 1fr 84px;gap:10px;align-items:center}
.l3r-date .d{font-size:26px;font-weight:700;text-align:center}
.l3r-quick{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:10px}
.l3r-quick input{font:inherit;font-size:20px;min-height:72px;border-radius:18px;border:2.5px solid var(--green,#35473a);padding:8px 12px;background:var(--card,#f7f3ee);width:100%}
.l3r-msg{background:var(--sage,#d3dccf);border-radius:16px;padding:14px 18px;font-size:22px;font-weight:700;margin:12px 0}
.l3r-save{position:fixed;left:0;right:0;bottom:0;padding:12px 18px 18px;background:linear-gradient(transparent,var(--bg,#eee8e2) 30%)}
.l3r-save .in{max-width:920px;margin:0 auto}
.l3m-cell.pre i{color:#b71c1c;font-weight:800;opacity:1}
.l3m-cell.dirty{background:#dcc7ab;border-color:#8a5a2b;border-width:2px}
.l3m-cell.dirty i{opacity:1;font-weight:800;color:#6b3f12;font-size:10px}
.l3m-cell.clean{background:#e1f0fa}
.l3m-cell.clean i{opacity:1;font-weight:700;color:#2a6a96;font-size:10px}
.l3m-cell.smp{background:#ddd5f3;border-color:#6b5bb0;border-width:2px}
.l3m-cell.smp s.cr{color:#4a3a94}
.l3m-cell.off{background:#f7d9a6;border-color:#d4871c;border-width:2px}
.l3m-cell{display:flex;flex-direction:column;align-items:stretch;justify-content:flex-start;min-height:78px;padding:3px 2px 3px;overflow:hidden;box-sizing:border-box}
.l3m-cell .tp{display:flex;justify-content:space-between;align-items:center;min-height:13px;padding:0 1px}
.l3m-cell .tp strong.pp{font-size:12px;font-weight:900;color:#1f9d3a;line-height:1}
.l3m-cell .tp em{margin-left:auto;font-size:9.5px;font-style:normal;font-weight:800;color:#9a4a3a;line-height:1}
.l3m-cell .ft{display:flex;flex-wrap:wrap;justify-content:center;align-content:flex-start;gap:2px;margin-top:auto;padding-top:2px;min-height:15px}
.l3m-cell s.cr{display:block;max-width:100%;text-decoration:none;font-size:8.5px;font-weight:800;line-height:1;color:#8a4b00;background:rgba(212,135,28,.22);border-radius:5px;padding:2px 3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;box-sizing:border-box}
.l3m-cell.smp s.cr{color:#4a3a94;background:rgba(107,91,176,.2)}
.l3m-cell var.ag{display:block;font-style:normal;font-size:9px;font-weight:800;line-height:1;color:#fff;background:#1a237e;border-radius:5px;padding:2px 4px}
.l3m-cell var.nw{display:block;font-style:normal;font-size:8.5px;font-weight:900;letter-spacing:.03em;line-height:1;color:#fff;background:#2e7d32;border-radius:5px;padding:2px 4px}
.l3m-cell.pre{border-left:6px solid #c62828;border-left-style:solid}
.l3m-cell.pre i{color:#b71c1c;font-weight:800;opacity:1}
.l3m-cell.old40{border-top:6px solid #1a237e;border-top-style:solid}
.l3m-cell.buf{border-bottom:6px solid #2f7f86;border-bottom-style:solid}
.l3m-cell.dirty{animation:l3pulse 1.4s ease-in-out infinite,l3shake 3.2s ease-in-out infinite;border-color:#c62828;border-width:2px}
.l3m-cell.dirty i{color:#9a1c1c}
.l3m-cell.dirty::after{content:"CLEAN ME";display:block;margin:auto auto 0;font-size:7.5px;font-weight:900;letter-spacing:.04em;line-height:1;color:#fff;background:#c62828;border-radius:5px;padding:2px 4px;animation:l3blink 1.4s steps(2,jump-none) infinite}
.l3m-cell.dirty .ft{display:none}
.l3-dirtycard{animation:l3pulse 1.6s ease-in-out infinite}
@keyframes l3pulse{0%,100%{box-shadow:0 0 0 0 rgba(198,40,40,.65)}50%{box-shadow:0 0 0 7px rgba(198,40,40,0)}}
@keyframes l3shake{0%,70%,100%{transform:translateX(0) rotate(0)}74%{transform:translateX(-2px) rotate(-2deg)}78%{transform:translateX(2px) rotate(2deg)}82%{transform:translateX(-2px) rotate(-2deg)}86%{transform:translateX(2px) rotate(2deg)}90%{transform:translateX(0) rotate(0)}}
@keyframes l3blink{0%{opacity:1}50%{opacity:.45}}
@media (prefers-reduced-motion:reduce){.l3m-cell.dirty,.l3m-cell.dirty::after,.l3-dirtycard{animation:none}}
.l3m-cell{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}
.l3m-cell.lp{transform:scale(.94);opacity:.7}
.l3m-cell.drop{outline:3px solid #2e7d32;outline-offset:1px;background:#d9efd5}
.l3m-ghost{position:fixed;z-index:3000;pointer-events:none;background:#35473a;color:#fff;border-radius:12px;padding:8px 12px;font:700 14px Inter,system-ui,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.35);transform:translate(-50%,-130%)}
.al-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:2px 0 12px}
.al-st{background:var(--card,#f7f3ee);border:1px solid rgba(0,0,0,.1);border-radius:12px;padding:10px 12px}
.al-st b{display:block;font-size:24px;line-height:1.1;color:#35473a}
.al-st span{display:block;font-size:11px;letter-spacing:.03em;text-transform:uppercase;opacity:.65;margin-top:3px}
.al-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px}
.al-chip{display:inline-flex;align-items:center;gap:6px;font:600 13px Inter,system-ui,sans-serif;border:1.5px solid rgba(0,0,0,.18);background:#fff;color:#35473a;border-radius:999px;padding:5px 11px 5px 6px;cursor:pointer}
.al-chip:first-child{padding-left:11px}
.al-chip i{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;color:#fff;font-style:normal;font-size:11px;font-weight:800}
.al-chip small{opacity:.6;font-weight:700}
.al-chip.on{background:#35473a;color:#fff;border-color:#35473a}
.al-chip.on small{opacity:.8}
.al-list{border:1px solid rgba(0,0,0,.1);border-radius:14px;background:#fff;overflow:hidden}
.al-day{background:#f1ece5;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#6b665e;padding:6px 14px;border-top:1px solid rgba(0,0,0,.06)}
.al-day:first-child{border-top:0}
.al-row{display:flex;align-items:flex-start;gap:12px;padding:11px 14px;border-top:1px solid rgba(0,0,0,.06)}
.al-day + .al-row{border-top:0}
.al-av{flex:0 0 auto;width:34px;height:34px;border-radius:50%;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px}
.al-mid{flex:1 1 auto;min-width:0}
.al-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.al-by{font-weight:800;font-size:14px;color:#2c3a30}
.al-bd{font-size:10.5px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;border-radius:999px;padding:2px 8px}
.al-bd.hv{background:#d3e6d0;color:#1f5d2a}.al-bd.dp{background:#f6d4d0;color:#9a2a22}.al-bd.tp{background:#d6e6f2;color:#1e5b86}
.al-bd.sh{background:#e3dcf4;color:#4a3a94}.al-bd.rd{background:#f7e6b8;color:#7a5600}.al-bd.ed{background:#e8e4de;color:#5b564e}.al-bd.rm{background:#ead9d9;color:#7a3a3a}
.al-hd{font-size:14px;margin-top:3px;color:#2c3a30;overflow-wrap:anywhere}
.al-sub{font-size:12.5px;opacity:.7;margin-top:2px;overflow-wrap:anywhere}
.al-tm{flex:0 0 auto;text-align:right;font-size:11.5px;line-height:1.3}
.al-tm b{display:block;font-size:13px}
.al-tm span{opacity:.6;white-space:nowrap}
.al-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:10px;font-size:12.5px;opacity:.9}
.l3-swipe{display:none}
@media (max-width:640px){
  .nl-table{display:block;overflow-x:auto;max-width:100%;-webkit-overflow-scrolling:touch}
  .nl-caps{grid-template-columns:1fr !important}
  .nl-cap-row{flex-wrap:wrap}
  .nl-bh{flex-wrap:wrap}
  .l3m-tier{min-width:0}
  .tab-btn{overflow:hidden}
  .tab-label{white-space:normal !important;text-align:center;line-height:1.15;overflow-wrap:anywhere;max-width:100%}
  .tabs{align-items:stretch}
  .l3m-cells{grid-template-columns:repeat(6,minmax(0,1fr)) !important;gap:5px}
  .l3m-cell{min-height:72px;padding:2px 1px 2px}
  .l3m-cell s.cr{white-space:normal;text-overflow:clip;overflow-wrap:anywhere;text-align:center;font-size:8px}
  .l3m-cell b{font-size:15px}
  .al-stats{grid-template-columns:repeat(2,1fr)}
  .al-row{padding:10px 10px;gap:9px}
  .al-av{width:30px;height:30px;font-size:13px}
  .l3m-th{gap:6px}
  .l3m-th button{font-size:13px;padding:6px 11px}
  .l3-swipe{display:block}
  .nl-root{overflow-x:hidden}
  .nl-modal{max-width:100% !important}
  .l3m-leg{display:flex;flex-wrap:wrap;gap:6px 12px;font-size:12px}
}
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
  ov.addEventListener("change", (e) => { if (e.target && e.target.id === "l3mCrop"){ const n = document.getElementById("l3mCropNew"); if (n){ n.style.display = e.target.value === "__new__" ? "" : "none"; if (e.target.value === "__new__") n.focus(); } } });
  const ro = document.createElement("div"); ro.className = "l3r"; ro.id = "l3rOverlay"; document.body.appendChild(ro);
  ro.addEventListener("click", onRecClick); ro.addEventListener("change", onRecChange);
  onAuthStateChanged(auth, (user) => { isAdmin = !!user; if (!isAdmin) sel.clear(); render(); });
  onSnapshot(REF, (snap) => {
    if (snap.exists()){
      const d = snap.data();
      state = { trays: d.trays && typeof d.trays === "object" ? d.trays : {}, history: Array.isArray(d.history) ? d.history : [], empties: d.empties && typeof d.empties === "object" ? d.empties : {}, log: Array.isArray(d.log) ? d.log : [] };
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
  next.empties = next.empties || {};
  Object.keys(next.empties).forEach(k => { if (next.trays[k]) delete next.empties[k]; });
  try { const ents = logDiff(state, next, whoName(auth.currentUser)); if (ents.length) next.log = ents.concat(Array.isArray(next.log) ? next.log : []).slice(0, 600); } catch (err){ console.warn("log", err); }
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

const occ = () => Object.keys(state.trays).map(k => Object.assign({ k }, parseKey(k), state.trays[k])).filter(x => x.r && x.p >= 1 && x.p <= posOf(x.r)).map(x => Object.assign(x, { tierCrop: cropAt(x.r, x.t), crop: x.crop || cropAt(x.r, x.t) }));
const plOf = (tr, crop) => (tr && Number(tr.plants) > 0 ? Math.round(Number(tr.plants)) : ppt(crop));
const trayPlants = (x) => plOf(x, x.crop);
const parsePl = (v) => { const n = Math.round(Number(v)); return n >= 1 ? n : null; };
const setPl = (tr, n, crop) => { if (n && n !== ppt(crop)) tr.plants = n; else delete tr.plants; };
const plantsField = (crop, cur, blankNote) => '<div class="field"><label>Plants in the tray' + (crop ? ' (full tray = ' + ppt(crop) + ')' : '') + '</label><input type="number" inputmode="numeric" id="l3mPl" min="1" step="1" placeholder="' + (blankNote || "full tray") + '" value="' + (cur || "") + '"></div>';

// ---------------------------------------------------------------- render
// ---------------------------------------------------------------- action history
const PEOPLE = { "omegapeanut@gmail.com": "YS" };
function whoName(u){
  const e = String((u && u.email) || "").toLowerCase();
  if (PEOPLE[e]) return PEOPLE[e];
  if (e.includes("hasan")) return "Hasan";
  if (e.includes("meraj")) return "Meraj";
  const n = e.split("@")[0].replace(/[^a-z0-9]+/g, " ").trim();
  return n ? n.charAt(0).toUpperCase() + n.slice(1) : "Unknown";
}
function logDiff(prev, next, by){
  const sigOf = (tr, k, trays) => tr.date + "|" + (tr.type === "old" ? "old" : "new") + "|" + cropOfKey(k, trays);
  const out = [], now = new Date().toISOString();
  const mk = (a, o) => Object.assign({ t: now, by, a }, o);
  const newHist = (next.history || []).slice((prev.history || []).length);
  const exited = new Set(newHist.map(x => x.k));
  // harvests and disposals (grouped by kind + crop)
  const hg = {};
  newHist.forEach(x => { const a = x.exitType === "harvested" ? "harvest" : "dispose"; const g = (hg[a + "|" + x.crop] = hg[a + "|" + x.crop] || { a, crop: x.crop, keys: [], plants: 0, partial: false }); if (!g.keys.includes(x.k)) g.keys.push(x.k); g.plants += x.plants || 0; if (/^partial/.test(x.note || "")) g.partial = true; });
  Object.values(hg).forEach(g => out.push(mk(g.a, { crop: g.crop, keys: g.keys, plants: g.plants, partial: g.partial })));
  const pk = Object.keys(prev.trays || {}), nk = Object.keys(next.trays || {});
  const added = nk.filter(k => !prev.trays[k]), removed = pk.filter(k => !next.trays[k] && !exited.has(k));
  const changed = pk.filter(k => next.trays[k] && prev.trays[k] && JSON.stringify(prev.trays[k]) !== JSON.stringify(next.trays[k]) && !exited.has(k));
  // shifts: tray removed from one slot and the same tray appearing in another, or two trays swapped
  const moves = [], usedA = new Set(), usedR = new Set(), usedC = new Set();
  removed.forEach(r => { const sg = sigOf(prev.trays[r], r, prev.trays); const a = added.find(x => !usedA.has(x) && sigOf(next.trays[x], x, next.trays) === sg); if (a){ usedA.add(a); usedR.add(r); moves.push({ from: r, to: a, crop: cropOfKey(r, prev.trays), plants: plOf(prev.trays[r], cropOfKey(r, prev.trays)) }); } });
  changed.forEach(x => { if (usedC.has(x)) return; const y = changed.find(z => z !== x && !usedC.has(z) && sigOf(next.trays[x], x, next.trays) === sigOf(prev.trays[z], z, prev.trays) && sigOf(next.trays[z], z, next.trays) === sigOf(prev.trays[x], x, prev.trays) && sigOf(prev.trays[x], x, prev.trays) !== sigOf(prev.trays[z], z, prev.trays) || (z !== x && !usedC.has(z) && JSON.stringify(prev.trays[x].date) === JSON.stringify(next.trays[z].date) && false)); if (y){ usedC.add(x); usedC.add(y); moves.push({ from: x, to: y, crop: cropOfKey(x, prev.trays), plants: plOf(prev.trays[x], cropOfKey(x, prev.trays)), swap: cropOfKey(y, prev.trays), swapPlants: plOf(prev.trays[y], cropOfKey(y, prev.trays)) }); } });
  if (moves.length) out.push(mk("shift", { mv: moves }));
  // new transplants (grouped by crop + planting date)
  const tg = {};
  added.filter(k => !usedA.has(k)).forEach(k => { const c = cropOfKey(k, next.trays), tr = next.trays[k], id = c + "|" + tr.date; const g = (tg[id] = tg[id] || { crop: c, date: tr.date, keys: [], plants: 0 }); g.keys.push(k); g.plants += plOf(tr, c); });
  Object.values(tg).forEach(g => out.push(mk("transplant", { crop: g.crop, keys: g.keys, plants: g.plants, date: g.date })));
  // trays cleared without history (mistaken entries)
  const rm = removed.filter(k => !usedR.has(k));
  if (rm.length) out.push(mk("remove", { keys: rm, plants: rm.reduce((a, k) => a + plOf(prev.trays[k], cropOfKey(k, prev.trays)), 0) }));
  // ready flag toggles vs other edits
  const rdy = [], nrd = [], ed = [];
  changed.filter(k => !usedC.has(k)).forEach(k => { const a = prev.trays[k], b = next.trays[k]; const sa = Object.assign({}, a), sb = Object.assign({}, b); ["ready", "readyDate"].forEach(f => { delete sa[f]; delete sb[f]; }); if (JSON.stringify(sa) === JSON.stringify(sb)) (b.ready ? rdy : nrd).push(k); else ed.push(k); });
  if (rdy.length) out.push(mk("ready", { keys: rdy, ready: true }));
  if (nrd.length) out.push(mk("ready", { keys: nrd, ready: false }));
  if (ed.length) out.push(mk("edit", { keys: ed }));
  const pe = prev.empties || {}, ne = next.empties || {}, eg = { dirty: [], clean: [] };
  Object.keys(ne).forEach(k => { const n = empOf(ne[k]), p = empOf(pe[k]); if (n && !next.trays[k] && !exited.has(k) && (!p || p.st !== n.st)) eg[n.st].push(k); });
  if (eg.dirty.length) out.push(mk("dirty", { keys: eg.dirty }));
  if (eg.clean.length) out.push(mk("clean", { keys: eg.clean }));
  return out;
}
const ACT = {
  harvest:   { word: "Harvested",   cls: "hv", icon: "✂" },
  dispose:   { word: "Disposed",    cls: "dp", icon: "✕" },
  transplant:{ word: "Transplanted",cls: "tp", icon: "＋" },
  shift:     { word: "Shifted",     cls: "sh", icon: "⇄" },
  ready:     { word: "Marked",      cls: "rd", icon: "✓" },
  edit:      { word: "Edited",      cls: "ed", icon: "✎" },
  remove:    { word: "Cleared",     cls: "rm", icon: "−" },
  dirty:     { word: "Dirty",       cls: "dp", icon: "!" },
  clean:     { word: "Clean",       cls: "hv", icon: "✓" }
};
const AV = { YS: "#35473a", Hasan: "#2f7f86", Meraj: "#8a5a2b" };
const avCol = (n) => AV[n] || "#6b5bb0";
function lblK(k){ const q = parseKey(k); return q ? label(q.r, q.t, q.p) : k; }
function logLine(e){
  const n = (e.keys || []).length, tr = n === 1 ? "1 tray" : n + " trays";
  const crop = e.crop ? '<b>' + esc(e.crop) + '</b>' : "";
  if (e.a === "harvest") return { head: "Harvested " + (e.plants != null ? '<b>' + e.plants + '</b> ' : "") + 'plants' + (e.crop ? " of " + crop : ""), sub: esc(keysSummary(e.keys)) + (e.partial ? " · partial, balance stays in tray" : " · " + tr) };
  if (e.a === "dispose") return { head: "Disposed " + (e.plants != null ? '<b>' + e.plants + '</b> ' : "") + 'plants' + (e.crop ? " of " + crop : ""), sub: esc(keysSummary(e.keys)) + (e.partial ? " · partial, balance stays in tray" : " · " + tr) };
  if (e.a === "transplant") return { head: "Transplanted " + tr + (e.crop ? " of " + crop : ""), sub: esc(keysSummary(e.keys)) + " · " + (e.plants || 0) + " plants" + (e.date ? " · planted " + esc(fmtFull(e.date)) : "") };
  if (e.a === "shift"){
    const mv = e.mv || [];
    const one = (m) => (m.swap ? "<b>" + esc(lblK(m.from)) + "</b> ⇄ <b>" + esc(lblK(m.to)) + "</b> (" + esc(m.crop) + " ⇄ " + esc(m.swap) + ")" : "<b>" + esc(lblK(m.from)) + "</b> → <b>" + esc(lblK(m.to)) + "</b> (" + esc(m.crop) + ")");
    return { head: mv.length === 1 ? (mv[0].swap ? "Swapped two trays" : "Shifted " + esc(mv[0].crop) + " to another tray") : "Shifted " + mv.length + " trays", sub: mv.slice(0, 6).map(one).join(" · ") + (mv.length > 6 ? " · +" + (mv.length - 6) + " more" : "") };
  }
  if (e.a === "ready") return { head: (e.ready ? "Marked " : "Marked not ready: ") + tr + (e.ready ? " ready to harvest" : ""), sub: esc(keysSummary(e.keys)) };
  if (e.a === "dirty") return { head: "Marked " + tr + " as <b>dirty</b> — needs cleaning", sub: esc(keysSummary(e.keys)) };
  if (e.a === "clean") return { head: "Marked " + tr + " as <b>clean</b>", sub: esc(keysSummary(e.keys)) };
  if (e.a === "edit") return { head: "Edited details of " + tr, sub: esc(keysSummary(e.keys)) };
  return { head: "Cleared " + tr + " without recording a harvest", sub: esc(keysSummary(e.keys)) + " · mistaken entry" };
}
function logTime(iso){
  const d = new Date(iso); if (isNaN(d)) return { day: "", clock: "", rel: "" };
  const t0 = new Date(); const sd = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((sd(t0) - sd(d)) / 86400000);
  const day = diff === 0 ? "Today" : diff === 1 ? "Yesterday" : d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear();
  const clock = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  const m = Math.floor((Date.now() - d.getTime()) / 60000);
  const rel = m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.floor(m / 60) + " h ago" : diff + " d ago";
  return { day, clock, rel };
}
function actionHistory(){
  const all = Array.isArray(state.log) ? state.log : [];
  if (!all.length) return '<p class="hint">No actions recorded yet. From now on, every harvest, disposal, transplant, shift and change is listed here with the name of the person who did it.</p>';
  const who = {}; all.forEach(e => { who[e.by] = (who[e.by] || 0) + 1; });
  const names = Object.keys(who).sort((a, b) => who[b] - who[a]);
  const list = logWho === "all" ? all : all.filter(e => e.by === logWho);
  const wk = Date.now() - 7 * 86400000;
  const stat = (lbl, v) => '<div class="al-st"><b>' + v + '</b><span>' + lbl + '</span></div>';
  const wkList = all.filter(e => new Date(e.t).getTime() >= wk);
  const sum = (a, f) => a.reduce((s, e) => s + (e.a === f ? (e.plants || 0) : 0), 0);
  let h = '<div class="al-stats">' + stat("Actions · last 7 days", wkList.length) + stat("Plants harvested · 7 days", sum(wkList, "harvest")) + stat("Plants disposed · 7 days", sum(wkList, "dispose")) + stat("Trays transplanted · 7 days", wkList.filter(e => e.a === "transplant").reduce((s, e) => s + (e.keys || []).length, 0)) + '</div>';
  h += '<div class="al-chips"><button class="al-chip' + (logWho === "all" ? " on" : "") + '" data-action="logWho" data-who="all">Everyone <small>' + all.length + '</small></button>' +
    names.map(n => '<button class="al-chip' + (logWho === n ? " on" : "") + '" data-action="logWho" data-who="' + esc(n) + '"><i style="background:' + avCol(n) + '">' + esc(n.charAt(0)) + '</i>' + esc(n) + ' <small>' + who[n] + '</small></button>').join("") + '</div>';
  const shown = list.slice(0, logN);
  let lastDay = "";
  h += '<div class="al-list">';
  shown.forEach(e => {
    const L = logLine(e), T = logTime(e.t), A = ACT[e.a] || ACT.edit;
    if (T.day !== lastDay){ h += '<div class="al-day">' + esc(T.day) + '</div>'; lastDay = T.day; }
    h += '<div class="al-row"><span class="al-av" style="background:' + avCol(e.by) + '">' + esc(String(e.by || "?").charAt(0)) + '</span>' +
      '<div class="al-mid"><div class="al-top"><span class="al-by">' + esc(e.by || "Unknown") + '</span><span class="al-bd ' + A.cls + '">' + A.icon + ' ' + A.word + '</span></div>' +
      '<div class="al-hd">' + L.head + '</div><div class="al-sub">' + L.sub + '</div></div>' +
      '<div class="al-tm"><b>' + T.clock + '</b><span>' + T.rel + '</span></div></div>';
  });
  h += '</div>';
  h += '<div class="al-foot">Showing ' + shown.length + ' of ' + list.length + ' actions' + (list.length > shown.length ? '<button class="btn" data-action="logMore">Show more actions</button>' : '') + '</div>';
  return h;
}

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
  h += '<div class="nl-cap"><div class="nl-cap-row"><span class="nl-cap-title">Plants</span><span class="nl-cap-num"><b>' + plants + '</b></span><span class="nl-cap-sub">full tray 120 · Ice Plant 80 · partial trays counted as recorded</span></div>' + bar(0, 0) + '</div>';
  h += '<div class="nl-cap ' + (rp ? "ok" : "") + '"><div class="nl-cap-row"><span class="nl-cap-title">Plants ready</span><span class="nl-cap-num"><b>' + rp + '</b></span><span class="nl-cap-sub">' + (plants - rp) + ' not ready</span></div>' + bar(rp, plants) + '</div>';
  h += '</div>';
  const em = state.empties || {}, dirty = Object.keys(em).filter(k => (empOf(em[k]) || {}).st === "dirty" && !state.trays[k] && parseKey(k)), clean = Object.keys(em).filter(k => (empOf(em[k]) || {}).st === "clean" && !state.trays[k] && parseKey(k));
  const ord = (k) => { const q = parseKey(k); return (q.r === "N" ? 0 : 100) + q.t * 1000 + q.p; };
  dirty.sort((a, b) => ord(a) - ord(b));
  const pre = list.filter(x => x.date && x.date < CUT).sort((a, b) => ord(a.k) - ord(b.k));
  h += '<div class="nl-cap" style="margin-top:8px;border-color:#c62828;"><div class="nl-cap-row"><span class="nl-cap-title">To remove — planted before 1 Oct</span><span class="nl-cap-num"><b>' + pre.length + '</b></span><span class="nl-cap-sub">' + pre.reduce((s2, x) => s2 + trayPlants(x), 0) + ' plants</span></div>' +
    (pre.length ? '<div style="font-size:12.5px;line-height:1.5;margin-top:4px;">' + esc(keysSummary(pre.map(x => x.k))) + '</div>' : '<div style="font-size:12.5px;opacity:.7;">None. Every tray was planted from 1 Oct.</div>') + '</div>';
  const aged = list.map(x => ({ k: x.k, d: x.date ? daysBetween(x.date, today()) : null, rd: !!x.ready })).filter(x => x.d != null && x.d >= AGE_ALERT).sort((a, b) => b.d - a.d);
  h += '<div class="nl-cap" style="margin-top:8px;border-color:#1a237e;"><div class="nl-cap-row"><span class="nl-cap-title">Harvest first — ' + AGE_ALERT + '+ days since transplant</span><span class="nl-cap-num"><b>' + aged.length + '</b></span><span class="nl-cap-sub">' + aged.filter(x => x.rd).length + ' already ready</span></div>' +
    (aged.length ? '<div style="font-size:12.5px;line-height:1.6;margin-top:4px;">' + aged.slice(0, 40).map(x => { const q = parseKey(x.k); return esc(label(q.r, q.t, q.p)) + ' <b>' + x.d + 'd</b>' + (x.rd ? ' ✓' : ''); }).join(' · ') + (aged.length > 40 ? ' · +' + (aged.length - 40) + ' more' : '') + '<div style="opacity:.65;margin-top:3px;">Oldest first. ✓ = marked ready.</div></div>' : '<div style="font-size:12.5px;opacity:.7;">No tray is ' + AGE_ALERT + ' days or older yet.</div>') + '</div>';
  h += '<div class="nl-cap' + (dirty.length ? ' l3-dirtycard' : '') + '" style="margin-top:8px;border-color:#8a5a2b;"><div class="nl-cap-row"><span class="nl-cap-title">Trays to clean</span><span class="nl-cap-num"><b>' + dirty.length + '</b></span><span class="nl-cap-sub">' + clean.length + ' empty trays marked clean</span></div>' +
    (dirty.length ? '<div style="font-size:12.5px;line-height:1.5;margin-top:4px;">' + esc(keysSummary(dirty)) + '</div>' : '<div style="font-size:12.5px;opacity:.7;">No dirty trays marked. Harvested trays are marked dirty automatically.</div>') + '</div>';
  return h;
}

function cellHtml(r, t, p){
  const k = keyOf(r, t, p), tr = state.trays[k];
  const tierCrop = cropAt(r, t), cropHere = (tr && tr.crop) || tierCrop;
  const pre = !!(tr && tr.date && tr.date < CUT);
  const fresh = !!(tr && tr.date && daysBetween(tr.date, today()) != null && daysBetween(tr.date, today()) >= 0 && daysBetween(tr.date, today()) <= 2);
  const ageDays = tr && tr.date ? daysBetween(tr.date, today()) : null, aged = ageDays != null && ageDays >= AGE_ALERT;
  const eo = !tr && state.empties ? empOf(state.empties[k]) : null, emp = eo ? eo.st : "";
  const smp = !!(tr && tr.crop && !CROP_ORDER.includes(tr.crop)), off = !!(tr && tr.crop && tr.crop !== tierCrop && !smp);
  let cls = "l3m-cell" + (isSalted(r, t, p) ? " salt" : "") + (isBuffer(r, t, p) ? " buf" : "") + (tr ? (tr.ready ? " ready" : " grow") : "") + (off ? " off" : "") + (smp ? " smp" : "") + (emp ? " " + emp : "") + (pre ? " pre" : "") + (aged ? " old40" : "") + (sel.has(k) ? " sel" : "");
  let title = label(r, t, p) + " · " + cropAt(r, t) + (r === "N" && t <= 2 ? (isSalted(r, t, p) ? " · salted tank 3N1" : " · normal tank 3N2") : "") + (isBuffer(r, t, p) ? " · BUFFER tank (no nutrients, for crops ready to harvest)" : "");
  if (tr){
    const age = daysBetween(tr.date, today());
    title += " · " + (smp ? "SAMPLE: " + cropHere : off ? "HOLDS " + cropHere + " (wrong tier)" : cropHere) + (pre ? " · BEFORE 1 OCT — to be removed" : "") + (aged ? " · " + ageDays + " DAYS since transplant — harvest first" : "") + (fresh ? " · NEW — planted within 2 days" : "") + " · planted " + fmtFull(tr.date) + (age != null ? " (day " + age + ")" : "") + " · " + plOf(tr, cropHere) + " plants · " + (tr.ready ? "ready" : "not ready") + " · " + (tr.type === "old" ? "old crop" : "new crop") + (isAdmin && tr.pest ? " · pest (P)" : "");
  } else title += " · empty" + (emp ? " (" + emp + (eo.d ? " since " + fmtFull(eo.d) : "") + ")" : "");
  const pl = tr && plOf(tr, cropHere) !== ppt(cropHere) ? plOf(tr, cropHere) : "";
  const chips = ((off || smp) ? '<s class="cr">' + esc(SHORT[cropHere] || cropHere) + '</s>' : "") + (aged ? '<var class="ag">' + ageDays + 'd</var>' : "") + (fresh ? '<var class="nw">NEW</var>' : "");
  return '<button type="button" class="' + cls + '" data-action="cell" data-k="' + k + '" title="' + esc(title) + '"><span class="tp">' + (tr && tr.pest ? '<strong class="pp">P</strong>' : "") + (pl !== "" ? '<em>' + pl + '</em>' : "") + '</span><b>' + p + '</b><i>' + (tr ? esc(fmtShort(tr.date)) : emp ? emp + (eo.d ? "<br>" + esc(fmtShort(eo.d)) : "") : "&nbsp;") + '</i><span class="ft">' + chips + '</span></button>';
}

function rackHtml(rk){
  let h = '<div class="l3m-rack"><h4>' + rk.name + '</h4><div class="l3m-scroll">';
  TIERS.forEach(t => {
    const used = [], ready = [];
    for (let p = 1; p <= posOf(rk.id); p++){ const tr = state.trays[keyOf(rk.id, t, p)]; if (tr){ used.push(p); if (tr.ready) ready.push(p); } }
    h += '<div class="l3m-tier"><div class="l3m-th"><span class="t" data-action="tier" data-r="' + rk.id + '" data-t="' + t + '">T' + t + '</span><span class="c">' + esc(rk.tiers[t]) + '</span>' +
      '<span class="n">' + used.length + '/' + posOf(rk.id) + (ready.length ? ' · ' + ready.length + ' ready' : '') + '</span>' +
      (rk.id === "S" ? '<span class="salt" style="color:#2f7f86;font-weight:700;">S1 = buffer tank (no nutrients · for crops ready to harvest)</span>' : '') + (rk.id === "N" && t <= 2 ? '<span class="salt">dashed = salted tank 3N1 (trays 1-3, 9-11) · plain = normal tank 3N2 (trays 4-8)</span>' : '') +
      (isAdmin ? '<button class="btn" data-action="fillTier" data-r="' + rk.id + '" data-t="' + t + '">+ Transplant</button>' + (ready.length ? '<button class="btn" data-action="harvestTier" data-r="' + rk.id + '" data-t="' + t + '">Harvest ready</button>' : '') : '') +
      '</div><div class="l3m-cells" style="grid-template-columns:repeat(' + posOf(rk.id) + ',minmax(40px,1fr));">';
    { const order = []; for (let p = 1; p <= posOf(rk.id); p++) order.push(p); if (rk.id === "S") order.reverse(); order.forEach(p => { h += cellHtml(rk.id, t, p); }); }
    h += '</div></div>';
  });
  return h + '</div></div>';
}

function selBar(){
  if (!isAdmin || !sel.size) return "";
  let e = 0, f = 0; sel.forEach(k => { if (state.trays[k]) f++; else e++; });
  return '<div class="l3m-bar"><span class="cnt">' + sel.size + ' selected</span><span class="n" style="opacity:.7;margin-right:6px;">' + e + ' empty · ' + f + ' with crops</span>' +
    (e ? '<button class="btn primary" data-action="act" data-a="transplant">Transplant ' + e + '</button><button class="btn" data-action="act" data-a="dirty">Mark dirty</button><button class="btn" data-action="act" data-a="clean">Mark clean</button>' : '') +
    (f ? '<button class="btn" data-action="act" data-a="ready">Mark ready</button><button class="btn" data-action="act" data-a="notready">Not ready</button><button class="btn primary" data-action="act" data-a="harvest">Harvest ' + f + '</button><button class="btn danger" data-action="act" data-a="dispose">Dispose</button>' : '') +
    '<button class="btn" data-action="clearSel">Clear</button></div>';
}

function ranges(arr){
  const a = arr.slice().sort((x, y) => x - y), out = [];
  for (let i = 0; i < a.length;){ let j = i; while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++; out.push(i === j ? "" + a[i] : a[i] + "–" + a[j]); i = j + 1; }
  return out.join(", ");
}

function perTray(a){ const m = {}; a.forEach(n => { m[n] = (m[n] || 0) + 1; }); return Object.keys(m).map(Number).sort((x, y) => y - x).map(n => n + (m[n] > 1 ? " ×" + m[n] : "")).join(", "); }
const sumPl = (l) => l.reduce((a, x) => a + trayPlants(x), 0);

function datesTable(list){
  if (!list.length) return '<div class="empty-state">No trays recorded yet. Tap squares on the map, then Transplant.</div>';
  const g = new Map();
  list.forEach(x => {
    const k = [x.crop, x.r, x.t, x.date || "", x.ready ? "r" : "n", x.type === "old" ? "old" : "new"].join("|");
    if (!g.has(k)) g.set(k, { crop: x.crop, off: x.tierCrop !== x.crop, r: x.r, t: x.t, date: x.date, ready: !!x.ready, type: x.type === "old" ? "old" : "new", ps: [], pls: [] });
    g.get(k).ps.push(x.p); g.get(k).pls.push(trayPlants(x));
  });
  const order = (r, t) => (r === "N" ? 0 : 100) + t;
  const rows = [...g.values()].sort((a, b) => a.crop.localeCompare(b.crop) || order(a.r, a.t) - order(b.r, b.t) || (a.date || "9999").localeCompare(b.date || "9999"));
  const totals = {}; rows.forEach(r => { totals[r.crop] = (totals[r.crop] || 0) + r.ps.length; });
  let h = '<div style="overflow-x:auto;"><table class="nl-table"><thead><tr><th>Crop</th><th>Date planted</th><th>Day</th><th>Tier &amp; trays</th><th>Trays</th><th>Plants</th><th>Per tray</th><th>Status</th><th>Type</th></tr></thead><tbody>', prev = null;
  rows.forEach(r => {
    const first = r.crop !== prev; prev = r.crop;
    const age = r.date ? daysBetween(r.date, today()) : null;
    h += '<tr style="' + (first ? "border-top:2px solid rgba(0,0,0,.12);" : "") + '"><td>' + (first ? '<b>' + esc(r.crop) + '</b> <span class="nl-n">' + plural(totals[r.crop], "tray") + '</span>' : "") + '</td>' +
      '<td>' + fmtFull(r.date) + '</td><td>' + (age != null ? age : "–") + '</td><td>T' + r.t + (r.off ? ' <span style="color:#b3640a;font-weight:700;">(wrong tier)</span>' : '') + ' · ' + r.r + ranges(r.ps).replace(/(, )(\d)/g, "$1" + r.r + "$2").replace(/–(\d)/g, "–" + r.r + "$1") + '</td><td>' + r.ps.length + '</td><td>' + r.pls.reduce((a, b) => a + b, 0) + '</td><td>' + perTray(r.pls) + '</td>' +
      '<td><span class="nl-state ' + (r.ready ? "is-ready" : "not-ready") + '">' + (r.ready ? "Ready" : "Not ready") + '</span></td><td>' + (r.type === "old" ? "Old crop" : "New crop") + '</td></tr>';
  });
  return h + '</tbody></table></div>';
}

function varietyTable(list){
  const crops = {};
  RACKS.forEach(rk => TIERS.forEach(t => { const c = rk.tiers[t]; crops[c] = (crops[c] || 0) + posOf(rk.id); }));
  list.forEach(x => { if (!(x.crop in crops)) crops[x.crop] = 0; });
  const names = Object.keys(crops).sort((a, b) => a.localeCompare(b));
  let h = '<table class="nl-table"><thead><tr><th>Variety</th><th>Trays with crops</th><th>Before 1 Oct</th><th>From 1 Oct</th><th>Plants ready</th><th>Plants not ready</th><th>Total plants</th></tr></thead><tbody>';
  let tT = 0, tF = 0, tB = 0, tA = 0, tR = 0, tN = 0, tM = 0;
  names.forEach(v => {
    const l = list.filter(x => x.crop === v), maxT = crops[v], mp = maxT * ppt(v);
    const rp = sumPl(l.filter(x => x.ready)), np = sumPl(l.filter(x => !x.ready));
    const fb = l.filter(x => x.date && x.date < CUT).length, fa = l.filter(x => x.date && x.date >= CUT).length;
    tT += maxT; tF += l.length; tB += fb; tA += fa; tR += rp; tN += np; tM += mp;
    h += '<tr><td>' + esc(v) + (maxT ? "" : ' <span class="nl-n">(sample)</span>') + '</td><td>' + l.length + (maxT ? ' / ' + maxT : "") + '</td><td>' + fb + '</td><td>' + fa + '</td><td>' + rp + '</td><td>' + np + '</td><td>' + (rp + np) + (maxT ? ' / ' + mp : "") + '</td></tr>';
  });
  return h + '<tr class="nl-total"><td>Total</td><td>' + tF + ' / ' + tT + '</td><td>' + tB + '</td><td>' + tA + '</td><td>' + tR + '</td><td>' + tN + '</td><td>' + (tR + tN) + ' / ' + tM + '</td></tr></tbody></table>';
}

// South: trays 3-13 of T6-T4 on 3S2, T3-T1 on 3S1; trays 1-2 of all tiers on the Buffer tank.
// Floor plan: both racks with their water tanks, laid out like the plant's tank diagram.
// North: T6..T3 and the Ice Plant "middle slot" (trays 4-8 of T1 and T2) are on the normal tank 3N2;
// Ice Plant T2 and T1 (trays 1-3 and 9-11) are on the salted tank 3N1. South: 3S2 (T6-T4), 3S1 (T3-T1), Buffer for slot 1.
const SHORT = { "Mini Red Romaine Lettuce": "Red Romaine", "Crystal Green Lettuce": "Crystal Green", "Red Coral Lettuce": "Red Coral", "Garland Chrysanthemum": "Garland", "Ice Plant": "Ice Plant", "Perilla": "Perilla", "Mustard": "Mustard", "Sorrel": "Sorrel", "Mizuna": "Mizuna", "Swiss Chard": "Swiss Chard", "Kale": "Kale" };
function floorPlan(){
  const BW = 124, BH = 104, GAP = 12, X0 = 30, SQ = 7, SG = 1.6;
  const cx = (i) => X0 + i * (BW + GAP) + BW / 2;
  const range = (a, b) => { const o = []; for (let p = a; p <= b; p++) o.push(p); return o; };
  const N = RACKS[0], S = RACKS[1];
  const rowsOf = (rk, t) => [{ r: rk.id, t, ps: range(1, posOf(rk.id)), lab: "T" + t }];
  const count = (rows) => { let u = 0, rd = 0, n = 0; rows.forEach(rw => rw.ps.forEach(p => { n++; const tr = state.trays[keyOf(rw.r, rw.t, p)]; if (tr){ u++; if (tr.ready) rd++; } })); return { u, rd, n, free: n - u }; };
  const text = (x, y, str, size, weight, fill, anchor) => '<text x="' + x + '" y="' + y + '" font-size="' + size + '" font-weight="' + (weight || 400) + '" fill="' + (fill || "#2c3a30") + '" text-anchor="' + (anchor || "middle") + '">' + str + '</text>';
  const line = (x1, y1, x2, y2, dash, thin) => '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="#35473a" stroke-width="' + (thin ? 1.5 : 2.5) + '"' + (dash ? ' stroke-dasharray="7 5"' : "") + (thin ? ' opacity=".5"' : "") + '/>';
  const box = (def, i, y) => {
    const st = count(def.rows), x = X0 + i * (BW + GAP), bh = def.bh || BH, gap = def.rowGap || 12;
    const tip = def.title + " · " + st.u + " of " + st.n + " trays used, " + st.free + " free, " + st.rd + " ready";
    let g = '<g data-action="jump" data-r="' + def.rows[0].r + '" data-t="' + def.rows[0].t + '" style="cursor:pointer"><title>' + esc(tip) + '</title>' +
      '<rect x="' + x + '" y="' + y + '" width="' + BW + '" height="' + bh + '" rx="10" fill="#f1ebe4" stroke="#35473a" stroke-width="2"' + (def.salted ? ' stroke-dasharray="6 4"' : "") + '/>' +
      text(x + BW / 2, y + (def.sub ? 15 : 17), esc(def.title), 11.5, 700) +
      (def.sub ? text(x + BW / 2, y + 27, esc(def.sub), 9.5, 600, "#35473a") : "") +
      text(x + BW / 2, y + (def.sub ? 43 : 36), "free " + st.free + " / " + st.n, 14, 700, st.free === 0 ? "#9a4a3a" : "#35473a") +
      text(x + BW / 2, y + (def.sub ? 55 : 50), st.rd + " ready · " + (st.u - st.rd) + " growing", 9.5, 400, "#555");
    def.rows.forEach((rw, ri) => {
      const ry = y + (def.sub ? 62 : 58) + ri * gap, w0 = rw.ps.length * SQ + (rw.ps.length - 1) * SG, multi = def.rows.length > 1, sx = multi ? x + 40 : x + (BW - w0) / 2;
      if (multi) g += text(x + 10, ry + 7, rw.lab, 9, 600, "#555", "start");
      rw.ps.forEach((p, k) => {
        const tr = state.trays[keyOf(rw.r, rw.t, p)];
        g += '<rect x="' + (sx + k * (SQ + SG)).toFixed(1) + '" y="' + ry + '" width="' + SQ + '" height="' + SQ + '" rx="1.5" fill="' + (tr ? (tr.ready ? "#b9c9b3" : "#ecd6cb") : "#ffffff") + '" stroke="' + (tr ? (tr.ready ? "#6d8f6a" : "#c3836b") : "#9aa59c") + '" stroke-width="1"/>';
      });
    });
    g += text(x + BW / 2, y + bh - 7, def.note, 8.5, 400, "#555") + '</g>';
    return g;
  };
  const tank = (xc, y, w, name, sub, share, rows, dashed, blue) => {
    let free = 0, total = 0; rows.forEach(rw => rw.ps.forEach(p => { total++; if (!state.trays[keyOf(rw.r, rw.t, p)]) free++; }));
    const x = xc - w / 2;
    return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="66" rx="6" fill="' + (blue ? "#2f5fc4" : "#ffffff") + '" stroke="#35473a" stroke-width="2.5"' + (dashed ? ' stroke-dasharray="7 5"' : "") + '/>' +
      text(xc, y + 17, name, 15, 700, blue ? "#fff" : "#2c3a30") + text(xc, y + 30, sub, 9.5, 400, blue ? "#dbe6ff" : "#555") + text(xc, y + 42, share, 9.5, 400, blue ? "#dbe6ff" : "#555") +
      (rows.length ? text(xc, y + 58, "free " + free + " of " + total + " trays", 11, 700, "#35473a") : text(xc, y + 58, "backup for slot 1", 10, 600, "#fff"));
  };
  const NY = 30, NB = NY + BH, NBUS = 156, NTK = 176, RAILN = 268, STK = 376, SBUS = 460, SY = 484;
  let s = '<svg viewBox="0 0 1000 640" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;min-width:760px;font-family:Inter,system-ui,sans-serif;">';
  s += text(X0, 20, "NORTH RACK", 11, 600, "#777", "start");
  const nDefs = [6, 5, 4, 3].map(t => ({ title: "T" + t + " · " + SHORT[N.tiers[t]], rows: rowsOf(N, t), note: "N1–N" + posOf("N") })).concat([
    { title: "Ice Plant · T1 & T2", sub: "Tray 4, 5, 6, 7, 8", rows: [{ r: "N", t: 2, ps: range(4, 8), lab: "T2" }, { r: "N", t: 1, ps: range(4, 8), lab: "T1" }], note: "N4–N8 · both tiers · normal" },
    { title: "Ice Plant T2", sub: "Tray 1, 2, 3, 9, 10, 11", salted: true, rows: [{ r: "N", t: 2, ps: [1, 2, 3, 9, 10, 11], lab: "T2" }], note: "N1–N3 · N9–N11" },
    { title: "Ice Plant T1", sub: "Tray 1, 2, 3, 9, 10, 11", salted: true, rows: [{ r: "N", t: 1, ps: [1, 2, 3, 9, 10, 11], lab: "T1" }], note: "N1–N3 · N9–N11" }
  ]);
  nDefs.forEach((d, i) => { s += box(d, i, NY); });
  const pipeN = (from, to, tcx, dashed) => { let o = ""; for (let i = from; i <= to; i++) o += line(cx(i), NB, cx(i), NBUS, dashed); return o + line(cx(from), NBUS, cx(to), NBUS, dashed) + line(tcx, NBUS, tcx, NTK, dashed); };
  const n2c = (cx(0) + cx(4)) / 2, n1c = (cx(5) + cx(6)) / 2;
  s += pipeN(0, 4, n2c, false) + pipeN(5, 6, n1c, true);
  const n2rows = [6, 5, 4, 3].map(t => rowsOf(N, t)[0]).concat([{ r: "N", t: 2, ps: range(4, 8) }, { r: "N", t: 1, ps: range(4, 8) }]);
  s += tank(n2c, NTK, 150, "3N2", "L3 North side tank-2", "5 tanks sharing", n2rows, false, false);
  s += tank(n1c, NTK, 150, "3N1", "L3 North side tank-1", "2 tanks sharing · salted", [{ r: "N", t: 2, ps: [1, 2, 3, 9, 10, 11] }, { r: "N", t: 1, ps: [1, 2, 3, 9, 10, 11] }], true, false);
  s += line(X0, RAILN, 970, RAILN, true, true) + text(X0 + 5, RAILN - 7, "Robot rail (north)", 10, 400, "#777", "start") +
    '<rect x="' + X0 + '" y="' + (RAILN + 18) + '" width="200" height="50" rx="6" fill="#fff" stroke="#35473a" stroke-width="2.5"/>' + text(X0 + 100, RAILN + 39, "AGV TROLLEY", 13, 700) + text(X0 + 100, RAILN + 56, "MAIN ENTRANCE", 11, 600) +
    line(X0, RAILN + 84, 970, RAILN + 84, true, true) + text(X0 + 5, RAILN + 98, "Robot rail (south)", 10, 400, "#777", "start");
  const bfc = cx(0), s2c = (cx(1) + cx(3)) / 2, s1c = (cx(4) + cx(6)) / 2;
  const sRows = (t) => [{ r: "S", t, ps: range(2, posOf("S")).reverse() }];
  const bufRows = TIERS.map(t => ({ r: "S", t, ps: [1], lab: "T" + t }));
  s += tank(s2c, STK, 140, "3S2", "L3 South side tank-2", "3 tanks sharing", [6, 5, 4].map(sRows).flat(), false, false);
  s += tank(s1c, STK, 140, "3S1", "L3 South side tank-1", "3 tanks sharing", [3, 2, 1].map(sRows).flat(), false, false);
  s += tank(bfc, STK, 124, "Buffer", "Slot 1", "2 tanks sharing", bufRows, false, false);
  const pipeS = (from, to, tcx, dashed) => { let o = ""; for (let i = from; i <= to; i++) o += line(cx(i), SBUS, cx(i), SY, dashed); return o + line(cx(from), SBUS, cx(to), SBUS, dashed) + line(tcx, STK + 66, tcx, SBUS, dashed); };
  s += pipeS(0, 0, bfc, false) + pipeS(1, 3, s2c, false) + pipeS(4, 6, s1c, false);
  TIERS.forEach((t, i) => { s += box({ title: "T" + t + " · " + SHORT[S.tiers[t]], rows: [{ r: "S", t, ps: range(2, posOf("S")).reverse(), lab: "T" + t }], note: "S" + posOf("S") + "–S2" }, i + 1, SY); });
  s += box({ title: "Buffer · T1–T6", sub: "Tray 1 of every tier", bh: 132, rowGap: 9, rows: bufRows, note: "S1 · all tiers" }, 0, SY);
  s += text(X0, 636, "SOUTH RACK", 11, 600, "#777", "start");
  s += '</svg>';
  return '<p class="hint l3-swipe">Swipe sideways to see the whole plan →</p><div style="overflow-x:auto;-webkit-overflow-scrolling:touch;">' + s + '</div><p class="hint" style="margin-top:6px;">Laid out like the tank diagram. Each box is one crop on one tank. Small squares are its trays: white = free, pink = growing, green = ready. Dashed = salted tank 3N1 (Ice Plant trays 1-3 and 9-11 of T1 and T2). The Ice Plant middle trays (4-8 of both tiers) use the normal tank 3N2. South trays S2–S13 of each tier are on 3S2 (T6–T4) and 3S1 (T3–T1); tray S1 of every tier is on the Buffer tank. Tap a box to jump to it in the tray map.</p>';
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
    const bp = sumPl(b), ap = sumPl(a);
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
    h += '<tr><td>' + fmtFull(x.exitDate) + '</td><td>' + esc(x.crop) + '</td><td>' + (q ? label(q.r, q.t, q.p) : esc(x.k)) + '</td><td>' + fmtFull(x.date) + '</td><td>' + (x.plants || "") + '</td><td>' + (x.type === "old" ? "Old crop" : "New crop") + '</td><td>' + (x.exitType === "harvested" ? "Harvested" : "Disposed") + (x.note && /^partial/.test(x.note) ? " · " + esc(x.note) : "") + '</td></tr>';
  });
  return h + '</tbody></table></div>';
}

function render(){
  if (!root) return;
  const list = occ();
  let h = '<div class="section nl-root"><h2>Level 3 — Tray map</h2>';
  h += '<p class="hint">North rack 11 trays per tier, South rack 13, 6 tiers each. Tap a tray to see and change its details. Use Select many to update several at once. Each tier grows one crop.</p>';
  if (isAdmin) h += '<button class="btn primary" style="font-size:19px;padding:16px 24px;margin:4px 0 10px;" data-action="recOpen">📋 Record crops — big buttons (iPad mode)</button>';
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
    '<div class="l3m-leg"><span><u></u>Empty</span><span><u style="background:var(--blush,#ecd6cb)"></u>Growing</span><span><u style="background:var(--sage,#d3dccf)"></u>Ready</span><span><u style="border-style:dashed;border-color:#5b8db8"></u>Salted water</span><span><u style="background:#f7d9a6;border-color:#d4871c"></u>Wrong tier (shift back later)</span><span><u style="background:#ddd5f3;border-color:#6b5bb0"></u>Sample / test crop</span><span><u style="background:#2e7d32"></u>NEW — planted in the last 2 days</span><span><u style="background:#fff;border-left:5px solid #c62828"></u>Planted before 1 Oct — to remove</span><span><u style="background:#fff;border-top:5px solid #1a237e"></u>40+ days since transplant — harvest first (days shown)</span><span><u style="background:#fff;border-bottom:5px solid #2f7f86"></u>Buffer tank (S1, no nutrients)</span><span><u style="background:#dcc7ab;border-color:#8a5a2b"></u>Empty · dirty</span><span><u style="background:#e1f0fa"></u>Empty · clean</span><span>Number = tray position · small text = date planted</span></div>' +
    '<div class="' + (isAdmin ? "l3m-adm" : "") + '">' + rackHtml(RACKS[0]) + rackHtml(RACKS[1]) + '</div>' + selBar());
  h += blk("04", "Action history", actionHistory());
  h += '<section class="nl-block"><div class="nl-bh nl-toggle" data-action="toggleDates" style="cursor:pointer;"><span class="nl-no">05</span><span class="nl-bt">Dates by crop</span><span class="nl-count">' + plural(list.length, "tray") + ' · ' + (showDates ? "Hide ▴" : "Show ▾") + '</span></div>' + (showDates ? datesTable(list) : "") + '</section>';
  h += blk("06", "Consolidation — before 1 Oct vs from 1 Oct", consolidation(list));
  h += blk("07", "By variety", varietyTable(list));
  h += blk("08", "History", historySection());
  h += '</div>';
  root.innerHTML = h;
  if (rec) renderRec();
}

// ---------------------------------------------------------------- modals
const $m = () => document.getElementById("l3mModal");
function openModal(html){ $m().innerHTML = html; document.getElementById("l3mOverlay").classList.add("active"); }
function closeModal(){ const o = document.getElementById("l3mOverlay"); if (o) o.classList.remove("active"); }
const val = (id) => document.getElementById(id).value;
const typeSel = (v) => '<select id="l3mType"><option value="new"' + (v !== "old" ? " selected" : "") + '>New crop</option><option value="old"' + (v === "old" ? " selected" : "") + '>Old crop</option></select>';

const sampleNames = () => [...new Set(Object.values(state.trays).map(t => t && t.crop).filter(c => c && !CROP_ORDER.includes(c)))].sort();
const cropSel = (tierCrop, cur, pest) => {
  const samples = sampleNames(); if (cur && !CROP_ORDER.includes(cur) && !samples.includes(cur)) samples.push(cur);
  return '<div class="field"><label>Crop in this tray</label><select id="l3mCrop">' +
    CROP_ORDER.map(c => '<option value="' + esc(c) + '"' + (c === cur ? " selected" : "") + '>' + esc(c) + (c === tierCrop ? " (this tier)" : "") + '</option>').join("") +
    samples.map(c => '<option value="' + esc(c) + '"' + (c === cur ? " selected" : "") + '>' + esc(c) + ' (sample)</option>').join("") +
    '<option value="__new__">Other — type a new name…</option></select>' +
    '<input type="text" id="l3mCropNew" maxlength="40" placeholder="Name of the sample / test crop" style="display:none;margin-top:6px;">' +
    '<div class="hint" style="margin:4px 0 0;font-size:12px;">Wrong tier turns orange. A typed-in sample crop turns purple. Press and hold a tray to drag it to another slot.</div></div>' +
    '<div class="field"><label style="display:flex;align-items:center;gap:8px;text-transform:none;letter-spacing:0;font-size:14px;"><input type="checkbox" id="l3mPest" style="width:20px;height:20px;"' + (pest ? " checked" : "") + '> Mark this tray with a green P</label></div>';
};

function openTray(k){
  const q = parseKey(k); if (!q) return;
  const tr = state.trays[k], tierCrop = cropAt(q.r, q.t), crop = (tr && tr.crop) || tierCrop;
  const head = '<h3>' + label(q.r, q.t, q.p) + ' · ' + esc(crop) + '</h3>';
  const status = '<div class="field"><label>Status</label><select id="l3mStatus"><option value="0"' + (!tr || !tr.ready ? " selected" : "") + '>Not ready</option><option value="1"' + (tr && tr.ready ? " selected" : "") + '>Ready to harvest</option></select></div>';
  if (!tr){
    const curO = state.empties ? empOf(state.empties[k]) : null, cur = curO ? curO.st + (curO.d ? " since " + fmtFull(curO.d) : "") : "";
    openModal(head + '<div class="sub">Empty tray (' + (q.r === "N" ? "North" : "South") + ' rack, tier ' + q.t + ', position ' + q.p + ')' + (cur ? ' · currently marked <b>' + cur + '</b>' : '') + '.</div>' +
      '<div class="field"><label>Label this empty tray</label><div class="field" style="margin:0 0 8px;"><label style="font-size:11px;">Date</label><input type="date" id="l3mEmpDate" value="' + today() + '"></div><div class="nl-btnrow"><button class="btn" data-m="emptyMark" data-v="dirty" data-k="' + k + '" style="background:#dcc7ab;border-color:#8a5a2b;">Dirty — needs cleaning</button><button class="btn" data-m="emptyMark" data-v="clean" data-k="' + k + '" style="background:#e1f0fa;">Clean</button>' + (cur ? '<button class="btn" data-m="emptyMark" data-v="" data-k="' + k + '">Clear label</button>' : '') + '</div></div>' +
      '<div class="sub" style="margin-top:10px;"><b>Or transplant a crop into it:</b></div>' +
      '<div class="row2"><div class="field"><label>Date planted</label><input type="date" id="l3mDate" value="' + today() + '"></div><div class="field"><label>New or old crop</label>' + typeSel("new") + '</div></div>' + cropSel(tierCrop, tierCrop, false) + plantsField(crop, "") + status +
      '<div class="modal-actions"><button class="btn" data-m="cancel">Cancel</button><button class="btn primary" data-m="saveTray" data-k="' + k + '">Transplant</button></div>');
    return;
  }
  const age = daysBetween(tr.date, today());
  openModal(head + '<div class="sub">' + plural(1, "tray") + ' · ' + plOf(tr, crop) + ' plants · planted ' + fmtFull(tr.date) + (age != null ? " (day " + age + ")" : "") + '</div>' +
    '<div class="row2"><div class="field"><label>Date planted</label><input type="date" id="l3mDate" value="' + esc(tr.date || "") + '"></div><div class="field"><label>New or old crop</label>' + typeSel(tr.type === "old" ? "old" : "new") + '</div></div>' + cropSel(tierCrop, crop, tr.pest) + plantsField(crop, tr.plants && plOf(tr, crop) !== ppt(crop) ? plOf(tr, crop) : "") + status +
    '<div class="field"><label>Plants to harvest or dispose (blank = whole tray, ' + plOf(tr, crop) + ')</label><input type="number" inputmode="numeric" id="l3mOut" min="1" step="1" placeholder="whole tray"></div>' +
    '<div class="nl-btnrow"><button class="btn primary" data-m="trayExit" data-kind="harvested" data-k="' + k + '">Harvested</button><button class="btn danger" data-m="trayExit" data-kind="disposed" data-k="' + k + '">Dispose</button></div>' +
    '<div class="modal-actions"><div style="display:flex;gap:6px;"><button class="btn danger" data-m="trayRemove" data-k="' + k + '">Entered by mistake — empty it</button></div><div style="display:flex;gap:6px;"><button class="btn" data-m="cancel">Cancel</button><button class="btn primary" data-m="saveTray" data-k="' + k + '">Save</button></div></div>');
}

function saveTray(k){
  const date = val("l3mDate") || today(), type = val("l3mType") === "old" ? "old" : "new", ready = val("l3mStatus") === "1", d = today(), pl = parsePl(val("l3mPl")), tierCrop = tierCropOfKey(k);
  let crop = val("l3mCrop") || tierCrop;
  if (crop === "__new__"){ crop = val("l3mCropNew").trim(); if (!crop) return alert("Type a name for the new crop."); }
  const pest = document.getElementById("l3mPest") && document.getElementById("l3mPest").checked;
  mutate(s => {
    const tr = s.trays[k];
    if (tr){ if (crop !== tierCrop) tr.crop = crop; else delete tr.crop; if (pest) tr.pest = true; else delete tr.pest; setPl(tr, pl, crop); const was = !!tr.ready; tr.date = date; tr.type = type; tr.ready = ready; if (ready && !was) tr.readyDate = d; if (!ready) tr.readyDate = null; }
    else { s.trays[k] = { date, ready, readyDate: ready ? d : null, type }; if (crop !== tierCrop) s.trays[k].crop = crop; if (pest) s.trays[k].pest = true; setPl(s.trays[k], pl, crop); }
  }).then(ok => { if (ok) closeModal(); });
}

function setEmpty(keys, v, date){
  return mutate(s => { s.empties = s.empties || {}; keys.forEach(k => { if (s.trays[k]) return; if (v === "dirty" || v === "clean") s.empties[k] = v + "|" + (date || today()); else delete s.empties[k]; }); });
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
    '<div class="field"><label>New or old crop</label>' + typeSel() + '</div></div>' + plantsField(null, "", "full tray (leave blank)") +
    '<div class="modal-actions"><button class="btn" data-m="cancel">Cancel</button><button class="btn primary" data-m="saveTransplant" data-keys="' + esc(keys.join(",")) + '">Transplant</button></div>');
}

function saveTransplant(keys){
  const date = val("l3mDate") || today(), type = val("l3mType") === "old" ? "old" : "new", pl = parsePl(val("l3mPl"));
  mutate(s => { keys.forEach(k => { if (!s.trays[k]){ s.trays[k] = { date, ready: false, readyDate: null, type }; setPl(s.trays[k], pl, cropOfKey(k)); } }); }).then(ok => { if (ok){ sel.clear(); closeModal(); render(); } });
}

function openFillTier(r, t){
  const free = []; for (let p = 1; p <= posOf(r); p++) if (!state.trays[keyOf(r, t, p)]) free.push(p);
  if (!free.length) return alert("This tier is full.");
  openModal('<h3>Transplant into T' + t + ' · ' + esc(cropAt(r, t)) + '</h3><div class="sub">' + (r === "N" ? "North" : "South") + ' rack. Trays fill the next empty positions, starting at ' + r + free[0] + '. ' + free.length + ' empty.</div>' +
    '<div class="row2"><div class="field"><label>Number of trays</label><input type="number" id="l3mN" min="1" max="' + free.length + '" step="1" value="1"></div>' +
    '<div class="field"><label>Date planted</label><input type="date" id="l3mDate" value="' + today() + '"></div></div>' +
    '<div class="row2"><div class="field"><label>New or old crop</label>' + typeSel() + '</div>' + plantsField(cropAt(r, t), "", "full tray") + '</div>' +
    '<div class="modal-actions"><button class="btn" data-m="cancel">Cancel</button><button class="btn primary" data-m="saveFill" data-r="' + r + '" data-t="' + t + '">Transplant</button></div>');
}

function saveFill(r, t){
  const n = parseInt(val("l3mN"), 10), date = val("l3mDate") || today(), type = val("l3mType") === "old" ? "old" : "new", pl = parsePl(val("l3mPl"));
  const free = []; for (let p = 1; p <= posOf(r); p++) if (!state.trays[keyOf(r, t, p)]) free.push(p);
  if (!(n >= 1) || n > free.length) return alert("Enter 1 to " + free.length + " trays.");
  mutate(s => { free.slice(0, n).forEach(p => { const tr = { date, ready: false, readyDate: null, type }; setPl(tr, pl, cropAt(r, t)); s.trays[keyOf(r, t, p)] = tr; }); }).then(ok => { if (ok) closeModal(); });
}

function openExit(kind){
  const keys = fullKeys(); if (!keys.length) return;
  const harvest = kind === "harvested";
  openModal('<h3>' + (harvest ? "Harvest " : "Dispose ") + plural(keys.length, "tray") + '</h3><div class="sub">' + esc(summarize(keys)) + '. They become empty and move to the history.</div>' +
    '<div class="row2"><div class="field"><label>Date</label><input type="date" id="l3mDate" value="' + today() + '"></div>' +
    '<div class="field"><label>Note (optional)</label><input type="text" id="l3mNote" placeholder="e.g. reason"></div></div>' +
    '<div class="field"><label>Plants to take in total (blank = everything, ' + plantsIn(keys) + ' plants). Any balance stays in the tray.</label><input type="number" inputmode="numeric" id="l3mOut" min="1" step="1" placeholder="all ' + plantsIn(keys) + '"></div>' +
    '<div class="modal-actions"><button class="btn" data-m="cancel">Cancel</button><button class="btn ' + (harvest ? "primary" : "danger") + '" data-m="saveExit" data-kind="' + kind + '" data-keys="' + esc(keys.join(",")) + '">' + (harvest ? "Harvest" : "Dispose") + '</button></div>');
}

function saveExit(kind, keys){
  const date = val("l3mDate") || today(), note = val("l3mNote").trim(), amt = parsePl(val("l3mOut"));
  if (amt && amt > plantsIn(keys)) return alert("Only " + plantsIn(keys) + " plants are in the selected trays.");
  mutate(s => { takePlants(s, keys, amt, kind, date, note); }).then(ok => { if (ok){ sel.clear(); closeModal(); render(); } });
}

// Take `amt` plants (or everything when amt is empty) out of the given trays, in order.
// Trays emptied completely leave the map; a tray only partly used keeps the balance.
function takePlants(s, keys, amt, kind, date, note){
  let left = amt || Infinity, took = 0;
  for (const k of keys){
    if (left <= 0) break;
    const tr = s.trays[k]; if (!tr) continue;
    const crop = cropOfKey(k, s.trays), have = plOf(tr, crop), take = Math.min(have, left);
    const base = { k, crop, date: tr.date, readyDate: tr.readyDate || null, type: tr.type === "old" ? "old" : "new", exitType: kind, exitDate: date };
    if (take >= have){ s.history.push(Object.assign(base, { plants: have, note: note || "" })); delete s.trays[k]; s.empties = s.empties || {}; s.empties[k] = "dirty|" + (date || today()); }
    else { s.history.push(Object.assign(base, { plants: take, note: "partial (" + take + " of " + have + ")" + (note ? " · " + note : "") })); tr.plants = have - take; }
    left -= take; took += take;
  }
  return took;
}
const plantsIn = (keys) => keys.reduce((a, k) => a + plOf(state.trays[k], cropOfKey(k)), 0);

function partialExit(k, kind, out){
  const crop = cropOfKey(k), date = today(), word = kind === "harvested" ? "Harvest" : "Dispose";
  const have = plOf(state.trays[k], crop);
  if (!confirm(word + " " + out + " of " + have + " plants from " + label(parseKey(k).r, parseKey(k).t, parseKey(k).p) + "? " + (have - out) + " stay in the tray.")) return;
  mutate(s => {
    const tr = s.trays[k]; if (!tr) return;
    s.history.push({ k, crop, plants: out, date: tr.date, readyDate: tr.readyDate || null, type: tr.type === "old" ? "old" : "new", exitType: kind, exitDate: date, note: "partial (" + out + " of " + have + ")" });
    tr.plants = have - out;
  }).then(ok => { if (ok) closeModal(); });
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
            if (!s.trays[k]){ s.trays[k] = { date: b.plantedDate || today(), ready: !!b.ready, readyDate: b.ready ? (b.readyDate || today()) : null, type: b.crop === "old" ? "old" : "new" }; setPl(s.trays[k], parsePl((Number(b.plants) || 0) / (Number(b.trays) || 1)), b.variety); placed++; n--; }
          }
        }
        skipped += n;
      });
    });
    alert("Imported " + placed + " trays" + (skipped ? ". " + skipped + " didn't fit (their crop's tiers were full)." : "."));
  } catch (e){ alert("Couldn't import: " + e.message); }
}

// ---------------------------------------------------------------- big-button recording mode (iPad)
let rec = null;
const CROP_ORDER = [...new Set(RACKS.flatMap(rk => [1, 2, 3, 4, 5, 6].map(t => rk.tiers[t])))];
const addDays = (key, n) => { const d = toDate(key); d.setDate(d.getDate() + n); return toKey(d); };
const dateLong = (key) => toDate(key).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

function slotsFor(crop, trays){
  const out = [];
  RACKS.forEach(rk => [1, 2, 3, 4, 5, 6].forEach(t => { if (rk.tiers[t] !== crop) return; for (let p = 1; p <= posOf(rk.id); p++){ const k = keyOf(rk.id, t, p); if (!trays[k]) out.push(k); } }));
  return out;
}
function cropStats(crop){
  const list = occ().filter(x => x.crop === crop);
  let cap = 0; RACKS.forEach(rk => [1, 2, 3, 4, 5, 6].forEach(t => { if (rk.tiers[t] === crop) cap += posOf(rk.id); }));
  const ready = list.filter(x => x.ready).length, free = slotsFor(crop, state.trays).length;
  return { cap, used: cap - free, free, ready, growing: list.length - ready };
}
function groupsFor(crop){
  const m = new Map();
  occ().filter(x => x.crop === crop).sort((a, b) => (a.r === b.r ? 0 : a.r === "N" ? -1 : 1) || a.t - b.t || a.p - b.p).forEach(x => {
    const id = [x.date || "", x.ready ? "r" : "n", x.type === "old" ? "old" : "new", trayPlants(x)].join("|");
    if (!m.has(id)) m.set(id, { id, date: x.date, ready: !!x.ready, type: x.type === "old" ? "old" : "new", pl: trayPlants(x), keys: [] });
    m.get(id).keys.push(x.k);
  });
  return [...m.values()].sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
}
function keysSummary(keys){
  const by = {}; keys.forEach(k => { const q = parseKey(k); const g = q.r + q.t; (by[g] = by[g] || { r: q.r, t: q.t, ps: [] }).ps.push(q.p); });
  return Object.values(by).map(g => "T" + g.t + " " + g.r + ranges(g.ps).replace(/(, )(\d)/g, "$1" + g.r + "$2").replace(/–(\d)/g, "–" + g.r + "$1")).join(" · ");
}

function dateCtl(){
  const t = today();
  return '<h3>Date</h3><div class="l3r-date"><button data-r="dd" data-d="-1">◀</button><div class="d">' + esc(dateLong(rec.date)) + '</div><button data-r="dd" data-d="1">▶</button></div>' +
    '<div class="l3r-quick"><button data-r="dset" data-v="' + t + '" class="' + (rec.date === t ? "on" : "") + '">Today</button><button data-r="dset" data-v="' + addDays(t, -1) + '" class="' + (rec.date === addDays(t, -1) ? "on" : "") + '">Yesterday</button><input type="date" id="l3rDate" value="' + esc(rec.date) + '"></div>';
}
function numGrid(max){
  let h = '<div class="l3r-nums">'; for (let i = 1; i <= max; i++) h += '<button data-r="n" data-v="' + i + '" class="' + (rec.n === i ? "on" : "") + '">' + i + '</button>'; return h + '</div>';
}

function plantsPick(){
  const full = ppt(rec.crop), opts = [[full, "Full"], [Math.round(full * 0.75), "¾"], [Math.round(full / 2), "½"], [Math.round(full / 4), "¼"]];
  const cur = rec.plants || full;
  let h = '<h3>Plants per tray</h3><div class="l3r-two">';
  opts.forEach(o => { h += '<button data-r="pl" data-v="' + o[0] + '" class="' + (cur === o[0] ? "on" : "") + '">' + o[1] + '<br><small>' + o[0] + ' plants</small></button>'; });
  return h + '</div><div class="l3r-quick" style="grid-template-columns:1fr;"><input type="number" inputmode="numeric" id="l3rPl" min="1" placeholder="Other number of plants per tray" value="' + (opts.some(o => o[0] === cur) ? "" : cur) + '"></div>';
}
function recHtml(){
  const r = rec;
  let h = '<div class="l3r-in"><div class="l3r-top"><button data-r="back">← Back</button><button data-r="close">✕ Done</button></div>';
  if (r.msg) h += '<div class="l3r-msg">✓ ' + esc(r.msg) + '</div>';
  if (!r.crop){
    h += '<h2>Which crop?</h2><p class="sub">Record one crop at a time. Tap a crop.</p><div class="l3r-grid">';
    CROP_ORDER.forEach(c => { const s = cropStats(c); h += '<button data-r="crop" data-c="' + esc(c) + '"><b>' + esc(c) + '</b><span>' + s.free + ' free · ' + s.growing + ' growing · ' + s.ready + ' ready</span></button>'; });
    return h + '</div></div>';
  }
  const st = cropStats(r.crop);
  h += '<h2>' + esc(r.crop) + '</h2><p class="sub">' + st.used + ' of ' + st.cap + ' trays used · ' + st.free + ' free · ' + st.growing + ' growing · ' + st.ready + ' ready</p>';
  if (!r.action){
    h += '<h3>What do you want to do?</h3><div class="l3r-two">' +
      '<button data-r="action" data-a="transplant"' + (st.free ? "" : " disabled") + '>＋ Transplant<br><small>add trays</small></button>' +
      '<button data-r="action" data-a="ready"' + (st.growing ? "" : " disabled") + '>Mark ready<br><small>' + st.growing + ' growing</small></button>' +
      '<button data-r="action" data-a="harvest"' + (st.used ? "" : " disabled") + '>Harvest<br><small>remove trays</small></button>' +
      '<button data-r="action" data-a="dispose"' + (st.used ? "" : " disabled") + '>Dispose<br><small>remove trays</small></button></div>';
    return h + '</div></div>';
  }
  if (r.action === "transplant"){
    const slots = slotsFor(r.crop, state.trays), max = Math.min(slots.length, 13);
    if (r.n > max) r.n = max;
    h += '<h3>How many trays?</h3>' + numGrid(max) + dateCtl() +
      '<h3>New or old crop?</h3><div class="l3r-two"><button data-r="type" data-v="new" class="' + (r.type === "new" ? "on" : "") + '">New crop</button><button data-r="type" data-v="old" class="' + (r.type === "old" ? "on" : "") + '">Old crop</button></div>' +
      plantsPick() +
      '<h3>Status</h3><div class="l3r-two"><button data-r="status" data-v="0" class="' + (!r.ready ? "on" : "") + '">Not ready</button><button data-r="status" data-v="1" class="' + (r.ready ? "on" : "") + '">Ready</button></div>' +
      '<p class="sub" style="margin-top:14px;">Goes into: ' + esc(keysSummary(slots.slice(0, r.n))) + '</p>' +
      '<div class="l3r-save"><div class="in"><button class="go" data-r="saveTransplant">Save ' + r.n + ' ' + (r.n === 1 ? "tray" : "trays") + '</button></div></div>';
    return h + '</div></div>';
  }
  // ready / harvest / dispose: choose a group of trays, then how many
  const verb = { ready: "Mark ready", harvest: "Harvest", dispose: "Dispose" }[r.action];
  let groups = groupsFor(r.crop); if (r.action === "ready") groups = groups.filter(g => !g.ready);
  h += '<h3>' + verb + ' — which trays?</h3><p class="sub">Tap the batch (grouped by date planted).</p><div class="l3r-grid">';
  groups.forEach(g => { h += '<button data-r="grp" data-g="' + esc(g.id) + '" class="' + (r.grp === g.id ? "on" : "") + '"><b>' + esc(fmtFull(g.date)) + '</b><span>' + g.keys.length + ' ' + (g.keys.length === 1 ? "tray" : "trays") + ' · ' + g.pl + ' plants each · ' + (g.ready ? "Ready" : "Not ready") + ' · ' + (g.type === "old" ? "Old crop" : "New crop") + '</span></button>'; });
  h += '</div>';
  const g = groups.find(x => x.id === r.grp);
  if (g){
    if (r.n > g.keys.length || r.n < 1) r.n = g.keys.length;
    h += '<h3>How many of these trays?</h3>' + numGrid(Math.min(g.keys.length, 13));
    if (g.keys.length > 13) h += '<div class="l3r-two" style="margin-top:10px;"><button data-r="n" data-v="' + g.keys.length + '" class="' + (r.n === g.keys.length ? "on" : "") + '">All ' + g.keys.length + '</button></div>';
    if (r.action !== "ready"){
      const tot = plantsIn(g.keys);
      h += '<h3>Or an exact number of plants</h3><p class="sub">Whole trays are taken first, the rest stays as balance. Group has ' + tot + ' plants.</p><div class="l3r-quick" style="grid-template-columns:1fr;"><input type="number" inputmode="numeric" id="l3rAmt" min="1" max="' + tot + '" placeholder="Number of plants (leave blank for whole trays)" value="' + (r.amt || "") + '"></div>';
      h += dateCtl();
    }
    const amtOn = r.action !== "ready" && r.amt > 0;
    h += '<p class="sub" style="margin-top:14px;">Trays: ' + esc(keysSummary(g.keys.slice(0, amtOn ? g.keys.length : r.n))) + '</p>' +
      '<div class="l3r-save"><div class="in"><button class="go" data-r="saveAct">' + verb + ' ' + (amtOn ? r.amt + ' plants' : r.n + ' ' + (r.n === 1 ? "tray" : "trays")) + '</button></div></div>';
  }
  return h + '</div></div>';
}

function renderRec(){
  const ov = document.getElementById("l3rOverlay"); if (!ov) return;
  if (!rec){ ov.classList.remove("on"); ov.innerHTML = ""; return; }
  ov.innerHTML = recHtml(); ov.classList.add("on");
}

function recDone(msg){ rec.msg = msg; rec.action = null; rec.grp = null; rec.n = 1; renderRec(); document.getElementById("l3rOverlay").scrollTop = 0; }

function onRecChange(e){
  if (e.target && e.target.id === "l3rDate" && rec && e.target.value){ rec.date = e.target.value; renderRec(); }
  else if (e.target && e.target.id === "l3rPl" && rec){ rec.plants = parsePl(e.target.value); renderRec(); }
  else if (e.target && e.target.id === "l3rAmt" && rec){ rec.amt = parsePl(e.target.value); renderRec(); }
}

function onRecClick(e){
  const b = e.target.closest("[data-r]"); if (!b || !rec) return;
  const a = b.dataset.r;
  if (a !== "back" && a !== "close") rec.msg = "";
  if (a === "close"){ rec = null; renderRec(); return; }
  if (a === "back"){
    rec.msg = "";
    if (rec.grp) rec.grp = null; else if (rec.action) rec.action = null; else if (rec.crop) rec.crop = null; else { rec = null; renderRec(); return; }
  }
  else if (a === "crop"){ rec.crop = b.dataset.c; rec.action = null; rec.grp = null; }
  else if (a === "action"){ rec.action = b.dataset.a; rec.grp = null; rec.n = 1; rec.date = today(); rec.type = "new"; rec.ready = false; rec.plants = null; rec.amt = null; }
  else if (a === "n"){ rec.n = +b.dataset.v; rec.amt = null; }
  else if (a === "dd") rec.date = addDays(rec.date, +b.dataset.d);
  else if (a === "dset") rec.date = b.dataset.v;
  else if (a === "type") rec.type = b.dataset.v === "old" ? "old" : "new";
  else if (a === "status") rec.ready = b.dataset.v === "1";
  else if (a === "pl") rec.plants = +b.dataset.v;
  else if (a === "grp"){ rec.amt = null; rec.grp = b.dataset.g; const g = groupsFor(rec.crop).find(x => x.id === rec.grp); rec.n = g ? g.keys.length : 1; rec.date = today(); }
  else if (a === "saveTransplant"){
    const n = rec.n, crop = rec.crop, date = rec.date, type = rec.type, ready = rec.ready, d0 = today(), pl = rec.plants;
    if (!(n >= 1)) return;
    mutate(s => { slotsFor(crop, s.trays).slice(0, n).forEach(k => { const tr = { date, ready, readyDate: ready ? d0 : null, type }; setPl(tr, pl, crop); s.trays[k] = tr; }); })
      .then(ok => { if (ok && rec) recDone("Saved " + n + " × " + crop + " (" + fmtFull(date) + ")"); });
    return;
  }
  else if (a === "saveAct"){
    const crop = rec.crop, act = rec.action, g = groupsFor(crop).find(x => x.id === rec.grp); if (!g) return;
    const amt = act !== "ready" && rec.amt > 0 ? rec.amt : null, keys = amt ? g.keys : g.keys.slice(0, rec.n), date = rec.date, d0 = today();
    if (amt && amt > plantsIn(g.keys)) return alert("This group only has " + plantsIn(g.keys) + " plants.");
    mutate(s => {
      if (act === "ready"){ keys.forEach(k => { const tr = s.trays[k]; if (tr){ tr.ready = true; tr.readyDate = d0; } }); return; }
      takePlants(s, keys, amt, act === "harvest" ? "harvested" : "disposed", date, "");
    }).then(ok => { if (ok && rec) recDone({ ready: "Marked ", harvest: "Harvested ", dispose: "Disposed " }[act] + (amt ? amt + " plants of " : keys.length + " × ") + crop); });
    return;
  }
  renderRec();
}

// ---------------------------------------------------------------- events
function onClick(e){
  const m = e.target.closest("[data-m]");
  if (m){
    const a = m.dataset.m;
    if (a === "cancel") return closeModal();
    if (a === "saveTray") return saveTray(m.dataset.k);
    if (a === "trayExit"){
      const k = m.dataset.k, tr = state.trays[k], crop = cropOfKey(k), out = parsePl(val("l3mOut")), have = plOf(tr, crop);
      if (tr && out && out < have) return partialExit(k, m.dataset.kind, out);
      sel.clear(); sel.add(k); return openExit(m.dataset.kind);
    }
    if (a === "trayRemove"){
      if (!confirm("Empty this tray without recording it in the history? Use this for a mistaken entry.")) return;
      return mutate(s => { delete s.trays[m.dataset.k]; }).then(ok => { if (ok) closeModal(); });
    }
    if (a === "emptyMark") return setEmpty([m.dataset.k], m.dataset.v, (document.getElementById("l3mEmpDate") || {}).value).then(ok => { if (ok) closeModal(); });
    if (a === "saveTransplant") return saveTransplant(m.dataset.keys.split(","));
    if (a === "saveFill") return saveFill(m.dataset.r, +m.dataset.t);
    if (a === "saveExit") return saveExit(m.dataset.kind, m.dataset.keys.split(","));
    return;
  }
  if (e.target.id === "l3mOverlay") return closeModal();
  const t = e.target.closest("[data-action]");
  if (!t) return;
  const a = t.dataset.action;
  if (a === "cell"){ if (!isAdmin || Date.now() - suppressClick < 400) return; const k = t.dataset.k; if (multi){ sel.has(k) ? sel.delete(k) : sel.add(k); render(); } else openTray(k); }
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
    else if (x === "dirty" || x === "clean") setEmpty(emptyKeys(), x).then(ok => { if (ok){ sel.clear(); render(); } });
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
  else if (a === "recOpen" && isAdmin){ rec = { crop: null, action: null, n: 1, date: today(), type: "new", ready: false, grp: null, msg: "" }; renderRec(); }
  else if (a === "undo") undo();
  else if (a === "import") importOld();
  else if (a === "toggleDates"){ showDates = !showDates; render(); }
  else if (a === "history"){ showHistory = !showHistory; render(); }
  else if (a === "logMore"){ logN += 20; render(); }
  else if (a === "logWho"){ logWho = t.dataset.who || "all"; logN = 20; render(); }
}

// ---------------------------------------------------------------- press-and-hold to drag a tray to another slot
const HOLD_MS = 450;
let dnd = null, suppressClick = 0;
function dndCellAt(x, y){ const el = document.elementFromPoint(x, y); return el ? el.closest('.l3m-cell[data-k]') : null; }
function dndClear(){
  if (!dnd) return;
  clearTimeout(dnd.timer);
  if (dnd.ghost) dnd.ghost.remove();
  if (dnd.src) dnd.src.classList.remove("lp");
  if (dnd.over) dnd.over.classList.remove("drop");
  dnd = null;
}
function dndStart(e){
  if (!isAdmin || multi || (e.pointerType === "mouse" && e.button !== 0)) return;
  const cell = e.target.closest('.l3m-cell[data-k]'); if (!cell) return;
  const k = cell.dataset.k; if (!state.trays[k]) return;
  dnd = { k, src: cell, x: e.clientX, y: e.clientY, active: false, over: null, ghost: null, timer: null };
  dnd.timer = setTimeout(() => {
    if (!dnd) return;
    dnd.active = true; cell.classList.add("lp");
    const g = document.createElement("div"); g.className = "l3m-ghost";
    const q = parseKey(k); g.textContent = "Move " + label(q.r, q.t, q.p) + " · " + cropOfKey(k);
    g.style.left = dnd.x + "px"; g.style.top = dnd.y + "px"; document.body.appendChild(g); dnd.ghost = g;
    if (navigator.vibrate) navigator.vibrate(30);
  }, HOLD_MS);
}
function dndMove(e){
  if (!dnd) return;
  if (!dnd.active){ if (Math.abs(e.clientX - dnd.x) > 10 || Math.abs(e.clientY - dnd.y) > 10) dndClear(); return; }
  dnd.x = e.clientX; dnd.y = e.clientY;
  dnd.ghost.style.left = e.clientX + "px"; dnd.ghost.style.top = e.clientY + "px";
  const c = dndCellAt(e.clientX, e.clientY);
  if (dnd.over && dnd.over !== c) dnd.over.classList.remove("drop");
  dnd.over = c && c !== dnd.src ? c : null;
  if (dnd.over) dnd.over.classList.add("drop");
  if (e.clientY < 70) window.scrollBy(0, -14); else if (e.clientY > window.innerHeight - 70) window.scrollBy(0, 14);
}
function moveTray(from, to){
  const toTier = tierCropOfKey(to);
  mutate(s => {
    const a = s.trays[from], b = s.trays[to]; if (!a) return;
    const ca = cropOfKey(from, s.trays), cb = b ? cropOfKey(to, s.trays) : null;
    delete s.trays[from];
    if (b){
      if (cb !== tierCropOfKey(from)) b.crop = cb; else delete b.crop;
      s.trays[from] = b;
    }
    if (ca !== toTier) a.crop = ca; else delete a.crop;
    s.trays[to] = a;
  });
}
function dndEnd(e){
  if (!dnd) return;
  const was = dnd.active, from = dnd.k, over = dnd.over;
  dndClear();
  if (!was) return;
  suppressClick = Date.now();
  if (!over) return;
  const to = over.dataset.k;
  if (state.trays[to]){
    const q = parseKey(to), f = parseKey(from);
    if (!confirm("Swap " + label(f.r, f.t, f.p) + " with " + label(q.r, q.t, q.p) + "?")) return;
  }
  moveTray(from, to);
}
if (root){
  root.addEventListener("pointerdown", dndStart);
  document.addEventListener("pointermove", dndMove);
  document.addEventListener("pointerup", dndEnd);
  document.addEventListener("pointercancel", () => { if (dnd && dnd.active) suppressClick = Date.now(); dndClear(); });
  document.addEventListener("touchmove", (e) => { if (dnd && dnd.active) e.preventDefault(); }, { passive: false });
  root.addEventListener("contextmenu", (e) => { if (e.target.closest(".l3m-cell")) e.preventDefault(); });
}

if (root) init();
