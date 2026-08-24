// ============================================================================
// Indoor Farm — Takeover Tracker
// Firebase (Firestore + Auth) + Cloudinary rewrite.
// ============================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  addDoc, query, where, onSnapshot, writeBatch, serverTimestamp, enableIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const firebaseApp = initializeApp(window.FIREBASE_CONFIG);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

// Farm wifi is unreliable, and the kiosk in particular can't afford to just lose a
// check-in/check-out because the connection blipped. This caches reads and queues
// writes in IndexedDB so the app keeps working offline and syncs once back online.
// Fails harmlessly if another tab already holds the persistence lock (failed-precondition)
// or the browser doesn't support it (unimplemented) — the app just runs online-only then.
enableIndexedDbPersistence(db).catch(() => {});

const START_DATE = "2026-07-28";
const HORIZON_DAYS = 120;
const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const DAY_TYPES = ["visitor", "maintenance", "holiday"];
const DAY_TYPE_LABELS = {
  visitor: "Visitors on site",
  maintenance: "Maintenance day — No visitors",
  holiday: "Holiday / Off Day — Farm closed"
};
const DAY_TYPE_TAG_LABELS = { visitor: "Visitors", maintenance: "No visitors", holiday: "Holiday" };

// ============================================================================
// Small helpers
// ============================================================================
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,8); }
function toDate(s){ const p = s.split("-"); return new Date(parseInt(p[0]), parseInt(p[1]) - 1, parseInt(p[2])); }
function toKey(d){ return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0"); }
const SHORT_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
// Day-then-month ("25 Jul") regardless of viewer locale — toLocaleDateString would
// otherwise flip to month-first on some devices.
function fmtFriendlyDate(key){
  if (!key) return "?";
  const d = toDate(key);
  return d.getDate() + " " + SHORT_MONTHS[d.getMonth()];
}
function inRange(key){ return key >= START_DATE; }
// Night shift runs 19:00-07:00, crossing midnight. Before 07:00 the farm day still
// in progress is yesterday's, so "today" for schedule/attendance purposes needs this
// instead of the raw calendar date, or everything tied to the night shift breaks the
// moment the clock passes midnight.
function farmTodayKey(){
  const d = new Date();
  if (d.getHours() < 7) d.setDate(d.getDate() - 1);
  return toKey(d);
}
function horizonEnd(fromKey){
  const d = fromKey ? toDate(fromKey) : new Date();
  d.setDate(d.getDate() + HORIZON_DAYS);
  return toKey(d);
}
function nowTimeStr(){
  const d = new Date();
  return String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0");
}
// Sort key for a day's event list: the farm day runs 07:00-07:00, so a task that starts
// before 07:00 (the tail end of the night shift, technically the next calendar date) needs
// to sort after everything from that evening instead of jumping to the top of the list —
// otherwise a 01:00 task added after midnight looks like it happens before the morning shift.
function scheduleSortKey(t){
  const [h, m] = t.split(":").map(Number);
  return (h < 7 ? h + 24 : h) * 60 + m;
}
function eventTimeStatus(ev, isToday){
  if (!isToday) return "";
  // scheduleSortKey() places every time on the same 07:00-to-07:00 farm-day axis, so
  // comparing keys instead of raw "HH:MM" strings handles overnight events for free —
  // no separate branch needed. Without this, an evening task (e.g. 21:30-23:00) looked
  // "not started yet" instead of "past" once now (e.g. 03:48) sorted before it as a string.
  const now = scheduleSortKey(nowTimeStr());
  const start = scheduleSortKey(ev.start);
  const end = scheduleSortKey(ev.end);
  if (now >= end) return "past";
  if (now >= start) return "current";
  return "";
}
function escapeHtml(s){
  return String(s || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function $(id){ return document.getElementById(id); }

// Reads a text input's trimmed value; if empty, alerts, focuses the field, and returns null so
// the caller can bail out — used by every "Add" button so a missing required field is obvious
// instead of the button silently doing nothing.
function requireValue(input, label){
  const val = input.value.trim();
  if (!val){ alert("Please enter " + label + " before adding."); input.focus(); return null; }
  return val;
}

function defaultDay(key){
  const d = toDate(key);
  const isMonday = d.getDay() === 1;
  return {
    dayType: isMonday ? "maintenance" : "visitor",
    events: [
      { id: "morning-default", start: "07:00", end: "19:00", title: "Morning Shift", person: "", notes: "" },
      { id: "night-default",   start: "19:00", end: "07:00", title: "Night Shift",   person: "", notes: "" }
    ]
  };
}

// ============================================================================
// Sync status indicator
// ============================================================================
function setSyncStatus(state, text){
  const dot = $("syncDot");
  dot.className = "sync-dot " + state;
  $("syncText").textContent = text;
}
let listenersReady = 0;
const TOTAL_CORE_LISTENERS = 4; // schedule, series, houseRules, staff (findings loads on notes tab too, counted separately below)
function markListenerReady(){
  listenersReady++;
  if (listenersReady >= TOTAL_CORE_LISTENERS) setSyncStatus("ok", "Synced");
}

// ============================================================================
// ADMIN AUTH (Firebase Authentication)
// ============================================================================
let isAdmin = false;
let navRestored = false;

// Covers the page from first paint until the right tab is picked, so a refresh never
// flashes the default Cal & Events view before jumping to the last tab you were on.
// The timeout is a safety net only — if auth somehow never resolves, don't leave
// visitors staring at a spinner forever.
function hideAppLoadingOverlay(){
  const el = $("appLoadingOverlay");
  if (!el) return;
  el.classList.add("hidden");
  setTimeout(() => el.remove(), 200);
}
setTimeout(hideAppLoadingOverlay, 5000);

onAuthStateChanged(auth, (user) => {
  isAdmin = !!user;
  // Restore nav position first and independently of every render call below — if any of
  // them threw, this line would never run and every refresh would silently land back on
  // the default tab instead of wherever the user actually was.
  try {
    if (!navRestored){ navRestored = true; restoreNavState(); }
  } finally {
    hideAppLoadingOverlay();
  }
  refreshAdminUI();
  renderCalendar();
  renderDailySchedule();
  renderAttendance();
  renderStaffList();
  renderRules();
  renderFindings();
  renderProposals();
  renderPlantGuide();
  renderSpecialEvents();
  renderPlantTypes();
  renderHarvestDestinations();
  Object.keys(LOG_CONFIGS).forEach(renderLogSection);
  renderEnvReadings();
  renderTanks();
  if (isDashboardActive()) renderDashboard();
  renderAssets();
  renderConsumables();
  renderPurchaseAreas();
  renderPurchasePlans();
  if (isPurchaseDashboardActive()) renderPurchaseDashboard();
  renderReports();
  renderClaims();
  renderReorderAlertBanner();
});

// Firebase re-checks whether you're still logged in on every page load, which takes a
// brief moment (it's reading persisted session data, not instant) — until it resolves,
// isAdmin is false and every admin-only element sits at its default hidden state. For a
// returning admin, that means the nav's admin-only elements pop in abruptly right after
// load instead of just being there from the start. A fade softens the pop into something
// that reads as "still loading" rather than "glitching" — scoped to the header/nav
// elements a returning admin actually notices popping in, not the whole admin surface.
function setAdminVisible(id, display){
  const el = $(id);
  const wasHidden = el.style.display === "none" || el.style.display === "";
  el.style.display = isAdmin ? display : "none";
  if (isAdmin && wasHidden) el.classList.add("admin-fade-in");
  else el.classList.remove("admin-fade-in");
}

function refreshAdminUI(){
  setAdminVisible("adminArea", "flex");
  $("addRuleRow").style.display = isAdmin ? "flex" : "none";
  $("addFindingRow").style.display = isAdmin ? "flex" : "none";
  $("downloadFindingsPdfBtn").style.display = isAdmin ? "inline-block" : "none";
  $("addProposalRow").style.display = isAdmin ? "flex" : "none";
  $("addPlantRow").style.display = isAdmin ? "flex" : "none";
  $("addSpecialEventRow").style.display = isAdmin ? "flex" : "none";
  $("dsAddEventBtn").style.display = isAdmin ? "inline-block" : "none";
  $("dsResetBtn").style.display = isAdmin ? "inline-block" : "none";
  $("addAttRow").style.display = isAdmin ? "flex" : "none";
  $("staffToggleRow").style.display = isAdmin ? "block" : "none";
  $("plantTypesToggleRow").style.display = isAdmin ? "block" : "none";
  $("destinationsToggleRow").style.display = isAdmin ? "block" : "none";
  $("quickHarvestPhotoRow").style.display = isAdmin ? "flex" : "none";
  $("addHarvestsRow").style.display = isAdmin ? "flex" : "none";
  $("addTransplantsRow").style.display = isAdmin ? "flex" : "none";
  $("addGerminationsRow").style.display = isAdmin ? "flex" : "none";
  $("addLossesRow").style.display = isAdmin ? "flex" : "none";
  $("addEnvReadingsRow").style.display = isAdmin ? "flex" : "none";
  $("tanksToggleRow").style.display = isAdmin ? "block" : "none";
  $("addAssetRow").style.display = isAdmin ? "flex" : "none";
  $("addConsumableRow").style.display = isAdmin ? "flex" : "none";
  $("addAssetPurchaseRow").style.display = isAdmin ? "flex" : "none";
  $("addConsumablePurchaseRow").style.display = isAdmin ? "flex" : "none";
  $("purchaseAreasToggleRow").style.display = isAdmin ? "block" : "none";
  $("purchaseDashboardBtn").style.display = isAdmin ? "inline-block" : "none";
  setAdminVisible("reportsTabBtn", "inline-block");
  $("addReportRow").style.display = isAdmin ? "flex" : "none";
  setAdminVisible("dataTabBtn", "inline-block");
  // Claims are admin-only to even view (firestore.rules gates reads, not just writes),
  // so the subtab button itself is hidden rather than just its add-row.
  $("claimsSubtabBtn").style.display = isAdmin ? "" : "none";
  $("addClaimRow").style.display = isAdmin ? "flex" : "none";
  $("quickClaimPhotoRow").style.display = isAdmin ? "flex" : "none";
  $("downloadClaimsPdfBtn").style.display = isAdmin ? "inline-block" : "none";
  if (isAdmin) subscribeClaims();
  if (!isAdmin){
    $("staffPanel").style.display = "none";
    $("plantTypesPanel").style.display = "none";
    $("destinationsPanel").style.display = "none";
    $("purchaseAreasPanel").style.display = "none";
    $("tanksPanel").style.display = "none";
    if (document.querySelector('#tab-inventory .subtab-panel[data-subtab="purchaseDashboard"]').classList.contains("active")){
      document.querySelector('#tab-inventory .subtab-btn[data-subtab="assets"]').click();
    }
    if (document.querySelector('#tab-opslog .subtab-panel[data-subtab="claims"]').classList.contains("active")){
      document.querySelector('#tab-opslog .subtab-btn[data-subtab="rules"]').click();
    }
    if ($("tab-data").classList.contains("active") || $("tab-reports").classList.contains("active")) activateTab("calendar");
  }
}

$("adminToggleBtn").addEventListener("click", () => { signOut(auth); });

const loginOverlay = $("loginOverlay");
function openLoginModal(){
  $("loginEmail").value = "";
  $("loginPassword").value = "";
  $("loginError").style.display = "none";
  loginOverlay.classList.add("active");
  setTimeout(() => $("loginEmail").focus(), 50);
}
function closeLoginModal(){ loginOverlay.classList.remove("active"); }
$("loginCancel").addEventListener("click", closeLoginModal);
$("loginSubmit").addEventListener("click", async () => {
  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;
  $("loginError").style.display = "none";
  try {
    await signInWithEmailAndPassword(auth, email, password);
    closeLoginModal();
  } catch (e){
    $("loginError").textContent = "Login failed — check the email and password (create the user in the Firebase console first; see SETUP.md).";
    $("loginError").style.display = "block";
  }
});
$("loginPassword").addEventListener("keydown", (e) => { if (e.key === "Enter") $("loginSubmit").click(); });

// secret entry points — nothing on screen advertises these to viewers
let titleClicks = [];
$("siteTitle").addEventListener("click", () => {
  if (isAdmin) return;
  const now = Date.now();
  titleClicks.push(now);
  titleClicks = titleClicks.filter(t => now - t < 2000);
  if (titleClicks.length >= 5){ titleClicks = []; openLoginModal(); }
});
window.addEventListener("keydown", (e) => {
  if (!isAdmin && e.ctrlKey && e.altKey && (e.key === "a" || e.key === "A")) openLoginModal();
});

// ============================================================================
// TABS
// ============================================================================
const TAB_GROUPS = {
  calendar: "calgroup", schedule: "calgroup", specialEvents: "calgroup",
  rules: "opslog", findings: "opslog", attendance: "opslog"
};
function activateTab(name){
  const group = TAB_GROUPS[name] || name;
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === group));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("active", p.id === "tab-" + group));
  if (TAB_GROUPS[name]){
    const groupPanel = $("tab-" + group);
    groupPanel.querySelectorAll(".subtab-btn").forEach(b => b.classList.toggle("active", b.dataset.subtab === name));
    groupPanel.querySelectorAll(".subtab-panel").forEach(p => p.classList.toggle("active", p.dataset.subtab === name));
  }
  saveNavState();
}
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => activateTab(btn.dataset.tab));
});

// Data and Report both live as buttons beside Admin/Log out instead of nav tabs, so
// logging in as admin doesn't add extra tabs and shift the nav bar's spacing every
// time — neither is a ".tab-btn" (that class also carries the bottom-nav mobile layout,
// which would make it act like a stray icon there instead of sitting quietly in the header).
$("dataTabBtn").addEventListener("click", () => activateTab("data"));
$("reportsTabBtn").addEventListener("click", () => activateTab("reports"));

document.querySelectorAll(".subtab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const container = btn.closest(".tab-panel");
    const key = btn.dataset.subtab;
    container.querySelectorAll(".subtab-btn").forEach(b => b.classList.toggle("active", b === btn));
    container.querySelectorAll(".subtab-panel").forEach(p => p.classList.toggle("active", p.dataset.subtab === key));
    if (container.id === "tab-growlog" && key === "dashboard") renderDashboard();
    if (container.id === "tab-inventory" && key === "purchaseDashboard") renderPurchaseDashboard();
    saveNavState();
  });
});

// Remembers which tab/subtab you're on across a refresh, so reloading the page (or
// coming back later) puts you back where you left off instead of resetting to Cal &
// Events every time. Scoped to nav state only — not scroll position, filters, or
// which cards are expanded, just "which page was I on."
function saveNavState(){
  const activePanel = document.querySelector(".tab-panel.active");
  if (!activePanel) return;
  const tabName = activePanel.id.slice(4);
  localStorage.setItem("lastTab", tabName);
  const activeSubtabBtn = activePanel.querySelector(".subtab-btn.active");
  if (activeSubtabBtn) localStorage.setItem("lastSubtab:" + tabName, activeSubtabBtn.dataset.subtab);
  else localStorage.removeItem("lastSubtab:" + tabName);
}
function restoreNavState(){
  const tabName = localStorage.getItem("lastTab");
  if (!tabName || !$("tab-" + tabName)) return;
  // Reports/Data are admin-only tools; don't strand a logged-out visitor on one just
  // because an admin was last there on this browser.
  if ((tabName === "reports" || tabName === "data") && !isAdmin) return;
  const subtab = localStorage.getItem("lastSubtab:" + tabName);
  activateTab(subtab && TAB_GROUPS[subtab] ? subtab : tabName);
  if (subtab && !TAB_GROUPS[subtab]){
    const btn = document.querySelector('#tab-' + tabName + ' .subtab-btn[data-subtab="' + subtab + '"]');
    if (btn) btn.click();
  }
}

// ============================================================================
// SCHEDULE DATA (Firestore: schedule/{date}, series/{id})
// ============================================================================
let scheduleCache = {};   // date -> { dayType, events: [...] }  (only dates that exist in Firestore)
let seriesCache = [];     // [{ id, title, start, end, person, notes, fromDate }]

function migrateEntry(key, entry){
  if (!entry.events) entry.events = defaultDay(key).events;
  if (!entry.dayType) entry.dayType = defaultDay(key).dayType;
  return entry;
}

// Read-only view of a day: returns cached Firestore data if it exists, otherwise
// a computed default WITHOUT writing anything (reads must never trigger writes).
function viewDay(key){
  if (scheduleCache[key]) return migrateEntry(key, scheduleCache[key]);
  return defaultDay(key);
}

// Returns a deep-cloned, mutable copy of a day's data for editing.
function editableDay(key){
  const base = viewDay(key);
  return JSON.parse(JSON.stringify(base));
}

async function saveDay(key, entry){
  scheduleCache[key] = entry; // optimistic local update
  await setDoc(doc(db, "schedule", key), entry);
}

onSnapshot(collection(db, "schedule"), (snap) => {
  const next = {};
  snap.forEach(d => { next[d.id] = migrateEntry(d.id, d.data()); });
  scheduleCache = next;
  renderCalendar();
  renderDailySchedule();
  markListenerReady();
}, () => setSyncStatus("err", "Connection error"));

onSnapshot(collection(db, "series"), (snap) => {
  seriesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  markListenerReady();
}, () => setSyncStatus("err", "Connection error"));

// ============================================================================
// CALENDAR TAB
// ============================================================================
const todayNow = new Date();
let viewYear = todayNow.getFullYear(), viewMonth = todayNow.getMonth();
let highlightDate = null;

$("calGoToDate").min = START_DATE;
$("calGoToDate").value = toKey(todayNow);
const dowRow = $("dowRow");
DOW.forEach(d => { const el = document.createElement("div"); el.className = "dow"; el.textContent = d; dowRow.appendChild(el); });

function renderCalendar(){
  $("calTitle").textContent = new Date(viewYear, viewMonth, 1).toLocaleString("default",{month:"long"}) + " " + viewYear;
  const grid = $("calGrid");
  grid.innerHTML = "";

  const firstOfMonth = new Date(viewYear, viewMonth, 1);
  const startWeekday = firstOfMonth.getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

  for (let i = 0; i < startWeekday; i++){
    const blank = document.createElement("div");
    blank.className = "day-cell out-of-range";
    grid.appendChild(blank);
  }

  for (let day = 1; day <= daysInMonth; day++){
    const d = new Date(viewYear, viewMonth, day);
    const key = toKey(d);
    const cell = document.createElement("div");
    cell.className = "day-cell";

    if (!inRange(key)){
      cell.classList.add("out-of-range");
      const num = document.createElement("div");
      num.className = "day-num";
      num.textContent = day;
      cell.appendChild(num);
      grid.appendChild(cell);
      continue;
    }

    const entry = viewDay(key);
    if (entry.dayType === "maintenance") cell.classList.add("maintenance");
    if (entry.dayType === "holiday") cell.classList.add("holiday");
    if (key === farmTodayKey()) cell.classList.add("today");
    if (key === highlightDate) cell.classList.add("search-highlight");

    const specialToday = specialEventsCache.filter(ev => key >= (ev.startDate || "") && key <= (ev.endDate || ev.startDate || ""));
    if (specialToday.length) cell.classList.add("has-special");

    const numRow = document.createElement("div");
    numRow.className = "day-num";
    const tagClass = entry.dayType === "visitor" ? "visitor" : (entry.dayType === "holiday" ? "holiday" : "maint");
    numRow.innerHTML = "<span>" + day + "</span>" + '<span class="day-tag ' + tagClass + '">' + DAY_TYPE_TAG_LABELS[entry.dayType] + '</span>';
    cell.appendChild(numRow);

    const summary = document.createElement("div");
    summary.className = "day-summary";
    specialToday.forEach(ev => {
      const line = document.createElement("span");
      line.className = "ev special";
      line.textContent = "★ " + ev.title;
      summary.appendChild(line);
    });
    const sorted = entry.events.slice().sort((a,b) => scheduleSortKey(a.start) - scheduleSortKey(b.start));
    sorted.slice(0,3).forEach(ev => {
      const line = document.createElement("span");
      line.className = "ev";
      line.textContent = ev.start + " " + ev.title + (ev.person ? " — " + ev.person : "");
      summary.appendChild(line);
    });
    if (sorted.length > 3){
      const more = document.createElement("span");
      more.className = "ev";
      more.textContent = "+" + (sorted.length - 3) + " more";
      summary.appendChild(more);
    }
    cell.appendChild(summary);

    cell.addEventListener("click", () => {
      selectedDate = key;
      $("dsDatePicker").value = key;
      activateTab("schedule");
      renderDailySchedule();
    });

    grid.appendChild(cell);
  }
}

$("prevMonth").addEventListener("click", () => { viewMonth--; if (viewMonth < 0){ viewMonth = 11; viewYear--; } renderCalendar(); });
$("nextMonth").addEventListener("click", () => { viewMonth++; if (viewMonth > 11){ viewMonth = 0; viewYear++; } renderCalendar(); });

function jumpCalendarToDate(key){
  const d = toDate(key);
  viewYear = d.getFullYear(); viewMonth = d.getMonth();
  highlightDate = key;
  $("calGoToDate").value = key;
  renderCalendar();
  setTimeout(() => { if (highlightDate === key){ highlightDate = null; renderCalendar(); } }, 2000);
}
$("calTodayBtn").addEventListener("click", () => jumpCalendarToDate(farmTodayKey()));
$("calGoToDate").addEventListener("change", (e) => { if (e.target.value) jumpCalendarToDate(e.target.value); });

// ============================================================================
// DAILY SCHEDULE TAB
// ============================================================================
const todayKeyGlobal = farmTodayKey();
let selectedDate = inRange(todayKeyGlobal) ? todayKeyGlobal : START_DATE;

const dsDatePicker = $("dsDatePicker");
dsDatePicker.min = START_DATE;
dsDatePicker.value = selectedDate;
dsDatePicker.addEventListener("change", () => {
  if (dsDatePicker.value){
    selectedDate = dsDatePicker.value < START_DATE ? START_DATE : dsDatePicker.value;
    dsDatePicker.value = selectedDate;
    renderDailySchedule();
  }
});
function shiftDay(delta){
  const d = toDate(selectedDate);
  d.setDate(d.getDate() + delta);
  const key = toKey(d);
  if (key < START_DATE) return;
  selectedDate = key;
  dsDatePicker.value = key;
  renderDailySchedule();
}
$("dsPrevDay").addEventListener("click", () => shiftDay(-1));
$("dsNextDay").addEventListener("click", () => shiftDay(1));
$("dsToday").addEventListener("click", () => {
  const t = farmTodayKey();
  selectedDate = inRange(t) ? t : START_DATE;
  dsDatePicker.value = selectedDate;
  renderDailySchedule();
});

function renderDailySchedule(){
  const d = toDate(selectedDate);
  $("dsDateTitle").textContent = d.toLocaleDateString("default",{weekday:"long", month:"long", day:"numeric", year:"numeric"});

  const entry = viewDay(selectedDate);
  const statusEl = $("dsStatus");
  const statusClass = entry.dayType === "visitor" ? "visitor" : (entry.dayType === "holiday" ? "holiday" : "maint");
  statusEl.textContent = DAY_TYPE_LABELS[entry.dayType];
  statusEl.className = "ds-status " + statusClass + (isAdmin ? " clickable" : "");
  $("dsStatusHint").style.display = isAdmin ? "block" : "none";
  statusEl.onclick = isAdmin ? async () => {
    const fresh = editableDay(selectedDate);
    const idx = DAY_TYPES.indexOf(fresh.dayType);
    fresh.dayType = DAY_TYPES[(idx + 1) % DAY_TYPES.length];
    await saveDay(selectedDate, fresh);
    renderDailySchedule();
  } : null;

  const isToday = selectedDate === farmTodayKey();
  const nowClock = $("dsNowClock");
  if (isToday){
    nowClock.textContent = "Now " + nowTimeStr();
    nowClock.style.display = "inline";
  } else {
    nowClock.style.display = "none";
  }

  const list = $("dsEventList");
  list.innerHTML = "";

  const shiftItems = entry.events.map(ev => ({
    start: ev.start, end: ev.end, title: ev.title, person: ev.person, notes: ev.notes, id: ev.id, isSpecial: false
  }));
  const specialItems = specialEventsCache
    .filter(ev => selectedDate >= (ev.startDate || "") && selectedDate <= (ev.endDate || ev.startDate || ""))
    .map(ev => ({
      start: ev.startTime || "00:00", end: ev.endTime || ev.startTime || "23:59",
      title: ev.title, notes: ev.notes, allDay: !ev.startTime, id: ev.id, isSpecial: true
    }));
  const sorted = shiftItems.concat(specialItems).sort((a,b) => (a.allDay ? -1 : scheduleSortKey(a.start)) - (b.allDay ? -1 : scheduleSortKey(b.start)));

  if (sorted.length === 0){
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No events scheduled for this day.";
    list.appendChild(empty);
  }

  sorted.forEach(ev => {
    const row = document.createElement("div");

    if (ev.isSpecial){
      row.className = "event-row special";
      const time = document.createElement("div");
      time.className = "event-time";
      time.textContent = ev.allDay ? "All day" : (ev.start + " – " + ev.end);
      row.appendChild(time);

      const body = document.createElement("div");
      body.className = "event-body";
      const title = document.createElement("div");
      title.className = "event-title";
      title.textContent = ev.title;
      const tag = document.createElement("span");
      tag.className = "event-special-tag"; tag.textContent = "SPECIAL EVENT";
      title.appendChild(tag);
      body.appendChild(title);
      if (ev.notes){
        const notes = document.createElement("div");
        notes.className = "event-notes";
        notes.textContent = ev.notes;
        body.appendChild(notes);
      }
      row.appendChild(body);

      row.addEventListener("click", () => {
        activateTab("specialEvents");
        expandedSpecialEvents[ev.id] = true;
        renderSpecialEvents();
      });

      list.appendChild(row);
      return;
    }

    const timeStatus = eventTimeStatus(ev, isToday);
    row.className = "event-row" + (timeStatus ? " " + timeStatus : "");

    const time = document.createElement("div");
    time.className = "event-time";
    time.textContent = ev.start + " – " + ev.end;
    if (timeStatus === "current"){
      const pill = document.createElement("span");
      pill.className = "now-pill";
      pill.textContent = "NOW";
      time.appendChild(pill);
    }

    const body = document.createElement("div");
    body.className = "event-body";
    const title = document.createElement("div");
    title.className = "event-title";
    title.textContent = ev.title;
    const person = document.createElement("div");
    person.className = "event-person" + (ev.person ? "" : " empty");
    person.textContent = ev.person ? "In charge: " + ev.person : "Unassigned";
    body.appendChild(title);
    body.appendChild(person);
    if (ev.notes){
      const notes = document.createElement("div");
      notes.className = "event-notes";
      notes.textContent = ev.notes;
      body.appendChild(notes);
    }

    row.appendChild(time);
    row.appendChild(body);

    if (isAdmin){
      const actions = document.createElement("div");
      actions.className = "event-actions";
      const editBtn = document.createElement("button");
      editBtn.className = "icon-btn";
      editBtn.textContent = "✎";
      editBtn.title = "Edit";
      editBtn.addEventListener("click", () => openEventModal(selectedDate, ev.id));
      actions.appendChild(editBtn);
      row.appendChild(actions);
      row.style.cursor = "pointer";
      row.addEventListener("click", (e) => { if (e.target === editBtn) return; openEventModal(selectedDate, ev.id); });
    }

    list.appendChild(row);
  });
}

setInterval(() => {
  if (selectedDate === farmTodayKey()) renderDailySchedule();
}, 60000);

$("dsAddEventBtn").addEventListener("click", () => { if (isAdmin) openEventModal(selectedDate, null); });

$("dsResetBtn").addEventListener("click", async () => {
  if (!isAdmin) return;
  if (!confirm("Reset this day's Morning/Night shifts and day type back to default? Other custom events are kept.")) return;
  const entry = editableDay(selectedDate);
  const def = defaultDay(selectedDate);
  entry.dayType = def.dayType;
  ["morning-default","night-default"].forEach(id => {
    const defEv = def.events.find(e => e.id === id);
    const existing = entry.events.find(e => e.id === id);
    if (existing){ existing.start = defEv.start; existing.end = defEv.end; existing.title = defEv.title; existing.person = ""; existing.notes = ""; }
    else entry.events.push(defEv);
  });
  await saveDay(selectedDate, entry);
  renderDailySchedule();
});

// ============================================================================
// EVENT EDIT MODAL (+ recurring series)
// ============================================================================
const overlay = $("overlay");
let editingDate = null, editingEventId = null;
let modalIsNewEvent = true;
let modalHasSeries = false;

const REPEAT_FREQUENCY_TEXT = {
  daily: "every day, including maintenance Mondays — skipping only days marked as a holiday / off day",
  weekly: "every week on this same weekday",
  biweekly: "every 2 weeks on this same weekday",
  monthly: "every month on this same day of the month",
  yearly: "every year on this same date",
  visitorOnly: "on every visitor day (skipping maintenance and holiday days)",
  noVisitorOnly: "on every maintenance day (skipping visitor and holiday days)"
};
function updateRepeatHint(){
  const freq = $("fFrequency").value;
  if (freq === "none"){
    $("repeatHint").textContent = "This event happens once, on this date only.";
    return;
  }
  const freqText = REPEAT_FREQUENCY_TEXT[freq] || REPEAT_FREQUENCY_TEXT.daily;
  if (modalHasSeries){
    $("repeatHint").textContent = "Save with \"This and all future days in the series\" selected above to switch this series to happen " + freqText + " going forward — future days that no longer match are removed, and newly-matching days are added automatically.";
  } else {
    $("repeatHint").textContent = (modalIsNewEvent ? "Happens " : "Turns this into a recurring series starting today that happens ") + freqText + ". Keeps going indefinitely until you delete the series.";
  }
}
$("fFrequency").addEventListener("change", updateRepeatHint);

function openEventModal(dateKey, eventId){
  if (!isAdmin) return;
  editingDate = dateKey; editingEventId = eventId;
  const entry = viewDay(dateKey);
  const isNew = !eventId;
  const ev = isNew ? { start:"09:00", end:"10:00", title:"", person:"", notes:"" } : entry.events.find(e => e.id === eventId);

  $("modalTitle").textContent = isNew ? "Add Event" : "Edit Event";
  $("modalSub").textContent = toDate(dateKey).toLocaleDateString("default",{weekday:"long", month:"long", day:"numeric", year:"numeric"});
  $("fStart").value = ev.start;
  $("fEnd").value = ev.end;
  $("fTitle").value = ev.title;
  $("fPerson").value = ev.person;
  $("fNotes").value = ev.notes;
  $("deleteEventBtn").style.display = isNew ? "none" : "inline-block";

  const seriesBtn = $("deleteSeriesBtn");
  const scopeRow = $("seriesScopeRow");
  const hasSeries = !isNew && ev.seriesId;
  seriesBtn.style.display = hasSeries ? "inline-block" : "none";
  scopeRow.style.display = hasSeries ? "block" : "none";
  if (hasSeries) document.querySelector('input[name=seriesScope][value=one]').checked = true;

  // The repeat-pattern dropdown is always shown, for both new/one-off events and events
  // already part of a series — picking anything other than "Does not repeat" on a one-off
  // event turns it into a new series; changing the pattern on an existing series event applies
  // when saved with "this and all future days" (see the scope radios above).
  modalIsNewEvent = isNew;
  modalHasSeries = !!hasSeries;
  $("fFrequency").value = hasSeries ? ((seriesCache.find(s => s.id === ev.seriesId) || {}).frequency || "daily") : "none";
  updateRepeatHint();

  overlay.classList.add("active");
}
function closeEventModal(){ overlay.classList.remove("active"); editingDate = null; editingEventId = null; }
$("cancelBtn").addEventListener("click", closeEventModal);
overlay.addEventListener("click", (e) => { if (e.target === overlay) closeEventModal(); });

// ============================================================================
// TRAY EDIT MODAL — quick date/quantity correction from a Growing Stock card,
// without having to go find the same batch in the Transfer log.
// ============================================================================
const trayEditOverlay = $("trayEditOverlay");
let trayEditBatchId = null;
let trayEditKind = "transplants";
// kind is "transplants" (a growing-rack tray, with Harvest half/full) or
// "germinations" (a germination tray, which is only ever used wholesale by an Add
// Tray transfer on the destination side, so it just gets date/quantity editing).
function openTrayEditModal(batchId, kind){
  if (!isAdmin) return;
  kind = kind || "transplants";
  const isGerm = kind === "germinations";
  const batch = isGerm ? germinationsCache.find(g => g.id === batchId) : transplantsCache.find(t => t.id === batchId);
  if (!batch) return;
  trayEditBatchId = batchId;
  trayEditKind = kind;
  const posLabel = [batch.rackSide ? "Side " + batch.rackSide : null, batch.rackTier != null ? "Tier " + batch.rackTier : null].filter(Boolean).join(" ");
  $("trayEditSub").textContent = plantTypeName(batch.plantTypeId) + (posLabel ? " · " + posLabel : (isGerm ? " · " + LOCATIONS[batch.room] : ""));
  $("trayEditDateLabel").textContent = isGerm ? "Sown date" : "Transfer date";
  $("trayEditDate").value = batch.date || "";
  $("trayEditQty").value = batch.quantity != null ? batch.quantity : "";
  $("trayHarvestSection").style.display = isGerm ? "none" : "block";
  $("trayGermTransferSection").style.display = isGerm ? "block" : "none";
  if (isGerm){
    const remaining = computeGermRemaining(batchId);
    $("trayGermTransferSub").textContent = remaining + " left in this tray.";
    $("trayTransferLevel1Btn").disabled = remaining <= 0;
    $("trayTransferLevel3Btn").disabled = remaining <= 0;
  } else {
    const remaining = computeBatchRemaining(batchId);
    $("trayHarvestSub").textContent = remaining + " left to harvest from this tray.";
    $("trayHarvestHalfBtn").disabled = remaining <= 0;
    $("trayHarvestFullBtn").disabled = remaining <= 0;
  }
  trayEditOverlay.classList.add("active");
}
function closeTrayEditModal(){ trayEditOverlay.classList.remove("active"); trayEditBatchId = null; }
$("trayEditCancel").addEventListener("click", closeTrayEditModal);
trayEditOverlay.addEventListener("click", (e) => { if (e.target === trayEditOverlay) closeTrayEditModal(); });
$("trayEditSave").addEventListener("click", async () => {
  if (!trayEditBatchId) return;
  const dateVal = $("trayEditDate").value;
  const qtyVal = Number($("trayEditQty").value);
  if (!dateVal || $("trayEditQty").value === "" || isNaN(qtyVal) || qtyVal < 0){
    alert("Enter a valid date and quantity.");
    return;
  }
  try {
    await updateDoc(doc(db, trayEditKind, trayEditBatchId), { date: dateVal, quantity: qtyVal });
    closeTrayEditModal();
  } catch (err){
    alert("Couldn't save: " + err.message);
  }
});

async function harvestFromTray(fraction){
  if (!trayEditBatchId) return;
  const batch = transplantsCache.find(t => t.id === trayEditBatchId);
  if (!batch) return;
  const remaining = computeBatchRemaining(trayEditBatchId);
  if (remaining <= 0) return;
  const quantity = fraction === "half" ? Math.round(remaining / 2) : remaining;
  if (!quantity || quantity <= 0) return;
  // No confirm() prompt here — some mobile browsers silently swallow it (returns
  // false with no visible dialog) if an earlier one on the page was dismissed with
  // "don't ask again", which made this button look like it did nothing at all.
  // The button's own label is the confirmation; the harvest can be corrected or
  // deleted afterward from the Harvest log (and recovered from Trash) either way.
  const halfBtn = $("trayHarvestHalfBtn"), fullBtn = $("trayHarvestFullBtn");
  halfBtn.disabled = true; fullBtn.disabled = true;
  try {
    await addDoc(collection(db, "harvests"), {
      date: farmTodayKey(), plantTypeId: batch.plantTypeId, quantity,
      location: batch.destLevel, batchId: batch.id, destinationId: null, notes: "", photos: []
    });
    closeTrayEditModal();
  } catch (err){
    alert("Couldn't log this harvest: " + err.message);
    halfBtn.disabled = false; fullBtn.disabled = false;
  }
}
$("trayHarvestHalfBtn").addEventListener("click", () => harvestFromTray("half"));
$("trayHarvestFullBtn").addEventListener("click", () => harvestFromTray("full"));

// A germination tray is only ever used wholesale — clicking "Transfer to Level 1/3"
// moves everything still left in it straight into a growing-rack batch there, same
// as the Add Tray flow on the destination side, just started from the tray itself.
async function transferGermTray(destLevel){
  if (!trayEditBatchId || trayEditKind !== "germinations") return;
  const germ = germinationsCache.find(g => g.id === trayEditBatchId);
  if (!germ) return;
  const remaining = computeGermRemaining(trayEditBatchId);
  if (remaining <= 0) return;
  // Inherit rack side/tier from this plant type's most recent existing Level 3
  // batch, if any, so the transfer lands in the same physical slot as before
  // without having to ask. Level 1 has no rack side/tier concept.
  let rackSide = null, rackTier = null;
  if (destLevel === "level3"){
    const recent = transplantsCache.filter(t => t.destLevel === "level3" && t.plantTypeId === germ.plantTypeId).sort((a,b) => (b.date||"").localeCompare(a.date||""))[0];
    if (recent){ rackSide = recent.rackSide || null; rackTier = recent.rackTier != null ? recent.rackTier : null; }
  }
  const btn1 = $("trayTransferLevel1Btn"), btn3 = $("trayTransferLevel3Btn");
  btn1.disabled = true; btn3.disabled = true;
  try {
    await addDoc(collection(db, "transplants"), {
      date: farmTodayKey(), plantTypeId: germ.plantTypeId, destLevel,
      quantity: remaining, sourceRoom: germ.room, sourceGermId: germ.id,
      ageAtTransfer: plantTypeGermDays(germ.plantTypeId) || 0,
      rackSide, rackTier, notes: "", photos: []
    });
    closeTrayEditModal();
  } catch (err){
    alert("Couldn't transfer this tray: " + err.message);
    btn1.disabled = false; btn3.disabled = false;
  }
}
$("trayTransferLevel1Btn").addEventListener("click", () => transferGermTray("level1"));
$("trayTransferLevel3Btn").addEventListener("click", () => transferGermTray("level3"));

// ============================================================================
// ADD TRAY MODAL — transfer new seedlings in from germination straight into a
// specific rack slot on the Growing Stock dashboard, instead of the Transfer log.
// ============================================================================
const addTrayOverlay = $("addTrayOverlay");
let addTrayContext = null;
function openAddTrayModal(plantTypeId, destLevel, rackSide, rackTier){
  if (!isAdmin) return;
  addTrayContext = { plantTypeId, destLevel, rackSide, rackTier };
  const isTower = destLevel === "level1";
  $("addTrayTitle").textContent = isTower ? "Add Tower" : "Add Tray";
  $("addTraySave").textContent = isTower ? "Add tower" : "Add tray";
  const posLabel = [rackSide ? "Side " + rackSide : null, rackTier != null ? "Tier " + rackTier : null].filter(Boolean).join(" ");
  $("addTraySub").textContent = plantTypeName(plantTypeId) + (posLabel ? " · " + posLabel : "") + " → " + LOCATIONS[destLevel];
  const sourceSelect = $("addTraySource");
  sourceSelect.innerHTML = "";
  GERM_ROOMS.forEach(room => {
    const opt = document.createElement("option"); opt.value = room; opt.textContent = LOCATIONS[room];
    sourceSelect.appendChild(opt);
  });
  $("addTrayQty").value = "";
  $("addTrayDate").value = farmTodayKey();
  addTrayOverlay.classList.add("active");
}
function closeAddTrayModal(){ addTrayOverlay.classList.remove("active"); addTrayContext = null; }
$("addTrayCancel").addEventListener("click", closeAddTrayModal);
addTrayOverlay.addEventListener("click", (e) => { if (e.target === addTrayOverlay) closeAddTrayModal(); });
$("addTraySave").addEventListener("click", async () => {
  if (!addTrayContext) return;
  const qty = Number($("addTrayQty").value);
  const dateVal = $("addTrayDate").value;
  if (!dateVal || $("addTrayQty").value === "" || isNaN(qty) || qty <= 0){
    alert("Enter a valid date and a quantity greater than 0.");
    return;
  }
  const btn = $("addTraySave");
  btn.disabled = true;
  try {
    const sourceRoom = $("addTraySource").value;
    // Draw from the oldest germination tray of this plant type that still has
    // seedlings left (FIFO — "use 1 tray" always means the longest-growing one),
    // so that specific tray's card counts this transfer against it instead of
    // just the room's pooled total. Rooms with no per-tray germination records
    // (e.g. Off Site) simply fall back to the pool-only accounting from before.
    const oldest = germinationsCache
      .filter(g => g.room === sourceRoom && g.plantTypeId === addTrayContext.plantTypeId)
      .map(g => ({ germ: g, remaining: computeGermRemaining(g.id) }))
      .filter(x => x.remaining > 0)
      .sort((a, b) => (a.germ.date || "").localeCompare(b.germ.date || ""))[0];
    await addDoc(collection(db, "transplants"), {
      date: dateVal, plantTypeId: addTrayContext.plantTypeId, destLevel: addTrayContext.destLevel,
      quantity: qty, sourceRoom, sourceGermId: oldest ? oldest.germ.id : null,
      ageAtTransfer: plantTypeGermDays(addTrayContext.plantTypeId) || 0,
      rackSide: addTrayContext.rackSide || null, rackTier: addTrayContext.rackTier != null ? addTrayContext.rackTier : null,
      notes: "", photos: []
    });
    closeAddTrayModal();
  } catch (err){
    alert("Couldn't add this tray: " + err.message);
  } finally {
    btn.disabled = false;
  }
});

// ============================================================================
// ADD TO GERMINATION MODAL — top up a germination room's pooled stock for one
// plant type, straight from the Growing Stock dashboard.
// ============================================================================
const addGermOverlay = $("addGermOverlay");
let addGermContext = null;
function openAddGermModal(plantTypeId, room){
  if (!isAdmin) return;
  addGermContext = { plantTypeId, room };
  $("addGermSub").textContent = plantTypeName(plantTypeId) + " · " + LOCATIONS[room];
  $("addGermQty").value = "";
  $("addGermDate").value = farmTodayKey();
  addGermOverlay.classList.add("active");
}
function closeAddGermModal(){ addGermOverlay.classList.remove("active"); addGermContext = null; }
$("addGermCancel").addEventListener("click", closeAddGermModal);
addGermOverlay.addEventListener("click", (e) => { if (e.target === addGermOverlay) closeAddGermModal(); });
$("addGermSave").addEventListener("click", async () => {
  if (!addGermContext) return;
  const qty = Number($("addGermQty").value);
  const dateVal = $("addGermDate").value;
  if (!dateVal || $("addGermQty").value === "" || isNaN(qty) || qty <= 0){
    alert("Enter a valid date and a quantity greater than 0.");
    return;
  }
  const btn = $("addGermSave");
  btn.disabled = true;
  try {
    await addDoc(collection(db, "germinations"), {
      date: dateVal, plantTypeId: addGermContext.plantTypeId, room: addGermContext.room,
      quantity: qty, notes: "", photos: []
    });
    closeAddGermModal();
  } catch (err){
    alert("Couldn't add this germination entry: " + err.message);
  } finally {
    btn.disabled = false;
  }
});

// ---- recurring series ----
// Whether `dateKey` is a valid occurrence of a series anchored on `anchorKey` at the given
// frequency. Daily repeats every day; weekly/biweekly repeat on the same weekday every 1/2
// weeks; monthly/yearly repeat on the same day-of-month / same date every 1/12 months —
// months that don't have the anchor day (e.g. a 31st anchor in February) are simply skipped.
// visitorOnly/noVisitorOnly repeat on every day of that dayType instead of a fixed calendar
// pattern, so the event follows whichever days actually turn out to have (or not have) visitors.
function matchesFrequency(dateKey, anchorKey, frequency){
  if (!frequency || frequency === "daily") return true;
  if (frequency === "none") return false;
  const d = toDate(dateKey), anchor = toDate(anchorKey);
  if (d < anchor) return false;
  if (frequency === "visitorOnly") return viewDay(dateKey).dayType === "visitor";
  if (frequency === "noVisitorOnly") return viewDay(dateKey).dayType === "maintenance";
  if (frequency === "weekly" || frequency === "biweekly"){
    const diffDays = Math.round((d - anchor) / 86400000);
    return diffDays % (frequency === "weekly" ? 7 : 14) === 0;
  }
  if (frequency === "monthly") return d.getDate() === anchor.getDate();
  if (frequency === "yearly") return d.getDate() === anchor.getDate() && d.getMonth() === anchor.getMonth();
  return true;
}

async function materializeSeries(seriesId, fromKey, template, toKeyStr){
  const batch = writeBatch(db);
  let d = toDate(fromKey);
  const endD = toDate(toKeyStr);
  let count = 0;
  for (; d <= endD; d.setDate(d.getDate() + 1)){
    const key = toKey(d);
    if (!matchesFrequency(key, template.fromDate, template.frequency)) continue;
    const dayEntry = editableDay(key);
    if (dayEntry.events.some(e => e.seriesId === seriesId)) continue;
    if (dayEntry.dayType === "holiday") continue;
    dayEntry.events.push({ id: uid(), seriesId, start: template.start, end: template.end, title: template.title, person: template.person, notes: template.notes });
    batch.set(doc(db, "schedule", key), dayEntry);
    scheduleCache[key] = dayEntry; // optimistic
    count++;
  }
  if (count > 0) await batch.commit();
  return count;
}

async function addRecurringEvents(startKey, fields){
  const seriesId = uid();
  const seriesDoc = { title: fields.title, start: fields.start, end: fields.end, person: fields.person, notes: fields.notes, fromDate: startKey, frequency: fields.frequency || "daily" };
  await materializeSeries(seriesId, startKey, seriesDoc, horizonEnd(startKey));
  await setDoc(doc(db, "series", seriesId), seriesDoc);
  seriesCache.push({ id: seriesId, ...seriesDoc });
}

// Turns an already-existing, one-off event into the first occurrence of a new recurring
// series (used when editing an event you forgot to mark "repeat" when creating it).
async function convertToRecurring(dateKey, eventId, fields){
  const seriesId = uid();
  const entry = editableDay(dateKey);
  const ev = entry.events.find(e => e.id === eventId);
  if (!ev) return;
  ev.seriesId = seriesId; ev.start = fields.start; ev.end = fields.end;
  ev.title = fields.title; ev.person = fields.person; ev.notes = fields.notes;
  await saveDay(dateKey, entry);

  const seriesDoc = { title: fields.title, start: fields.start, end: fields.end, person: fields.person, notes: fields.notes, fromDate: dateKey, frequency: fields.frequency || "daily" };
  await setDoc(doc(db, "series", seriesId), seriesDoc);
  seriesCache.push({ id: seriesId, ...seriesDoc });

  const nextDay = toDate(dateKey);
  nextDay.setDate(nextDay.getDate() + 1);
  await materializeSeries(seriesId, toKey(nextDay), seriesDoc, horizonEnd(dateKey));
}

async function topUpAllSeries(){
  if (!seriesCache.length) return;
  const horizon = horizonEnd();
  for (const series of seriesCache){
    // Re-materializing the whole range (not just past the last-seen day) is safe —
    // materializeSeries skips any day that already has this series' event — and it
    // also backfills days that were wrongly skipped by an earlier version of the
    // maintenance-day rule (see the dayType check above).
    if (series.fromDate <= horizon) await materializeSeries(series.id, series.fromDate, series, horizon);
  }
}

// Updates every already-materialized occurrence of a series from fromKey onward, and updates
// the series template so future auto-generated days match too. If fields.frequency differs
// from the series' current pattern, future occurrences that no longer fit the new pattern are
// removed first, and materializeSeries then backfills any newly-matching days that don't have
// the event yet — so switching e.g. "daily" to "visitor days only" cleans up as well as adds.
async function updateSeriesForward(seriesId, fromKey, fields, currentEventId){
  const series = seriesCache.find(s => s.id === seriesId);
  const newFrequency = fields.frequency || (series && series.frequency) || "daily";

  if (series && newFrequency !== series.frequency){
    const dropBatch = writeBatch(db);
    let dropped = 0;
    Object.keys(scheduleCache).forEach(key => {
      if (key < fromKey) return;
      const dayEntry = scheduleCache[key];
      if (!dayEntry || !dayEntry.events) return;
      const seriesEv = dayEntry.events.find(e => e.seriesId === seriesId);
      if (!seriesEv) return;
      if (matchesFrequency(key, series.fromDate, newFrequency)) return;
      if (key === fromKey){
        delete seriesEv.seriesId; // detach today's occurrence instead of deleting it
      } else {
        dayEntry.events = dayEntry.events.filter(e => e.seriesId !== seriesId);
      }
      dropBatch.set(doc(db, "schedule", key), dayEntry);
      dropped++;
    });
    if (dropped > 0) await dropBatch.commit();
  }

  const batch = writeBatch(db);
  let touched = 0;
  Object.keys(scheduleCache).forEach(key => {
    if (key < fromKey) return;
    const dayEntry = scheduleCache[key];
    if (!dayEntry || !dayEntry.events) return;
    const ev = dayEntry.events.find(e => e.seriesId === seriesId || (key === fromKey && e.id === currentEventId));
    if (!ev) return;
    ev.start = fields.start; ev.end = fields.end; ev.title = fields.title; ev.person = fields.person; ev.notes = fields.notes;
    batch.set(doc(db, "schedule", key), dayEntry);
    touched++;
  });
  if (touched > 0) await batch.commit();

  const seriesFields = { start: fields.start, end: fields.end, title: fields.title, person: fields.person, notes: fields.notes, frequency: newFrequency };
  const seriesRef = doc(db, "series", seriesId);
  await updateDoc(seriesRef, seriesFields);
  const idx = seriesCache.findIndex(s => s.id === seriesId);
  if (idx >= 0) seriesCache[idx] = { ...seriesCache[idx], ...seriesFields };

  if (idx >= 0) await materializeSeries(seriesId, fromKey, seriesCache[idx], horizonEnd(fromKey));
}

$("saveBtn").addEventListener("click", async () => {
  if (!editingDate) return;
  const start = $("fStart").value || "09:00";
  const end = $("fEnd").value || "10:00";
  const title = $("fTitle").value.trim() || "Untitled Event";
  const person = $("fPerson").value.trim();
  const notes = $("fNotes").value.trim();
  const frequency = $("fFrequency").value;
  const repeat = frequency !== "none";

  if (editingEventId){
    const entry = editableDay(editingDate);
    const ev = entry.events.find(e => e.id === editingEventId);
    const scopeAll = ev && ev.seriesId && document.querySelector('input[name=seriesScope]:checked').value === "all";
    if (scopeAll){
      await updateSeriesForward(ev.seriesId, editingDate, { start, end, title, person, notes, frequency }, editingEventId);
    } else if (ev && !ev.seriesId && repeat){
      await convertToRecurring(editingDate, editingEventId, { start, end, title, person, notes, frequency });
    } else {
      if (ev){ ev.start = start; ev.end = end; ev.title = title; ev.person = person; ev.notes = notes; }
      await saveDay(editingDate, entry);
    }
  } else if (repeat){
    await addRecurringEvents(editingDate, { start, end, title, person, notes, frequency });
  } else {
    const entry = editableDay(editingDate);
    entry.events.push({ id: uid(), start, end, title, person, notes });
    await saveDay(editingDate, entry);
  }
  renderDailySchedule();
  renderCalendar();
  closeEventModal();
});

$("deleteEventBtn").addEventListener("click", async () => {
  if (!editingDate || !editingEventId) return;
  if (!confirm("Delete this event?")) return;
  const entry = editableDay(editingDate);
  entry.events = entry.events.filter(e => e.id !== editingEventId);
  await saveDay(editingDate, entry);
  renderDailySchedule();
  renderCalendar();
  closeEventModal();
});

$("deleteSeriesBtn").addEventListener("click", async () => {
  if (!editingDate || !editingEventId) return;
  const entry = viewDay(editingDate);
  const ev = entry.events.find(e => e.id === editingEventId);
  if (!ev || !ev.seriesId) return;
  if (!confirm("Delete this entire recurring series? This removes it from every day it was scheduled on and can't be undone from Trash — unlike other deletes in this app, a recurring series touches too many days at once to safely restore as one unit.")) return;
  const seriesId = ev.seriesId;

  const batch = writeBatch(db);
  Object.keys(scheduleCache).forEach(key => {
    const dayEntry = scheduleCache[key];
    if (dayEntry && dayEntry.events && dayEntry.events.some(e => e.seriesId === seriesId)){
      dayEntry.events = dayEntry.events.filter(e => e.seriesId !== seriesId);
      batch.set(doc(db, "schedule", key), dayEntry);
    }
  });
  await batch.commit();
  await deleteDoc(doc(db, "series", seriesId));
  seriesCache = seriesCache.filter(s => s.id !== seriesId);

  renderDailySchedule();
  renderCalendar();
  closeEventModal();
});

// ============================================================================
// STAFF PIN ROSTER (Firestore: staff/{id})
// ============================================================================
let staffCache = [];
onSnapshot(collection(db, "staff"), (snap) => {
  staffCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderStaffList();
  markListenerReady();
}, () => setSyncStatus("err", "Connection error"));

function renderStaffList(){
  const list = $("staffList");
  list.innerHTML = "";
  if (staffCache.length === 0){
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No staff added yet.";
    list.appendChild(empty);
    return;
  }
  staffCache.forEach(s => {
    const row = document.createElement("div");
    row.className = "staff-row";

    const name = document.createElement("div");
    name.className = "staff-name";
    name.contentEditable = "true";
    name.textContent = s.name;
    name.addEventListener("blur", async () => {
      const val = name.textContent.trim();
      if (!val){ name.textContent = s.name; return; }
      if (val === s.name) return;
      await updateDoc(doc(db, "staff", s.id), { name: val });
    });
    name.addEventListener("keydown", (e) => { if (e.key === "Enter"){ e.preventDefault(); name.blur(); } });

    const pinErr = document.createElement("span");
    pinErr.style.cssText = "color:#c0392b; font-size:10px; display:none;";

    const pin = document.createElement("input");
    pin.className = "staff-pin-input";
    pin.type = "text";
    pin.maxLength = 4;
    pin.inputMode = "numeric";
    pin.value = s.pin;
    pin.addEventListener("input", () => { pin.value = pin.value.replace(/\D/g, "").slice(0,4); });
    pin.addEventListener("blur", async () => {
      const val = pin.value;
      pinErr.style.display = "none";
      if (!/^\d{4}$/.test(val)){ pin.value = s.pin; pinErr.textContent = "Must be 4 digits."; pinErr.style.display = "inline"; return; }
      if (val !== s.pin && staffCache.some(x => x.id !== s.id && x.pin === val)){
        pin.value = s.pin; pinErr.textContent = "PIN already in use."; pinErr.style.display = "inline"; return;
      }
      if (val === s.pin) return;
      await updateDoc(doc(db, "staff", s.id), { pin: val });
    });
    pin.addEventListener("keydown", (e) => { if (e.key === "Enter"){ e.preventDefault(); pin.blur(); } });

    const del = document.createElement("button");
    del.className = "icon-btn";
    del.textContent = "✕";
    del.title = "Remove staff";
    del.addEventListener("click", async () => {
      if (!confirm("Remove " + s.name + " from the staff roster? Their past attendance records are kept.")) return;
      await moveToTrash("staff", s.id, s);
    });

    row.appendChild(name); row.appendChild(pin); row.appendChild(pinErr); row.appendChild(del);
    list.appendChild(row);
  });
}

$("toggleStaffPanelBtn").addEventListener("click", () => {
  const panel = $("staffPanel");
  panel.style.display = panel.style.display === "none" ? "block" : "none";
});

$("addStaffBtn").addEventListener("click", async () => {
  if (!isAdmin) return;
  const nameInput = $("newStaffName"), pinInput = $("newStaffPin"), errEl = $("staffError");
  errEl.style.display = "none";
  const name = nameInput.value.trim();
  const pin = pinInput.value.trim();
  if (!name || !/^\d{4}$/.test(pin)){ errEl.textContent = "Enter a name and a 4-digit PIN."; errEl.style.display = "block"; return; }
  if (staffCache.some(s => s.pin === pin)){ errEl.textContent = "That PIN is already assigned to someone else — pick a different one."; errEl.style.display = "block"; return; }
  try {
    await addDoc(collection(db, "staff"), { name, pin });
    nameInput.value = ""; pinInput.value = "";
  } catch (err){
    errEl.textContent = "Couldn't save this staff member: " + err.message;
    errEl.style.display = "block";
  }
});

// ============================================================================
// ATTENDANCE (Firestore: attendance/{id}, queried per-day)
// ============================================================================
let attRecords = [];
let attUnsub = null;
let attSelectedDate = inRange(todayKeyGlobal) ? todayKeyGlobal : START_DATE;

const attDatePicker = $("attDatePicker");
attDatePicker.min = START_DATE;
attDatePicker.value = attSelectedDate;

function subscribeAttendance(){
  if (attUnsub) attUnsub();
  const q = query(collection(db, "attendance"), where("date", "==", attSelectedDate));
  attUnsub = onSnapshot(q, (snap) => {
    attRecords = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderAttendance();
  }, () => setSyncStatus("err", "Connection error"));
}

attDatePicker.addEventListener("change", () => {
  if (attDatePicker.value){
    attSelectedDate = attDatePicker.value < START_DATE ? START_DATE : attDatePicker.value;
    attDatePicker.value = attSelectedDate;
    subscribeAttendance();
  }
});
function shiftAttDay(delta){
  const d = toDate(attSelectedDate);
  d.setDate(d.getDate() + delta);
  const key = toKey(d);
  if (key < START_DATE) return;
  attSelectedDate = key;
  attDatePicker.value = key;
  subscribeAttendance();
}
$("attPrevDay").addEventListener("click", () => shiftAttDay(-1));
$("attNextDay").addEventListener("click", () => shiftAttDay(1));
$("attToday").addEventListener("click", () => {
  const t = farmTodayKey();
  attSelectedDate = inRange(t) ? t : START_DATE;
  attDatePicker.value = attSelectedDate;
  subscribeAttendance();
});

function collectKnownNames(){
  const names = new Set();
  Object.values(scheduleCache).forEach(entry => { (entry.events||[]).forEach(ev => { if (ev.person) names.add(ev.person.trim()); }); });
  staffCache.forEach(s => { if (s.name) names.add(s.name.trim()); });
  return Array.from(names).sort();
}

function renderAttendance(){
  const d = toDate(attSelectedDate);
  $("attDateTitle").textContent = d.toLocaleDateString("default",{weekday:"long", month:"long", day:"numeric", year:"numeric"});

  const onsite = attRecords.filter(r => r.signIn && !r.signOut).length;
  const signedIn = attRecords.filter(r => r.signIn).length;
  $("attSummary").textContent = attRecords.length === 0 ? "No one on the list yet." : signedIn + " of " + attRecords.length + " signed in · " + onsite + " currently on site";

  const datalist = $("staffNamesList");
  datalist.innerHTML = "";
  collectKnownNames().forEach(name => { const opt = document.createElement("option"); opt.value = name; datalist.appendChild(opt); });

  const list = $("attList");
  list.innerHTML = "";
  const head = $("attTableHead");
  if (attRecords.length === 0){
    if (head) head.style.display = "none";
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No attendance recorded for this day yet.";
    list.appendChild(empty);
    return;
  }
  if (head) head.style.display = "";

  attRecords.forEach(rec => {
    const row = document.createElement("div");
    row.className = "att-row";

    const name = document.createElement("div");
    name.className = "att-name";
    name.textContent = rec.name;
    row.appendChild(name);

    row.appendChild(makeAttTimeGroup(rec, "signIn", "Sign In", "in"));
    row.appendChild(makeAttTimeGroup(rec, "signOut", "Sign Out", "out"));

    const badge = document.createElement("span");
    const status = !rec.signIn ? "pending" : (rec.signOut ? "complete" : "onsite");
    const statusText = !rec.signIn ? "Not signed in" : (rec.signOut ? "Complete" : "On site");
    badge.className = "att-badge " + status;
    badge.textContent = statusText;
    row.appendChild(badge);

    if (isAdmin){
      const del = document.createElement("button");
      del.className = "icon-btn att-del";
      del.textContent = "✕";
      del.title = "Remove from list";
      del.addEventListener("click", async () => {
        if (!confirm("Remove " + rec.name + "'s attendance entry for this day?")) return;
        await moveToTrash("attendance", rec.id, rec);
      });
      row.appendChild(del);
    }
    list.appendChild(row);
  });
}

// Attendance records are keyed by farm day, not calendar date (see farmTodayKey()), so a
// night-shift sign-out like "03:25" actually happened the calendar day AFTER the record's
// own date. Same 07:00 boundary as farmTodayKey(): a time before it belongs to the next day.
function actualDateForTime(farmDayKey, timeStr){
  if (!timeStr) return null;
  const d = toDate(farmDayKey);
  if (timeStr < "07:00") d.setDate(d.getDate() + 1);
  return toKey(d);
}
function formatShortDate(key){
  return toDate(key).toLocaleDateString("default", { month: "short", day: "numeric" });
}
function makeAttDateLine(farmDayKey, timeStr){
  const line = document.createElement("div");
  line.className = "att-time-date";
  if (timeStr) line.textContent = formatShortDate(actualDateForTime(farmDayKey, timeStr));
  return line;
}
function makeLocLine(loc){
  const line = document.createElement("div");
  line.className = "att-loc";
  if (loc){
    const link = document.createElement("a");
    link.href = "https://maps.google.com/?q=" + loc.lat + "," + loc.lng;
    link.target = "_blank"; link.rel = "noopener";
    link.textContent = "📍 " + loc.lat.toFixed(5) + ", " + loc.lng.toFixed(5);
    line.appendChild(link);
  }
  return line;
}

function makeAttTimeGroup(rec, field, label, kind){
  const group = document.createElement("div");
  group.className = "att-time-group";
  const lbl = document.createElement("div");
  lbl.className = "att-time-label";
  lbl.textContent = label;
  group.appendChild(lbl);

  const locField = field + "Loc";
  const canAct = field === "signOut" ? !!rec.signIn : true;

  if (!isAdmin){
    const val = document.createElement("div");
    val.className = "att-time-value" + (rec[field] ? "" : " empty");
    val.textContent = rec[field] || "—";
    group.appendChild(val);
    group.appendChild(makeAttDateLine(rec.date, rec[field]));
    group.appendChild(makeLocLine(rec[field] ? rec[locField] : null));
    return group;
  }

  if (rec[field]){
    const valWrap = document.createElement("div");
    valWrap.className = "att-time-value";
    const input = document.createElement("input");
    input.type = "time"; input.className = "att-time-input"; input.value = rec[field];
    input.addEventListener("change", async () => { await updateDoc(doc(db, "attendance", rec.id), { [field]: input.value }); });
    const clear = document.createElement("button");
    clear.className = "att-clear"; clear.textContent = "✕"; clear.title = "Clear " + label.toLowerCase();
    clear.addEventListener("click", async () => {
      const patch = { [field]: "", [locField]: null };
      if (field === "signIn"){ patch.signOut = ""; patch.signOutLoc = null; }
      await updateDoc(doc(db, "attendance", rec.id), patch);
    });
    valWrap.appendChild(input); valWrap.appendChild(clear);
    group.appendChild(valWrap);
    group.appendChild(makeAttDateLine(rec.date, rec[field]));
    group.appendChild(makeLocLine(rec[locField]));
  } else if (canAct){
    const btn = document.createElement("button");
    btn.className = "att-btn " + kind;
    btn.textContent = label;
    btn.addEventListener("click", async () => { await updateDoc(doc(db, "attendance", rec.id), { [field]: nowTimeStr() }); });
    group.appendChild(btn);
    group.appendChild(makeLocLine(null));
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "att-time-value empty";
    placeholder.textContent = "—";
    group.appendChild(placeholder);
    group.appendChild(makeLocLine(null));
  }
  return group;
}

$("addAttBtn").addEventListener("click", async () => {
  if (!isAdmin) return;
  const input = $("newAttName");
  const name = requireValue(input, "a staff name");
  if (!name) return;
  try {
    await addDoc(collection(db, "attendance"), { date: attSelectedDate, name, signIn: "", signOut: "", signInLoc: null, signOutLoc: null });
    input.value = "";
  } catch (err){
    alert("Couldn't add this attendance row: " + err.message);
  }
});
$("newAttName").addEventListener("keydown", (e) => { if (e.key === "Enter") $("addAttBtn").click(); });

// ---- Check In / Check Out kiosk (PIN pad) ----
const pinOverlay = $("pinOverlay");
let pinBuffer = "", pinMode = "in";

function updatePinDots(){ document.querySelectorAll("#pinDots .pin-dot").forEach((dot,i) => dot.classList.toggle("filled", i < pinBuffer.length)); }
function openPinPad(mode){
  pinMode = mode; pinBuffer = "";
  $("pinModalTitle").textContent = mode === "in" ? "Check In" : "Check Out";
  $("pinModalSub").textContent = "Enter your 4-digit PIN";
  $("pinError").textContent = "";
  updatePinDots();
  pinOverlay.classList.add("active");
}
function closePinPad(){ pinOverlay.classList.remove("active"); pinBuffer = ""; }
$("kioskCheckInBtn").addEventListener("click", () => openPinPad("in"));
$("kioskCheckOutBtn").addEventListener("click", () => openPinPad("out"));
$("pinCancelBtn").addEventListener("click", closePinPad);
pinOverlay.addEventListener("click", (e) => { if (e.target === pinOverlay) closePinPad(); });
document.querySelectorAll("#pinPad button[data-digit]").forEach(btn => {
  btn.addEventListener("click", () => {
    if (pinBuffer.length >= 4) return;
    pinBuffer += btn.dataset.digit;
    updatePinDots();
    if (pinBuffer.length === 4) attemptPin();
  });
});
$("pinBackspace").addEventListener("click", () => { pinBuffer = pinBuffer.slice(0,-1); $("pinError").textContent = ""; updatePinDots(); });

function attemptPin(){
  const match = staffCache.find(s => s.pin === pinBuffer);
  if (!match){
    $("pinError").textContent = "PIN not recognized. Try again.";
    pinBuffer = "";
    setTimeout(updatePinDots, 10);
    return;
  }
  closePinPad();
  performCheckAction(match, pinMode);
}

function showKioskMessage(text, isErr){
  const el = $("kioskMessage");
  el.textContent = text;
  el.className = "kiosk-message " + (isErr ? "err" : "ok");
  el.style.display = "block";
  clearTimeout(showKioskMessage._t);
  showKioskMessage._t = setTimeout(() => { el.style.display = "none"; }, 5000);
}

function captureLocation(cb){
  if (!navigator.geolocation){ cb(null); return; }
  navigator.geolocation.getCurrentPosition(
    pos => cb({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
    () => cb(null),
    { timeout: 8000, maximumAge: 60000 }
  );
}
function formatLoc(loc){ return loc ? loc.lat.toFixed(5) + ", " + loc.lng.toFixed(5) : "location unavailable"; }

async function performCheckAction(staffMember, mode){
  try {
    const today = farmTodayKey();
    const q = query(collection(db, "attendance"), where("date", "==", today), where("staffId", "==", staffMember.id));
    const snap = await getDocs(q);
    const recDoc = snap.docs[0];
    const rec = recDoc ? { id: recDoc.id, ...recDoc.data() } : null;

    if (mode === "in"){
      if (rec && rec.signIn){ showKioskMessage(staffMember.name + " is already checked in since " + rec.signIn + ".", true); return; }
      const time = nowTimeStr();
      let recId;
      if (!rec){
        const newDoc = await addDoc(collection(db, "attendance"), { date: today, staffId: staffMember.id, name: staffMember.name, signIn: time, signInLoc: null, signOut: "", signOutLoc: null });
        recId = newDoc.id;
      } else {
        recId = rec.id;
        await updateDoc(doc(db, "attendance", recId), { signIn: time });
      }
      showKioskMessage("Checked in: " + staffMember.name + " at " + time + ". Getting location…", false);
      captureLocation(async (loc) => {
        await updateDoc(doc(db, "attendance", recId), { signInLoc: loc });
        showKioskMessage("Checked in: " + staffMember.name + " at " + time + " — " + formatLoc(loc), false);
      });
    } else {
      if (!rec || !rec.signIn){ showKioskMessage(staffMember.name + " hasn't checked in yet today.", true); return; }
      if (rec.signOut){ showKioskMessage(staffMember.name + " already checked out at " + rec.signOut + ".", true); return; }
      const time = nowTimeStr();
      await updateDoc(doc(db, "attendance", rec.id), { signOut: time });
      showKioskMessage("Checked out: " + staffMember.name + " at " + time + ". Getting location…", false);
      captureLocation(async (loc) => {
        await updateDoc(doc(db, "attendance", rec.id), { signOutLoc: loc });
        showKioskMessage("Checked out: " + staffMember.name + " at " + time + " — " + formatLoc(loc), false);
      });
    }
  } catch (err){
    showKioskMessage("Couldn't record this: " + err.message, true);
  }
}

// ============================================================================
// HOUSE RULES (Firestore: meta/houseRules, field rules: string[])
// ============================================================================
let rulesCache = [];
const DEFAULT_RULES = [
  "No visitors on Mondays — maintenance day.",
  "Morning shift: 07:00–19:00. Night shift: 19:00–07:00.",
  "Visitors are on-site daily Tuesday through Sunday."
];

onSnapshot(doc(db, "meta", "houseRules"), async (snap) => {
  if (snap.exists()){
    rulesCache = snap.data().rules || [];
  } else {
    rulesCache = DEFAULT_RULES.slice();
    if (isAdmin) await setDoc(doc(db, "meta", "houseRules"), { rules: rulesCache });
  }
  renderRules();
  markListenerReady();
}, () => setSyncStatus("err", "Connection error"));

async function saveRules(){ await setDoc(doc(db, "meta", "houseRules"), { rules: rulesCache }); }

function renderRules(){
  const list = $("rulesList");
  list.innerHTML = "";
  rulesCache.forEach((rule, idx) => {
    const row = document.createElement("div");
    row.className = "rule-row";
    const text = document.createElement("div");
    text.className = "rule-text";
    text.contentEditable = isAdmin ? "true" : "false";
    text.textContent = rule;
    text.addEventListener("blur", async () => {
      if (!isAdmin) return;
      rulesCache[idx] = text.textContent.trim();
      await saveRules();
    });
    row.appendChild(text);
    if (isAdmin){
      const del = document.createElement("button");
      del.className = "icon-btn"; del.textContent = "✕"; del.title = "Delete rule";
      del.addEventListener("click", async () => {
        if (!confirm("Delete this house rule?")) return;
        rulesCache.splice(idx, 1);
        await saveRules();
        renderRules();
      });
      row.appendChild(del);
    }
    list.appendChild(row);
  });
}

$("addRuleBtn").addEventListener("click", async () => {
  if (!isAdmin) return;
  const input = $("newRuleInput");
  const val = requireValue(input, "a rule");
  if (!val) return;
  rulesCache.push(val);
  input.value = "";
  try {
    await saveRules();
  } catch (err){
    rulesCache.pop();
    alert("Couldn't save this rule: " + err.message + "\n\nIf this says \"permission denied\", the meta rule in firestore.rules needs to be published in the Firebase console (Firestore Database → Rules).");
  }
  renderRules();
});
$("newRuleInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("addRuleBtn").click(); });

// ============================================================================
// FINDINGS LOG (Firestore: findings/{id}) + Cloudinary photos + search
// ============================================================================
let findingsCache = [];
let findingsSearchTerm = "";
const expandedFindings = {};
const seenFindingIds = {};

onSnapshot(collection(db, "findings"), (snap) => {
  findingsCache = snap.docs.map(d => ({ id: d.id, photos: [], ...d.data() }));
  renderFindings();
}, () => setSyncStatus("err", "Connection error"));

function ensureDefaultExpand(sorted){
  if (sorted.length === 0) return;
  const todayKey = toKey(new Date());
  sorted.forEach(f => {
    if (!seenFindingIds[f.id]){
      seenFindingIds[f.id] = true;
      if (f.date === todayKey) expandedFindings[f.id] = true;
    }
  });
}

$("findingsSearch").addEventListener("input", (e) => { findingsSearchTerm = e.target.value.trim().toLowerCase(); renderFindings(); });
$("findingsSearchClear").addEventListener("click", () => { $("findingsSearch").value = ""; findingsSearchTerm = ""; renderFindings(); });

function renderFindings(){
  const list = $("findingsList");
  list.innerHTML = "";

  let items = findingsCache.slice().sort((a,b) => b.date.localeCompare(a.date));
  if (findingsSearchTerm){
    items = items.filter(f => (f.text || "").toLowerCase().includes(findingsSearchTerm) || (f.date || "").includes(findingsSearchTerm));
  }

  if (items.length === 0){
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = findingsSearchTerm ? "No findings match your search." : "No findings logged yet.";
    list.appendChild(empty);
    return;
  }

  ensureDefaultExpand(findingsCache.slice().sort((a,b) => b.date.localeCompare(a.date)));
  const latestDate = findingsCache.length ? findingsCache.slice().sort((a,b) => b.date.localeCompare(a.date))[0].date : null;

  items.forEach(f => {
    const isOpen = findingsSearchTerm ? true : !!expandedFindings[f.id];
    const card = document.createElement("div");
    card.className = "finding-card" + (isOpen ? " expanded" : "");

    const header = document.createElement("div");
    header.className = "finding-header";
    const left = document.createElement("div");
    left.className = "finding-header-left";
    const chevron = document.createElement("span");
    chevron.className = "finding-chevron"; chevron.textContent = "▶";
    const dateEl = document.createElement("span");
    dateEl.className = "finding-date"; dateEl.textContent = f.date;
    left.appendChild(chevron); left.appendChild(dateEl);
    if (f.date === latestDate){
      const tag = document.createElement("span");
      tag.className = "finding-latest-tag"; tag.textContent = "Latest";
      left.appendChild(tag);
    }
    if (!isOpen){
      const preview = document.createElement("span");
      preview.className = "finding-preview";
      preview.textContent = f.text || (f.photos.length ? f.photos.length + " photo(s)" : "");
      left.appendChild(preview);
    }
    header.appendChild(left);

    if (isAdmin){
      const del = document.createElement("button");
      del.className = "icon-btn"; del.textContent = "✕"; del.title = "Delete entry";
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("Delete this finding entry and its photos?")) return;
        await moveToTrash("findings", f.id, f);
      });
      header.appendChild(del);
    }
    header.addEventListener("click", () => {
      if (expandedFindings[f.id]) delete expandedFindings[f.id]; else expandedFindings[f.id] = true;
      renderFindings();
    });
    card.appendChild(header);

    const body = document.createElement("div");
    body.className = "finding-body";
    if (isOpen){
      const text = document.createElement("div");
      text.className = "finding-text";
      text.contentEditable = isAdmin ? "true" : "false";
      text.textContent = f.text;
      text.addEventListener("click", (e) => e.stopPropagation());
      text.addEventListener("blur", async () => {
        if (!isAdmin) return;
        const val = text.innerText.trim();
        if (val === f.text) return;
        await updateDoc(doc(db, "findings", f.id), { text: val });
      });
      body.appendChild(text);

      const strip = document.createElement("div");
      strip.className = "photo-strip";
      f.photos.forEach(photo => {
        const item = document.createElement("div");
        item.className = "photo-item";
        const wrap = document.createElement("div");
        wrap.className = "photo-thumb-wrap";
        const img = document.createElement("img");
        img.className = "photo-thumb"; img.src = photo.url; img.loading = "lazy";
        img.addEventListener("click", (e) => { e.stopPropagation(); openLightbox(photo.url); });
        wrap.appendChild(img);
        if (isAdmin){
          const rem = document.createElement("button");
          rem.className = "photo-remove"; rem.textContent = "✕"; rem.title = "Delete photo";
          rem.addEventListener("click", async (e) => {
            e.stopPropagation();
            if (!confirm("Delete this photo?")) return;
            const newPhotos = f.photos.filter(p => p.id !== photo.id);
            try {
              await updateDoc(doc(db, "findings", f.id), { photos: newPhotos });
            } catch (err){
              alert("Couldn't delete this photo: " + err.message);
            }
          });
          wrap.appendChild(rem);
        }
        item.appendChild(wrap);
        if (isAdmin){
          const ann = document.createElement("button");
          ann.className = "annotate-btn"; ann.textContent = "✎ Annotate";
          ann.addEventListener("click", (e) => { e.stopPropagation(); openAnnotateModal("findings", f.id, photo.id); });
          item.appendChild(ann);
        }
        strip.appendChild(item);
      });
      if (isAdmin){
        const addBtn = document.createElement("div");
        addBtn.className = "add-photo-btn"; addBtn.textContent = "+ Add photo";
        addBtn.addEventListener("click", (e) => { e.stopPropagation(); openPhotoPicker("findings", f.id, addBtn); });
        strip.appendChild(addBtn);
      }
      body.appendChild(strip);
    }
    card.appendChild(body);
    list.appendChild(card);
  });
}

$("addFindingBtn").addEventListener("click", async () => {
  if (!isAdmin) return;
  const dateInput = $("newFindingDate");
  const textInput = $("newFindingInput");
  const val = requireValue(textInput, "some finding text");
  if (!val) return;
  const date = dateInput.value || toKey(new Date());
  const btn = $("addFindingBtn");
  btn.disabled = true; btn.textContent = "Adding…";
  try {
    const newDoc = await addDoc(collection(db, "findings"), { date, text: val, photos: [] });
    expandedFindings[newDoc.id] = true;
    textInput.value = "";
  } catch (err){
    alert("Couldn't save this finding: " + err.message + "\n\nIf this says \"permission denied\", the findings rule in firestore.rules needs to be published in the Firebase console (Firestore Database → Rules).");
  } finally {
    btn.disabled = false; btn.textContent = "Add";
  }
});
$("newFindingInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("addFindingBtn").click(); });
(() => { const t = toKey(new Date()); $("newFindingDate").value = inRange(t) ? t : START_DATE; })();

// Findings photos are stored at full upload resolution (original camera size, often
// several MB). Printing dozens of those directly makes Chrome's print preview hang
// for a very long time fetching/rasterizing them, so the PDF report requests a small
// Cloudinary-resized version instead — same photo, a fraction of the bytes.
function cloudinaryThumb(url, width){
  if (!url) return url;
  return url.replace("/upload/", "/upload/w_" + width + ",q_auto,f_auto/");
}

function buildFindingsPdfHtml(){
  const items = findingsCache.slice().sort((a,b) => b.date.localeCompare(a.date));
  const generated = new Date().toLocaleString("default", { dateStyle: "medium", timeStyle: "short" });
  let html = '<div class="pdf-doc"><h1>Findings Log</h1>';
  html += '<p class="pdf-meta">Indoor Farm — Takeover Tracker · Generated ' + escapeHtml(generated) + ' · ' + items.length + ' entr' + (items.length === 1 ? "y" : "ies") + '</p>';
  if (items.length === 0){
    html += "<p>No findings logged yet.</p>";
  } else {
    items.forEach(f => {
      html += '<div class="pdf-entry"><div class="pdf-entry-date">' + escapeHtml(f.date) + '</div>';
      html += '<div class="pdf-entry-text">' + escapeHtml(f.text || "").replace(/\n/g, "<br>") + '</div>';
      if (f.photos && f.photos.length){
        html += '<div class="pdf-photo-grid">';
        f.photos.forEach(p => { html += '<img class="pdf-photo" src="' + escapeHtml(cloudinaryThumb(p.url, 1000)) + '">'; });
        html += '</div>';
      }
      html += '</div>';
    });
  }
  html += '</div>';
  return html;
}

// Waits for every <img> in the print area to either load or fail, capped per-image so
// one broken/slow URL can't hang the whole thing forever.
function waitForImages(container, timeoutMs){
  const imgs = Array.from(container.querySelectorAll("img"));
  return Promise.all(imgs.map(img => {
    if (img.complete) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { img.removeEventListener("load", done); img.removeEventListener("error", done); resolve(); };
      img.addEventListener("load", done);
      img.addEventListener("error", done);
      setTimeout(done, timeoutMs);
    });
  }));
}

$("downloadFindingsPdfBtn").addEventListener("click", async () => {
  if (!isAdmin) return;
  const btn = $("downloadFindingsPdfBtn");
  const originalLabel = btn.textContent;
  btn.disabled = true; btn.textContent = "Preparing PDF…";
  const area = $("pdfPrintArea");
  area.innerHTML = buildFindingsPdfHtml();
  await waitForImages(area, 8000);
  document.body.classList.add("printing-pdf");
  window.print();
  btn.disabled = false; btn.textContent = originalLabel;
});
window.addEventListener("afterprint", () => {
  document.body.classList.remove("printing-pdf");
  $("pdfPrintArea").innerHTML = "";
});

// ============================================================================
// PLANNING / PROPOSALS (Firestore: proposals/{id}) — suggested future changes
// or improvements, tracked with a status (Proposed/Approved/On Hold/Rejected).
// Same collapsible-card/photo-strip pattern as Findings Log.
// ============================================================================
const PROPOSAL_STATUS_LABELS = { proposed: "Proposed", approved: "Approved", onHold: "On Hold", rejected: "Rejected" };
let proposalsCache = [];
let proposalsSearchTerm = "";
const expandedProposals = {};

onSnapshot(collection(db, "proposals"), (snap) => {
  proposalsCache = snap.docs.map(d => ({ id: d.id, photos: [], ...d.data() }));
  renderProposals();
}, () => setSyncStatus("err", "Connection error"));

$("proposalsSearch").addEventListener("input", (e) => { proposalsSearchTerm = e.target.value.trim().toLowerCase(); renderProposals(); });
$("proposalsSearchClear").addEventListener("click", () => { $("proposalsSearch").value = ""; proposalsSearchTerm = ""; renderProposals(); });

function renderProposals(){
  const list = $("proposalsList");
  list.innerHTML = "";

  let items = proposalsCache.slice().sort((a,b) => (b.date || "").localeCompare(a.date || ""));
  if (proposalsSearchTerm){
    items = items.filter(p =>
      (p.title || "").toLowerCase().includes(proposalsSearchTerm) ||
      (p.notes || "").toLowerCase().includes(proposalsSearchTerm)
    );
  }

  if (items.length === 0){
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = proposalsSearchTerm ? "No proposals match your search." : "No proposals logged yet.";
    list.appendChild(empty);
    return;
  }

  items.forEach(p => {
    const isOpen = proposalsSearchTerm ? true : !!expandedProposals[p.id];
    const card = document.createElement("div");
    card.className = "finding-card" + (isOpen ? " expanded" : "");

    const header = document.createElement("div");
    header.className = "finding-header";
    const left = document.createElement("div");
    left.className = "finding-header-left";
    const chevron = document.createElement("span");
    chevron.className = "finding-chevron"; chevron.textContent = "▶";
    const dateEl = document.createElement("span");
    dateEl.className = "finding-date"; dateEl.textContent = p.date || "";
    left.appendChild(chevron); left.appendChild(dateEl);
    const badge = document.createElement("span");
    badge.className = "proposal-badge " + (p.status || "proposed");
    badge.textContent = PROPOSAL_STATUS_LABELS[p.status] || "Proposed";
    left.appendChild(badge);
    const titleTag = document.createElement("span");
    titleTag.className = "finding-preview"; titleTag.style.fontWeight = "600"; titleTag.style.color = "#333";
    titleTag.textContent = p.title || "Untitled proposal";
    left.appendChild(titleTag);
    if (!isOpen && p.notes){
      const preview = document.createElement("span");
      preview.className = "finding-preview";
      preview.textContent = p.notes;
      left.appendChild(preview);
    }
    header.appendChild(left);

    if (isAdmin){
      const del = document.createElement("button");
      del.className = "icon-btn"; del.textContent = "✕"; del.title = "Delete proposal";
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("Delete this proposal and its photos?")) return;
        try { await moveToTrash("proposals", p.id, p); }
        catch (err){ alert("Couldn't delete this proposal: " + err.message); }
      });
      header.appendChild(del);
    }
    header.addEventListener("click", () => {
      if (expandedProposals[p.id]) delete expandedProposals[p.id]; else expandedProposals[p.id] = true;
      renderProposals();
    });
    card.appendChild(header);

    const body = document.createElement("div");
    body.className = "finding-body";
    if (isOpen){
      const titleInput = document.createElement("div");
      titleInput.className = "finding-text";
      titleInput.style.fontWeight = "600";
      titleInput.contentEditable = isAdmin ? "true" : "false";
      titleInput.textContent = p.title || "";
      titleInput.addEventListener("click", (e) => e.stopPropagation());
      titleInput.addEventListener("blur", async () => {
        if (!isAdmin) return;
        const val = titleInput.innerText.trim();
        if (!val || val === p.title) { titleInput.textContent = p.title || ""; return; }
        try { await updateDoc(doc(db, "proposals", p.id), { title: val }); }
        catch (err){ alert("Couldn't save the title: " + err.message); titleInput.textContent = p.title || ""; }
      });
      body.appendChild(titleInput);

      if (isAdmin){
        const row = document.createElement("div");
        row.className = "row2";
        row.style.marginTop = "8px";
        const dateField = document.createElement("div"); dateField.className = "field";
        dateField.innerHTML = "<label>Date</label>";
        const dateInput = document.createElement("input");
        dateInput.type = "date"; dateInput.value = p.date || "";
        dateInput.addEventListener("change", async () => {
          try { await updateDoc(doc(db, "proposals", p.id), { date: dateInput.value }); }
          catch (err){ alert("Couldn't save the date: " + err.message); }
        });
        dateField.appendChild(dateInput);
        const statusField = document.createElement("div"); statusField.className = "field";
        statusField.innerHTML = "<label>Status</label>";
        const statusSelect = document.createElement("select");
        statusSelect.className = "proposal-status-select";
        Object.entries(PROPOSAL_STATUS_LABELS).forEach(([val, label]) => {
          const opt = document.createElement("option");
          opt.value = val; opt.textContent = label;
          statusSelect.appendChild(opt);
        });
        statusSelect.value = p.status || "proposed";
        statusSelect.addEventListener("change", async () => {
          try { await updateDoc(doc(db, "proposals", p.id), { status: statusSelect.value }); }
          catch (err){ alert("Couldn't save the status: " + err.message); }
        });
        statusField.appendChild(statusSelect);
        row.appendChild(dateField); row.appendChild(statusField);
        body.appendChild(row);
      }

      const notes = document.createElement("div");
      notes.className = "finding-text";
      notes.contentEditable = isAdmin ? "true" : "false";
      notes.textContent = p.notes || "";
      notes.addEventListener("click", (e) => e.stopPropagation());
      notes.addEventListener("blur", async () => {
        if (!isAdmin) return;
        const val = notes.innerText.trim();
        if (val === p.notes) return;
        try { await updateDoc(doc(db, "proposals", p.id), { notes: val }); }
        catch (err){ alert("Couldn't save the notes: " + err.message); notes.textContent = p.notes || ""; }
      });
      body.appendChild(notes);

      const strip = document.createElement("div");
      strip.className = "photo-strip";
      p.photos.forEach(photo => {
        const item = document.createElement("div");
        item.className = "photo-item";
        const wrap = document.createElement("div");
        wrap.className = "photo-thumb-wrap";
        const img = document.createElement("img");
        img.className = "photo-thumb"; img.src = photo.url; img.loading = "lazy";
        img.addEventListener("click", (e) => { e.stopPropagation(); openLightbox(photo.url); });
        wrap.appendChild(img);
        if (isAdmin){
          const rem = document.createElement("button");
          rem.className = "photo-remove"; rem.textContent = "✕"; rem.title = "Delete photo";
          rem.addEventListener("click", async (e) => {
            e.stopPropagation();
            if (!confirm("Delete this photo?")) return;
            const newPhotos = p.photos.filter(ph => ph.id !== photo.id);
            try { await updateDoc(doc(db, "proposals", p.id), { photos: newPhotos }); }
            catch (err){ alert("Couldn't delete this photo: " + err.message); }
          });
          wrap.appendChild(rem);
        }
        item.appendChild(wrap);
        if (isAdmin){
          const ann = document.createElement("button");
          ann.className = "annotate-btn"; ann.textContent = "✎ Annotate";
          ann.addEventListener("click", (e) => { e.stopPropagation(); openAnnotateModal("proposals", p.id, photo.id); });
          item.appendChild(ann);
        }
        strip.appendChild(item);
      });
      if (isAdmin){
        const addBtn = document.createElement("div");
        addBtn.className = "add-photo-btn"; addBtn.textContent = "+ Add photo";
        addBtn.addEventListener("click", (e) => { e.stopPropagation(); openPhotoPicker("proposals", p.id, addBtn); });
        strip.appendChild(addBtn);
      }
      body.appendChild(strip);
    }
    card.appendChild(body);
    list.appendChild(card);
  });
}

$("addProposalBtn").addEventListener("click", async () => {
  if (!isAdmin) return;
  const titleInput = $("newProposalTitle");
  const dateInput = $("newProposalDate");
  const statusInput = $("newProposalStatus");
  const notesInput = $("newProposalNotes");
  const title = requireValue(titleInput, "a proposal title");
  if (!title) return;
  const date = dateInput.value || toKey(new Date());
  const status = statusInput.value || "proposed";
  const notes = notesInput.value.trim();
  const btn = $("addProposalBtn");
  btn.disabled = true; btn.textContent = "Adding…";
  try {
    const newDoc = await addDoc(collection(db, "proposals"), { title, date, status, notes, photos: [] });
    expandedProposals[newDoc.id] = true;
    titleInput.value = ""; notesInput.value = ""; statusInput.value = "proposed";
  } catch (err){
    alert("Couldn't save this proposal: " + err.message + "\n\nIf this says \"permission denied\", the proposals rule in firestore.rules needs to be published in the Firebase console (Firestore Database → Rules).");
  } finally {
    btn.disabled = false; btn.textContent = "Add";
  }
});
(() => { const t = toKey(new Date()); $("newProposalDate").value = inRange(t) ? t : START_DATE; })();

// ============================================================================
// CLAIMS (Firestore: claims/{id}) — expense reimbursement: taxi, meals,
// purchases, etc. Same collapsible-card/photo-strip pattern as Proposals,
// with a status that moves pending -> approved -> paid and a per-claim
// "Generate Claim Form" PDF. Admin-only end to end (see firestore.rules) —
// amounts and receipts are more sensitive than the rest of the app's data,
// so unlike every other collection here reads require a login too.
// ============================================================================
const CLAIM_STATUS_LABELS = { pending: "Pending", approved: "Approved", paid: "Paid" };
const CLAIM_CATEGORY_LABELS = { taxi: "Taxi / Transport", meals: "Meals", purchases: "Purchases", other: "Other" };
let claimsCache = [];
let claimsSearchTerm = "";
let claimsStatusFilter = "";
const expandedClaims = {};

// Reads are admin-only in firestore.rules, so subscribing before login would fail with
// permission-denied and permanently kill the listener (Firestore doesn't auto-retry a
// denied listener once auth changes). Only ever subscribe once we know we're admin.
let claimsUnsub = null;
function subscribeClaims(){
  if (claimsUnsub) return;
  claimsUnsub = onSnapshot(collection(db, "claims"), (snap) => {
    claimsCache = snap.docs.map(d => ({ id: d.id, photos: [], ...d.data() }));
    renderClaims();
  }, () => {});
}

$("claimsSearch").addEventListener("input", (e) => { claimsSearchTerm = e.target.value.trim().toLowerCase(); renderClaims(); });
$("claimsSearchClear").addEventListener("click", () => { $("claimsSearch").value = ""; claimsSearchTerm = ""; renderClaims(); });
document.querySelectorAll("#claimsStatusRow .dash-loc-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    claimsStatusFilter = btn.dataset.status;
    document.querySelectorAll("#claimsStatusRow .dash-loc-btn").forEach(b => b.classList.toggle("active", b === btn));
    renderClaims();
  });
});

function renderClaims(){
  const list = $("claimsList");
  list.innerHTML = "";

  let items = claimsCache.slice().sort((a,b) => (b.date || "").localeCompare(a.date || ""));
  if (claimsStatusFilter) items = items.filter(c => (c.status || "pending") === claimsStatusFilter);
  if (claimsSearchTerm){
    items = items.filter(c =>
      (c.claimant || "").toLowerCase().includes(claimsSearchTerm) ||
      (CLAIM_CATEGORY_LABELS[c.category] || "").toLowerCase().includes(claimsSearchTerm) ||
      (c.notes || "").toLowerCase().includes(claimsSearchTerm)
    );
  }

  const summaryEl = $("claimsSummary");
  const totals = { pending: 0, approved: 0, paid: 0 };
  const counts = { pending: 0, approved: 0, paid: 0 };
  claimsCache.forEach(c => {
    const s = c.status || "pending";
    totals[s] = (totals[s] || 0) + (Number(c.amount) || 0);
    counts[s] = (counts[s] || 0) + 1;
  });
  summaryEl.textContent = claimsCache.length === 0 ? "" : Object.keys(CLAIM_STATUS_LABELS)
    .map(s => counts[s] + " " + CLAIM_STATUS_LABELS[s].toLowerCase() + " ($" + totals[s].toFixed(2) + ")").join(" · ");

  if (items.length === 0){
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = (claimsSearchTerm || claimsStatusFilter) ? "No claims match." : "No claims logged yet.";
    list.appendChild(empty);
    return;
  }

  items.forEach(c => {
    const isOpen = claimsSearchTerm ? true : !!expandedClaims[c.id];
    const card = document.createElement("div");
    card.className = "finding-card" + (isOpen ? " expanded" : "");

    const header = document.createElement("div");
    header.className = "finding-header";
    const left = document.createElement("div");
    left.className = "finding-header-left";
    const chevron = document.createElement("span");
    chevron.className = "finding-chevron"; chevron.textContent = "▶";
    const dateEl = document.createElement("span");
    dateEl.className = "finding-date"; dateEl.textContent = c.date || "";
    left.appendChild(chevron); left.appendChild(dateEl);
    const badge = document.createElement("span");
    badge.className = "claim-badge " + (c.status || "pending");
    badge.textContent = CLAIM_STATUS_LABELS[c.status] || "Pending";
    left.appendChild(badge);
    const catTag = document.createElement("span");
    catTag.className = "finding-preview"; catTag.style.fontWeight = "600"; catTag.style.color = "#333";
    catTag.textContent = (CLAIM_CATEGORY_LABELS[c.category] || "Other") + (c.claimant ? " — " + c.claimant : "");
    left.appendChild(catTag);
    if (c.amount != null){
      const amountTag = document.createElement("span");
      amountTag.className = "finding-preview";
      amountTag.textContent = "$" + Number(c.amount).toFixed(2);
      left.appendChild(amountTag);
    }
    if (!isOpen && c.notes){
      const preview = document.createElement("span");
      preview.className = "finding-preview";
      preview.textContent = c.notes;
      left.appendChild(preview);
    }
    header.appendChild(left);

    if (isAdmin){
      const del = document.createElement("button");
      del.className = "icon-btn"; del.textContent = "✕"; del.title = "Delete claim";
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("Delete this claim and its receipt photos?")) return;
        try { await moveToTrash("claims", c.id, c); }
        catch (err){ alert("Couldn't delete this claim: " + err.message); }
      });
      header.appendChild(del);
    }
    header.addEventListener("click", () => {
      if (expandedClaims[c.id]) delete expandedClaims[c.id]; else expandedClaims[c.id] = true;
      renderClaims();
    });
    card.appendChild(header);

    const body = document.createElement("div");
    body.className = "finding-body";
    if (isOpen){
      const row1 = document.createElement("div"); row1.className = "row2";
      const dateField = document.createElement("div"); dateField.className = "field";
      dateField.innerHTML = "<label>Date</label>";
      const dateInput = document.createElement("input");
      dateInput.type = "date"; dateInput.value = c.date || ""; dateInput.disabled = !isAdmin;
      dateInput.addEventListener("change", async () => {
        try { await updateDoc(doc(db, "claims", c.id), { date: dateInput.value }); }
        catch (err){ alert("Couldn't save the date: " + err.message); }
      });
      dateField.appendChild(dateInput);
      const claimantField = document.createElement("div"); claimantField.className = "field";
      claimantField.innerHTML = "<label>Claimant</label>";
      const claimantInput = document.createElement("input");
      claimantInput.type = "text"; claimantInput.value = c.claimant || ""; claimantInput.disabled = !isAdmin;
      claimantInput.setAttribute("list", "staffNamesList");
      claimantInput.addEventListener("change", async () => {
        try { await updateDoc(doc(db, "claims", c.id), { claimant: claimantInput.value.trim() }); }
        catch (err){ alert("Couldn't save the claimant: " + err.message); }
      });
      claimantField.appendChild(claimantInput);
      row1.appendChild(dateField); row1.appendChild(claimantField);
      body.appendChild(row1);

      const row2 = document.createElement("div"); row2.className = "row2";
      const catField = document.createElement("div"); catField.className = "field";
      catField.innerHTML = "<label>Category</label>";
      const catSelect = document.createElement("select");
      catSelect.disabled = !isAdmin;
      Object.entries(CLAIM_CATEGORY_LABELS).forEach(([val, label]) => {
        const opt = document.createElement("option");
        opt.value = val; opt.textContent = label;
        catSelect.appendChild(opt);
      });
      catSelect.value = c.category || "other";
      catSelect.addEventListener("change", async () => {
        try { await updateDoc(doc(db, "claims", c.id), { category: catSelect.value }); }
        catch (err){ alert("Couldn't save the category: " + err.message); }
      });
      catField.appendChild(catSelect);
      const amountField = document.createElement("div"); amountField.className = "field";
      amountField.innerHTML = "<label>Amount</label>";
      const amountInput = document.createElement("input");
      amountInput.type = "number"; amountInput.min = "0"; amountInput.step = "0.01";
      amountInput.value = c.amount != null ? c.amount : ""; amountInput.disabled = !isAdmin;
      amountInput.addEventListener("change", async () => {
        const val = amountInput.value === "" ? null : Number(amountInput.value);
        try { await updateDoc(doc(db, "claims", c.id), { amount: val }); }
        catch (err){ alert("Couldn't save the amount: " + err.message); }
      });
      amountField.appendChild(amountInput);
      row2.appendChild(catField); row2.appendChild(amountField);
      body.appendChild(row2);

      if (isAdmin){
        const statusRow = document.createElement("div");
        statusRow.style.margin = "10px 0";
        const statusLabel = document.createElement("label");
        statusLabel.textContent = "Status: ";
        statusLabel.style.fontSize = "12px"; statusLabel.style.color = "#666";
        const statusSelect = document.createElement("select");
        statusSelect.className = "proposal-status-select";
        Object.entries(CLAIM_STATUS_LABELS).forEach(([val, label]) => {
          const opt = document.createElement("option");
          opt.value = val; opt.textContent = label;
          statusSelect.appendChild(opt);
        });
        statusSelect.value = c.status || "pending";
        statusSelect.addEventListener("change", async () => {
          try { await updateDoc(doc(db, "claims", c.id), { status: statusSelect.value }); }
          catch (err){ alert("Couldn't save the status: " + err.message); }
        });
        statusRow.appendChild(statusLabel);
        statusRow.appendChild(statusSelect);
        body.appendChild(statusRow);
      }

      const notes = document.createElement("div");
      notes.className = "finding-text";
      notes.contentEditable = isAdmin ? "true" : "false";
      notes.textContent = c.notes || "";
      if (isAdmin) notes.dataset.placeholder = "What's this for?…";
      notes.addEventListener("click", (e) => e.stopPropagation());
      notes.addEventListener("blur", async () => {
        if (!isAdmin) return;
        const val = notes.innerText.trim();
        if (val === (c.notes || "")) return;
        try { await updateDoc(doc(db, "claims", c.id), { notes: val }); }
        catch (err){ alert("Couldn't save notes: " + err.message); notes.textContent = c.notes || ""; }
      });
      body.appendChild(notes);

      const strip = document.createElement("div");
      strip.className = "photo-strip";
      c.photos.forEach(photo => {
        const item = document.createElement("div");
        item.className = "photo-item";
        const wrap = document.createElement("div");
        wrap.className = "photo-thumb-wrap";
        const img = document.createElement("img");
        img.className = "photo-thumb"; img.src = photo.url; img.loading = "lazy";
        img.addEventListener("click", (e) => { e.stopPropagation(); openLightbox(photo.url); });
        wrap.appendChild(img);
        if (isAdmin){
          const rem = document.createElement("button");
          rem.className = "photo-remove"; rem.textContent = "✕"; rem.title = "Delete photo";
          rem.addEventListener("click", async (e) => {
            e.stopPropagation();
            if (!confirm("Delete this receipt photo?")) return;
            const newPhotos = c.photos.filter(ph => ph.id !== photo.id);
            try { await updateDoc(doc(db, "claims", c.id), { photos: newPhotos }); }
            catch (err){ alert("Couldn't delete this photo: " + err.message); }
          });
          wrap.appendChild(rem);
        }
        item.appendChild(wrap);
        if (isAdmin){
          const ann = document.createElement("button");
          ann.className = "annotate-btn"; ann.textContent = "✎ Annotate";
          ann.addEventListener("click", (e) => { e.stopPropagation(); openAnnotateModal("claims", c.id, photo.id); });
          item.appendChild(ann);
        }
        strip.appendChild(item);
      });
      if (isAdmin){
        const addBtn = document.createElement("div");
        addBtn.className = "add-photo-btn"; addBtn.textContent = "+ Add receipt photo";
        addBtn.addEventListener("click", (e) => { e.stopPropagation(); openPhotoPicker("claims", c.id, addBtn); });
        strip.appendChild(addBtn);
      }
      body.appendChild(strip);
    }
    card.appendChild(body);
    list.appendChild(card);
  });
}

// Consolidated Expense Claim Form covering every claim — laid out like a standard
// itemized-expense form (company/employee header fields, an itemized table, a
// subtotal/paid/due summary, and signature lines) rather than a generic data table,
// plus a small receipts appendix underneath so photos stay attached to the same
// document. Description is built from what was keyed in when the claim was logged
// (the notes field) since that's the only free-text record of what the receipt was for.
function buildClaimsPdfHtml(){
  const items = claimsCache.slice().sort((a,b) => (a.date || "").localeCompare(b.date || ""));
  const generated = new Date().toLocaleString("default", { dateStyle: "medium", timeStyle: "short" });
  let html = '<div class="pdf-doc pdf-claims"><h1>Expense Claim Form</h1>';

  if (items.length === 0){
    html += '<p class="pdf-meta">Indoor Farm — Takeover Tracker · Generated ' + escapeHtml(generated) + '</p>';
    html += "<p>No claims logged yet.</p></div>";
    return html;
  }

  const claimants = [...new Set(items.map(c => (c.claimant || "").trim()).filter(Boolean))];
  const dates = items.map(c => c.date).filter(Boolean).sort();
  const expensePeriod = dates.length ? (dates[0] === dates[dates.length - 1] ? dates[0] : dates[0] + " – " + dates[dates.length - 1]) : "—";

  html += '<div class="pdf-claims-header">';
  html += '<div class="pdf-claims-header-row"><span class="pdf-claims-label">Company Name:</span><span class="pdf-claims-value pdf-claims-value-wide">Indoor Farm — Takeover Tracker</span></div>';
  html += '<div class="pdf-claims-header-row two">';
  html += '<span><span class="pdf-claims-label">Employee Name:</span><span class="pdf-claims-value">' + (claimants.length ? escapeHtml(claimants.join(", ")) : "&nbsp;") + '</span></span>';
  html += '<span><span class="pdf-claims-label">Employee ID:</span><span class="pdf-claims-value">&nbsp;</span></span>';
  html += '</div>';
  html += '<div class="pdf-claims-header-row two">';
  html += '<span><span class="pdf-claims-label">Department:</span><span class="pdf-claims-value">&nbsp;</span></span>';
  html += '<span><span class="pdf-claims-label">Expense Period:</span><span class="pdf-claims-value">' + escapeHtml(expensePeriod) + '</span></span>';
  html += '</div>';
  html += '</div>';

  html += '<h2>Itemized Expenses</h2>';
  html += '<table class="pdf-claims-table"><thead><tr>';
  html += '<th>Date</th><th>Description</th><th>Category</th><th>Status</th><th class="pdf-claims-amt">Amount Paid</th>';
  html += '</tr></thead><tbody>';
  const totals = { pending: 0, approved: 0, paid: 0 };
  items.forEach(c => {
    const status = c.status || "pending";
    totals[status] = (totals[status] || 0) + (Number(c.amount) || 0);
    let description = c.notes || (CLAIM_CATEGORY_LABELS[c.category] || "Expense");
    if (c.claimant) description += " (" + c.claimant + ")";
    html += '<tr>';
    html += '<td>' + escapeHtml(c.date || "—") + '</td>';
    html += '<td>' + escapeHtml(description) + '</td>';
    html += '<td>' + escapeHtml(CLAIM_CATEGORY_LABELS[c.category] || "—") + '</td>';
    html += '<td>' + escapeHtml(CLAIM_STATUS_LABELS[status] || "Pending") + '</td>';
    html += '<td class="pdf-claims-amt">' + (c.amount != null ? "$" + Number(c.amount).toFixed(2) : "—") + '</td>';
    html += '</tr>';
  });
  html += '</tbody></table>';

  const subtotal = totals.pending + totals.approved + totals.paid;
  const alreadyPaid = totals.paid;
  const due = subtotal - alreadyPaid;
  html += '<div class="pdf-claims-summary">';
  html += '<div><span>Subtotal:</span><span>$' + subtotal.toFixed(2) + '</span></div>';
  html += '<div><span>Already Paid:</span><span>$' + alreadyPaid.toFixed(2) + '</span></div>';
  html += '<div class="pdf-claims-grand"><span>Total Reimbursement Due:</span><span>$' + due.toFixed(2) + '</span></div>';
  html += '</div>';

  html += '<div class="pdf-claims-sign-row">';
  html += '<div class="pdf-claims-sign-block"><div class="pdf-claims-sign-line"></div><span>Employee Signature</span></div>';
  html += '<div class="pdf-claims-sign-block"><div class="pdf-claims-sign-line"></div><span>Date</span></div>';
  html += '</div>';

  const withPhotos = items.filter(c => (c.photos || []).length);
  if (withPhotos.length){
    html += '<h2>Receipts</h2><div class="pdf-claims-photo-grid">';
    withPhotos.forEach(c => {
      c.photos.forEach(p => {
        html += '<div class="pdf-claims-photo-item"><img class="pdf-claims-photo" src="' + escapeHtml(cloudinaryThumb(p.url, 500)) + '">';
        html += '<div class="pdf-claims-photo-label">' + escapeHtml(c.date || "") + (c.claimant ? " — " + escapeHtml(c.claimant) : "") + '</div></div>';
      });
    });
    html += '</div>';
  }

  html += '<p class="pdf-meta pdf-claims-footer-meta">Generated ' + escapeHtml(generated) + ' · ' + items.length + ' claim' + (items.length === 1 ? "" : "s") + '</p>';
  html += '</div>';
  return html;
}

$("downloadClaimsPdfBtn").addEventListener("click", async () => {
  if (!isAdmin) return;
  const btn = $("downloadClaimsPdfBtn");
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = "Preparing PDF…";
  const area = $("pdfPrintArea");
  area.innerHTML = buildClaimsPdfHtml();
  await waitForImages(area, 8000);
  document.body.classList.add("printing-pdf");
  window.print();
  btn.disabled = false; btn.textContent = original;
});

$("addClaimBtn").addEventListener("click", async () => {
  if (!isAdmin) return;
  const dateInput = $("newClaimDate");
  const claimantInput = $("newClaimClaimant");
  const categoryInput = $("newClaimCategory");
  const amountInput = $("newClaimAmount");
  const notesInput = $("newClaimNotes");
  const date = dateInput.value || toKey(new Date());
  const claimant = claimantInput.value.trim();
  const category = categoryInput.value || "other";
  const amount = amountInput.value === "" ? null : Number(amountInput.value);
  const notes = notesInput.value.trim();
  const btn = $("addClaimBtn");
  btn.disabled = true; btn.textContent = "Adding…";
  try {
    const newDoc = await addDoc(collection(db, "claims"), { date, claimant, category, amount, notes, status: "pending", photos: [] });
    expandedClaims[newDoc.id] = true;
    claimantInput.value = ""; amountInput.value = ""; notesInput.value = ""; categoryInput.value = "taxi";
  } catch (err){
    alert("Couldn't save this claim: " + err.message + "\n\nIf this says \"permission denied\", the claims rule in firestore.rules needs to be published in the Firebase console (Firestore Database → Rules).");
  } finally {
    btn.disabled = false; btn.textContent = "Add";
  }
});
(() => { const t = toKey(new Date()); $("newClaimDate").value = inRange(t) ? t : START_DATE; })();

$("quickClaimPhotoBtn").addEventListener("click", async () => {
  if (!isAdmin) return;
  const btn = $("quickClaimPhotoBtn");
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = "Creating…";
  try {
    const newDoc = await addDoc(collection(db, "claims"), {
      date: toKey(new Date()), claimant: "", category: "other", amount: null, notes: "", status: "pending", photos: []
    });
    expandedClaims[newDoc.id] = true;
    openPhotoPicker("claims", newDoc.id, null);
  } catch (err){
    alert("Couldn't start this claim: " + err.message);
  } finally {
    btn.disabled = false; btn.textContent = original;
  }
});

// ============================================================================
// PLANT GUIDE (Firestore: plantGuide/{id}) — reference infographics + notes,
// same photo/annotate pipeline as Findings Log, keyed by title instead of date
// ============================================================================
let plantGuideCache = [];
let plantSearchTerm = "";
const expandedPlants = {};

onSnapshot(collection(db, "plantGuide"), (snap) => {
  plantGuideCache = snap.docs.map(d => ({ id: d.id, photos: [], ...d.data() }));
  renderPlantGuide();
}, () => setSyncStatus("err", "Connection error"));

$("plantSearch").addEventListener("input", (e) => { plantSearchTerm = e.target.value.trim().toLowerCase(); renderPlantGuide(); });
$("plantSearchClear").addEventListener("click", () => { $("plantSearch").value = ""; plantSearchTerm = ""; renderPlantGuide(); });

function renderPlantGuide(){
  const list = $("plantList");
  list.innerHTML = "";

  let items = plantGuideCache.slice().sort((a,b) => (a.title || "").localeCompare(b.title || ""));
  if (plantSearchTerm){
    items = items.filter(p => (p.title || "").toLowerCase().includes(plantSearchTerm) || (p.notes || "").toLowerCase().includes(plantSearchTerm));
  }

  if (items.length === 0){
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = plantSearchTerm ? "No entries match your search." : "No plant guide entries yet.";
    list.appendChild(empty);
    return;
  }

  items.forEach(p => {
    const isOpen = plantSearchTerm ? true : !!expandedPlants[p.id];
    const card = document.createElement("div");
    card.className = "finding-card" + (isOpen ? " expanded" : "");

    const header = document.createElement("div");
    header.className = "finding-header";
    const left = document.createElement("div");
    left.className = "finding-header-left";
    const chevron = document.createElement("span");
    chevron.className = "finding-chevron"; chevron.textContent = "▶";
    const titleEl = document.createElement("span");
    titleEl.className = "finding-date"; titleEl.textContent = p.title || "Untitled";
    left.appendChild(chevron); left.appendChild(titleEl);
    if (!isOpen){
      const preview = document.createElement("span");
      preview.className = "finding-preview";
      preview.textContent = p.notes || (p.photos.length ? p.photos.length + " photo(s)" : "");
      left.appendChild(preview);
    }
    header.appendChild(left);

    if (isAdmin){
      const del = document.createElement("button");
      del.className = "icon-btn"; del.textContent = "✕"; del.title = "Delete entry";
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("Delete this plant guide entry and its photos?")) return;
        try {
          await moveToTrash("plantGuide", p.id, p);
        } catch (err){
          alert("Couldn't delete this entry: " + err.message);
        }
      });
      header.appendChild(del);
    }
    header.addEventListener("click", () => {
      if (expandedPlants[p.id]) delete expandedPlants[p.id]; else expandedPlants[p.id] = true;
      renderPlantGuide();
    });
    card.appendChild(header);

    const body = document.createElement("div");
    body.className = "finding-body";
    if (isOpen){
      const titleInput = document.createElement("div");
      titleInput.className = "finding-text";
      titleInput.style.fontWeight = "600";
      titleInput.contentEditable = isAdmin ? "true" : "false";
      titleInput.textContent = p.title || "";
      titleInput.addEventListener("click", (e) => e.stopPropagation());
      titleInput.addEventListener("blur", async () => {
        if (!isAdmin) return;
        const val = titleInput.innerText.trim();
        if (!val || val === p.title) { titleInput.textContent = p.title || ""; return; }
        try {
          await updateDoc(doc(db, "plantGuide", p.id), { title: val });
        } catch (err){
          alert("Couldn't save the title: " + err.message);
          titleInput.textContent = p.title || "";
        }
      });
      body.appendChild(titleInput);

      const notes = document.createElement("div");
      notes.className = "finding-text";
      notes.contentEditable = isAdmin ? "true" : "false";
      notes.textContent = p.notes || "";
      notes.addEventListener("click", (e) => e.stopPropagation());
      notes.addEventListener("blur", async () => {
        if (!isAdmin) return;
        const val = notes.innerText.trim();
        if (val === p.notes) return;
        try {
          await updateDoc(doc(db, "plantGuide", p.id), { notes: val });
        } catch (err){
          alert("Couldn't save the notes: " + err.message);
          notes.textContent = p.notes || "";
        }
      });
      body.appendChild(notes);

      const strip = document.createElement("div");
      strip.className = "photo-strip";
      p.photos.forEach(photo => {
        const item = document.createElement("div");
        item.className = "photo-item";
        const wrap = document.createElement("div");
        wrap.className = "photo-thumb-wrap";
        const img = document.createElement("img");
        img.className = "photo-thumb"; img.src = photo.url; img.loading = "lazy";
        img.addEventListener("click", (e) => { e.stopPropagation(); openLightbox(photo.url); });
        wrap.appendChild(img);
        if (isAdmin){
          const rem = document.createElement("button");
          rem.className = "photo-remove"; rem.textContent = "✕"; rem.title = "Delete photo";
          rem.addEventListener("click", async (e) => {
            e.stopPropagation();
            if (!confirm("Delete this photo?")) return;
            const newPhotos = p.photos.filter(ph => ph.id !== photo.id);
            try {
              await updateDoc(doc(db, "plantGuide", p.id), { photos: newPhotos });
            } catch (err){
              alert("Couldn't delete this photo: " + err.message);
            }
          });
          wrap.appendChild(rem);
        }
        item.appendChild(wrap);
        if (isAdmin){
          const ann = document.createElement("button");
          ann.className = "annotate-btn"; ann.textContent = "✎ Annotate";
          ann.addEventListener("click", (e) => { e.stopPropagation(); openAnnotateModal("plantGuide", p.id, photo.id); });
          item.appendChild(ann);
        }
        strip.appendChild(item);
      });
      if (isAdmin){
        const addBtn = document.createElement("div");
        addBtn.className = "add-photo-btn"; addBtn.textContent = "+ Add photo";
        addBtn.addEventListener("click", (e) => { e.stopPropagation(); openPhotoPicker("plantGuide", p.id, addBtn); });
        strip.appendChild(addBtn);
      }
      body.appendChild(strip);
    }
    card.appendChild(body);
    list.appendChild(card);
  });
}

$("addPlantBtn").addEventListener("click", async () => {
  if (!isAdmin) return;
  const titleInput = $("newPlantTitle");
  const notesInput = $("newPlantNotes");
  const title = requireValue(titleInput, "a plant / topic name");
  if (!title) return;
  const notes = notesInput.value.trim();
  const btn = $("addPlantBtn");
  btn.disabled = true; btn.textContent = "Adding…";
  try {
    const newDoc = await addDoc(collection(db, "plantGuide"), { title, notes, photos: [] });
    expandedPlants[newDoc.id] = true;
    titleInput.value = "";
    notesInput.value = "";
  } catch (err){
    alert("Couldn't save this entry: " + err.message + "\n\nIf this says \"permission denied\", the plantGuide rule in firestore.rules needs to be published in the Firebase console (Firestore Database → Rules).");
  } finally {
    btn.disabled = false; btn.textContent = "Add";
  }
});

// ============================================================================
// SPECIAL EVENTS (Firestore: specialEvents/{id}) — one-off events outside the
// daily routine, kept as a year-over-year reference for planning. Same
// collapsible-card/photo-strip pattern as Findings Log and Plant Guide.
// ============================================================================
let specialEventsCache = [];
let specialEventsSearchTerm = "";
const expandedSpecialEvents = {};

onSnapshot(collection(db, "specialEvents"), (snap) => {
  specialEventsCache = snap.docs.map(d => ({ id: d.id, photos: [], ...d.data() }));
  renderSpecialEvents();
  renderDailySchedule();
}, () => setSyncStatus("err", "Connection error"));

$("specialEventsSearch").addEventListener("input", (e) => { specialEventsSearchTerm = e.target.value.trim().toLowerCase(); renderSpecialEvents(); });
$("specialEventsSearchClear").addEventListener("click", () => { $("specialEventsSearch").value = ""; specialEventsSearchTerm = ""; renderSpecialEvents(); });

function renderSpecialEvents(){
  const list = $("specialEventsList");
  list.innerHTML = "";

  let items = specialEventsCache.slice().sort((a,b) => (b.startDate || "").localeCompare(a.startDate || ""));
  if (specialEventsSearchTerm){
    items = items.filter(ev =>
      (ev.title || "").toLowerCase().includes(specialEventsSearchTerm) ||
      (ev.notes || "").toLowerCase().includes(specialEventsSearchTerm) ||
      (ev.startDate || "").includes(specialEventsSearchTerm) ||
      (ev.endDate || "").includes(specialEventsSearchTerm)
    );
  }

  if (items.length === 0){
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = specialEventsSearchTerm ? "No special events match your search." : "No special events logged yet.";
    list.appendChild(empty);
    return;
  }

  items.forEach(ev => {
    const isOpen = specialEventsSearchTerm ? true : !!expandedSpecialEvents[ev.id];
    const card = document.createElement("div");
    card.className = "finding-card" + (isOpen ? " expanded" : "");

    const header = document.createElement("div");
    header.className = "finding-header";
    const left = document.createElement("div");
    left.className = "finding-header-left";
    const chevron = document.createElement("span");
    chevron.className = "finding-chevron"; chevron.textContent = "▶";
    const dateEl = document.createElement("span");
    dateEl.className = "finding-date";
    let dateText = ev.endDate && ev.endDate !== ev.startDate ? ((ev.startDate || "") + " → " + ev.endDate) : (ev.startDate || "");
    if (ev.startTime) dateText += " · " + ev.startTime + (ev.endTime ? "–" + ev.endTime : "");
    dateEl.textContent = dateText;
    left.appendChild(chevron); left.appendChild(dateEl);
    const titleTag = document.createElement("span");
    titleTag.className = "finding-latest-tag";
    titleTag.style.background = "#eef4fe"; titleTag.style.color = "#0b57d0";
    titleTag.textContent = ev.title || "Untitled event";
    left.appendChild(titleTag);
    if (!isOpen && ev.notes){
      const preview = document.createElement("span");
      preview.className = "finding-preview";
      preview.textContent = ev.notes;
      left.appendChild(preview);
    }
    header.appendChild(left);

    if (isAdmin){
      const del = document.createElement("button");
      del.className = "icon-btn"; del.textContent = "✕"; del.title = "Delete event";
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("Delete this special event and its photos?")) return;
        try { await moveToTrash("specialEvents", ev.id, ev); }
        catch (err){ alert("Couldn't delete this event: " + err.message); }
      });
      header.appendChild(del);
    }
    header.addEventListener("click", () => {
      if (expandedSpecialEvents[ev.id]) delete expandedSpecialEvents[ev.id]; else expandedSpecialEvents[ev.id] = true;
      renderSpecialEvents();
    });
    card.appendChild(header);

    const body = document.createElement("div");
    body.className = "finding-body";
    if (isOpen){
      const titleInput = document.createElement("div");
      titleInput.className = "finding-text";
      titleInput.style.fontWeight = "600";
      titleInput.contentEditable = isAdmin ? "true" : "false";
      titleInput.textContent = ev.title || "";
      titleInput.addEventListener("click", (e) => e.stopPropagation());
      titleInput.addEventListener("blur", async () => {
        if (!isAdmin) return;
        const val = titleInput.innerText.trim();
        if (!val || val === ev.title) { titleInput.textContent = ev.title || ""; return; }
        try { await updateDoc(doc(db, "specialEvents", ev.id), { title: val }); }
        catch (err){ alert("Couldn't save the title: " + err.message); titleInput.textContent = ev.title || ""; }
      });
      body.appendChild(titleInput);

      if (isAdmin){
        const dateRow = document.createElement("div");
        dateRow.className = "row2";
        dateRow.style.marginTop = "8px";
        const startField = document.createElement("div"); startField.className = "field";
        startField.innerHTML = "<label>Start date</label>";
        const startInput = document.createElement("input");
        startInput.type = "date"; startInput.value = ev.startDate || "";
        startInput.addEventListener("change", async () => {
          try { await updateDoc(doc(db, "specialEvents", ev.id), { startDate: startInput.value }); }
          catch (err){ alert("Couldn't save the start date: " + err.message); }
        });
        startField.appendChild(startInput);
        const endField = document.createElement("div"); endField.className = "field";
        endField.innerHTML = "<label>End date</label>";
        const endInput = document.createElement("input");
        endInput.type = "date"; endInput.value = ev.endDate || "";
        endInput.addEventListener("change", async () => {
          try { await updateDoc(doc(db, "specialEvents", ev.id), { endDate: endInput.value }); }
          catch (err){ alert("Couldn't save the end date: " + err.message); }
        });
        endField.appendChild(endInput);
        dateRow.appendChild(startField); dateRow.appendChild(endField);
        body.appendChild(dateRow);

        const timeRow = document.createElement("div");
        timeRow.className = "row2";
        timeRow.style.marginTop = "8px";
        const startTimeField = document.createElement("div"); startTimeField.className = "field";
        startTimeField.innerHTML = "<label>Start time (optional)</label>";
        const startTimeInput = document.createElement("input");
        startTimeInput.type = "time"; startTimeInput.value = ev.startTime || "";
        startTimeInput.addEventListener("change", async () => {
          try { await updateDoc(doc(db, "specialEvents", ev.id), { startTime: startTimeInput.value }); }
          catch (err){ alert("Couldn't save the start time: " + err.message); }
        });
        startTimeField.appendChild(startTimeInput);
        const endTimeField = document.createElement("div"); endTimeField.className = "field";
        endTimeField.innerHTML = "<label>End time (optional)</label>";
        const endTimeInput = document.createElement("input");
        endTimeInput.type = "time"; endTimeInput.value = ev.endTime || "";
        endTimeInput.addEventListener("change", async () => {
          try { await updateDoc(doc(db, "specialEvents", ev.id), { endTime: endTimeInput.value }); }
          catch (err){ alert("Couldn't save the end time: " + err.message); }
        });
        endTimeField.appendChild(endTimeInput);
        timeRow.appendChild(startTimeField); timeRow.appendChild(endTimeField);
        body.appendChild(timeRow);
        const timeHint = document.createElement("p");
        timeHint.className = "hint"; timeHint.style.margin = "0 0 8px";
        timeHint.textContent = "Leave blank for an all-day entry. Set a start time to also show this event on the Daily Schedule's timetable for its date(s).";
        body.appendChild(timeHint);
      }

      const notes = document.createElement("div");
      notes.className = "finding-text";
      notes.contentEditable = isAdmin ? "true" : "false";
      notes.textContent = ev.notes || "";
      notes.addEventListener("click", (e) => e.stopPropagation());
      notes.addEventListener("blur", async () => {
        if (!isAdmin) return;
        const val = notes.innerText.trim();
        if (val === ev.notes) return;
        try { await updateDoc(doc(db, "specialEvents", ev.id), { notes: val }); }
        catch (err){ alert("Couldn't save the notes: " + err.message); notes.textContent = ev.notes || ""; }
      });
      body.appendChild(notes);

      const strip = document.createElement("div");
      strip.className = "photo-strip";
      ev.photos.forEach(photo => {
        const item = document.createElement("div");
        item.className = "photo-item";
        const wrap = document.createElement("div");
        wrap.className = "photo-thumb-wrap";
        const img = document.createElement("img");
        img.className = "photo-thumb"; img.src = photo.url; img.loading = "lazy";
        img.addEventListener("click", (e) => { e.stopPropagation(); openLightbox(photo.url); });
        wrap.appendChild(img);
        if (isAdmin){
          const rem = document.createElement("button");
          rem.className = "photo-remove"; rem.textContent = "✕"; rem.title = "Delete photo";
          rem.addEventListener("click", async (e) => {
            e.stopPropagation();
            if (!confirm("Delete this photo?")) return;
            const newPhotos = ev.photos.filter(p => p.id !== photo.id);
            try { await updateDoc(doc(db, "specialEvents", ev.id), { photos: newPhotos }); }
            catch (err){ alert("Couldn't delete this photo: " + err.message); }
          });
          wrap.appendChild(rem);
        }
        item.appendChild(wrap);
        if (isAdmin){
          const ann = document.createElement("button");
          ann.className = "annotate-btn"; ann.textContent = "✎ Annotate";
          ann.addEventListener("click", (e) => { e.stopPropagation(); openAnnotateModal("specialEvents", ev.id, photo.id); });
          item.appendChild(ann);
        }
        strip.appendChild(item);
      });
      if (isAdmin){
        const addBtn = document.createElement("div");
        addBtn.className = "add-photo-btn"; addBtn.textContent = "+ Add photo";
        addBtn.addEventListener("click", (e) => { e.stopPropagation(); openPhotoPicker("specialEvents", ev.id, addBtn); });
        strip.appendChild(addBtn);
      }
      body.appendChild(strip);
    }
    card.appendChild(body);
    list.appendChild(card);
  });
}

$("addSpecialEventBtn").addEventListener("click", async () => {
  if (!isAdmin) return;
  const titleInput = $("newSpecialEventTitle");
  const startInput = $("newSpecialEventStart");
  const endInput = $("newSpecialEventEnd");
  const startTimeInput = $("newSpecialEventStartTime");
  const endTimeInput = $("newSpecialEventEndTime");
  const notesInput = $("newSpecialEventNotes");
  const title = requireValue(titleInput, "an event name");
  if (!title) return;
  const startDate = startInput.value || toKey(new Date());
  const endDate = endInput.value || "";
  const startTime = startTimeInput.value || "";
  const endTime = endTimeInput.value || "";
  const notes = notesInput.value.trim();
  const btn = $("addSpecialEventBtn");
  btn.disabled = true; btn.textContent = "Adding…";
  try {
    const newDoc = await addDoc(collection(db, "specialEvents"), { title, startDate, endDate, startTime, endTime, notes, photos: [] });
    expandedSpecialEvents[newDoc.id] = true;
    titleInput.value = ""; startInput.value = ""; endInput.value = ""; startTimeInput.value = ""; endTimeInput.value = ""; notesInput.value = "";
  } catch (err){
    alert("Couldn't save this event: " + err.message + "\n\nIf this says \"permission denied\", the specialEvents rule in firestore.rules needs to be published in the Firebase console (Firestore Database → Rules).");
  } finally {
    btn.disabled = false; btn.textContent = "Add";
  }
});

// ============================================================================
// GROW LOG — plant types, harvests, transplants, germinations, losses,
// environment readings, and the trends dashboard
// ============================================================================
// germOnSite historically only ever fed Level 1, so it's relabeled "Level 1 Germ"
// rather than migrated to a new key — every existing germination/transplant record
// keeps working unchanged. germLevel3 is the newly split-out room for Level 3.
const LOCATIONS = { germOnSite: "Level 1 Germ", level1: "Level 1", level3: "Level 3", germLevel3: "Level 3 Germ", germOffSite: "Off Site" };
const GERM_ROOMS = ["germOnSite", "germLevel3", "germOffSite"];
// Physical tray capacity per Level 3 rack row: Side A (herbs) rows run a 13-day
// succession, Side B (lettuce + ice plant) rows run 11. Rows with no rack side set
// (or on Level 1, which isn't tiered this way) have no cap.
const TRAY_MAX_BY_SIDE = { A: 13, B: 11 };
// Level 1 Germ runs a 14-tray daily succession (100 seedlings each) per plant type —
// other germination rooms have no known physical cap yet.
const GERM_TRAY_MAX = { germOnSite: 14 };
// Level 1 is one carousel per plant type with a fixed 142 towers — capacity there is
// a plant-count cap (towers x that plant type's plantsPerTower), not a tray count,
// since a carousel gets refilled in whatever chunk size fits (not always the same
// size every time).
const LEVEL1_TOWER_CAP = 142;
function plantTypePlantsPerTower(id){
  const pt = plantTypesCache.find(p => p.id === id);
  return pt && pt.plantsPerTower != null ? Number(pt.plantsPerTower) : null;
}
function capitalize(s){ return s.charAt(0).toUpperCase() + s.slice(1); }

// ---- Plant Types (Firestore: plantTypes/{id}) ----
let plantTypesCache = [];
onSnapshot(collection(db, "plantTypes"), (snap) => {
  plantTypesCache = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => (a.name||"").localeCompare(b.name||""));
  renderPlantTypes();
  populatePlantTypeSelects();
  renderStandingStock();
  populateAllBatchSelects();
}, () => setSyncStatus("err", "Connection error"));

function plantTypeName(id){
  const pt = plantTypesCache.find(p => p.id === id);
  return pt ? pt.name : "(unknown plant)";
}
function plantTypeGermDays(id){
  const pt = plantTypesCache.find(p => p.id === id);
  return (pt && pt.germinationDays != null) ? pt.germinationDays : null;
}

function renderPlantTypes(){
  const list = $("plantTypesList");
  list.innerHTML = "";
  if (plantTypesCache.length === 0){
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No plant types added yet.";
    list.appendChild(empty);
    return;
  }
  plantTypesCache.forEach(pt => {
    const row = document.createElement("div");
    row.className = "staff-row";

    const name = document.createElement("div");
    name.className = "staff-name";
    name.contentEditable = "true";
    name.textContent = pt.name;
    name.addEventListener("blur", async () => {
      const val = name.textContent.trim();
      if (!val){ name.textContent = pt.name; return; }
      if (val === pt.name) return;
      try { await updateDoc(doc(db, "plantTypes", pt.id), { name: val }); }
      catch (err){ alert("Couldn't rename this plant type: " + err.message); name.textContent = pt.name; }
    });
    name.addEventListener("keydown", (e) => { if (e.key === "Enter"){ e.preventDefault(); name.blur(); } });

    const germDays = document.createElement("input");
    germDays.type = "number"; germDays.min = "0"; germDays.step = "1";
    germDays.className = "staff-pin-input"; germDays.title = "Germination days";
    germDays.placeholder = "days";
    if (pt.germinationDays != null) germDays.value = pt.germinationDays;
    germDays.addEventListener("change", async () => {
      const val = germDays.value === "" ? null : Number(germDays.value);
      try { await updateDoc(doc(db, "plantTypes", pt.id), { germinationDays: val }); }
      catch (err){ alert("Couldn't save germination days: " + err.message); germDays.value = pt.germinationDays != null ? pt.germinationDays : ""; }
    });

    const del = document.createElement("button");
    del.className = "icon-btn"; del.textContent = "✕"; del.title = "Remove plant type";
    del.addEventListener("click", async () => {
      if (!confirm("Remove \"" + pt.name + "\" from plant types? Past log entries keep their recorded name.")) return;
      try { await moveToTrash("plantTypes", pt.id, pt); }
      catch (err){ alert("Couldn't delete this plant type: " + err.message); }
    });

    row.appendChild(name); row.appendChild(germDays); row.appendChild(del);
    list.appendChild(row);
  });
}

$("togglePlantTypesBtn").addEventListener("click", () => {
  const panel = $("plantTypesPanel");
  panel.style.display = panel.style.display === "none" ? "block" : "none";
});

$("addPlantTypeBtn").addEventListener("click", async () => {
  if (!isAdmin) return;
  const input = $("newPlantTypeName");
  const germDaysInput = $("newPlantTypeGermDays");
  const name = requireValue(input, "a plant type name");
  if (!name) return;
  const germinationDays = germDaysInput.value === "" ? null : Number(germDaysInput.value);
  try {
    await addDoc(collection(db, "plantTypes"), { name, germinationDays });
    input.value = ""; germDaysInput.value = "";
  } catch (err){
    alert("Couldn't add this plant type: " + err.message);
  }
});

function populatePlantTypeSelects(){
  ["harvests", "transplants", "germinations", "losses"].forEach(col => {
    const sel = $(col + "PlantType");
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = "";
    if (plantTypesCache.length === 0){
      const opt = document.createElement("option");
      opt.value = ""; opt.textContent = "Add a plant type first (⚙ above)";
      sel.appendChild(opt);
      return;
    }
    plantTypesCache.forEach(pt => {
      const opt = document.createElement("option");
      opt.value = pt.id; opt.textContent = pt.name;
      sel.appendChild(opt);
    });
    if (prev && plantTypesCache.some(pt => pt.id === prev)) sel.value = prev;
  });
}

// ---- Tanks (Firestore: tanks/{id}) — nutrient tank zones on Level 1 and
// Level 3. Each zone (e.g. "East", "North 1") is one physical water system
// that gets ONE environment reading per visit, regardless of how many
// individual tanks feed it — tankCount/crops/nutrientType are descriptive
// metadata only, not used to split readings.
let tanksCache = [];
onSnapshot(collection(db, "tanks"), (snap) => {
  tanksCache = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a,b) => (a.level||"").localeCompare(b.level||"") || (a.name||"").localeCompare(b.name||""));
  renderTanks();
  populateEnvReadingsTankOptions();
}, () => setSyncStatus("err", "Connection error"));

function tankName(id){
  const t = tanksCache.find(x => x.id === id);
  return t ? t.name : "";
}

function renderTanks(){
  const list = $("tanksList");
  list.innerHTML = "";
  if (tanksCache.length === 0){
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No tanks added yet.";
    list.appendChild(empty);
    return;
  }
  tanksCache.forEach(t => {
    const row = document.createElement("div");
    row.className = "staff-row";
    row.style.flexWrap = "wrap";

    const name = document.createElement("div");
    name.className = "staff-name";
    name.contentEditable = "true";
    name.textContent = t.name;
    name.style.flex = "1 1 120px";
    name.addEventListener("blur", async () => {
      const val = name.textContent.trim();
      if (!val){ name.textContent = t.name; return; }
      if (val === t.name) return;
      try { await updateDoc(doc(db, "tanks", t.id), { name: val }); }
      catch (err){ alert("Couldn't rename this tank: " + err.message); name.textContent = t.name; }
    });
    name.addEventListener("keydown", (e) => { if (e.key === "Enter"){ e.preventDefault(); name.blur(); } });

    const level = document.createElement("select");
    level.style.maxWidth = "110px";
    [["level1","Level 1"],["level3","Level 3"]].forEach(([val, label]) => {
      const opt = document.createElement("option");
      opt.value = val; opt.textContent = label;
      level.appendChild(opt);
    });
    level.value = t.level;
    level.addEventListener("change", async () => {
      try { await updateDoc(doc(db, "tanks", t.id), { level: level.value }); }
      catch (err){ alert("Couldn't change level: " + err.message); level.value = t.level; }
    });

    const count = document.createElement("input");
    count.type = "number"; count.min = "0"; count.step = "1";
    count.className = "staff-pin-input"; count.title = "No. of tanks";
    count.placeholder = "# tanks";
    count.style.maxWidth = "80px";
    if (t.tankCount != null) count.value = t.tankCount;
    count.addEventListener("change", async () => {
      const val = count.value === "" ? null : Number(count.value);
      try { await updateDoc(doc(db, "tanks", t.id), { tankCount: val }); }
      catch (err){ alert("Couldn't save tank count: " + err.message); count.value = t.tankCount != null ? t.tankCount : ""; }
    });

    const crops = document.createElement("div");
    crops.contentEditable = "true";
    crops.className = "staff-name";
    crops.style.flex = "1 1 140px";
    crops.textContent = t.crops || "";
    crops.dataset.placeholder = "Crop type(s)";
    crops.addEventListener("blur", async () => {
      const val = crops.textContent.trim();
      if (val === (t.crops || "")) return;
      try { await updateDoc(doc(db, "tanks", t.id), { crops: val }); }
      catch (err){ alert("Couldn't save crops: " + err.message); crops.textContent = t.crops || ""; }
    });
    crops.addEventListener("keydown", (e) => { if (e.key === "Enter"){ e.preventDefault(); crops.blur(); } });

    const nutrient = document.createElement("div");
    nutrient.contentEditable = "true";
    nutrient.className = "staff-name";
    nutrient.style.flex = "1 1 140px";
    nutrient.textContent = t.nutrientType || "";
    nutrient.addEventListener("blur", async () => {
      const val = nutrient.textContent.trim();
      if (val === (t.nutrientType || "")) return;
      try { await updateDoc(doc(db, "tanks", t.id), { nutrientType: val }); }
      catch (err){ alert("Couldn't save nutrient type: " + err.message); nutrient.textContent = t.nutrientType || ""; }
    });
    nutrient.addEventListener("keydown", (e) => { if (e.key === "Enter"){ e.preventDefault(); nutrient.blur(); } });

    const del = document.createElement("button");
    del.className = "icon-btn"; del.textContent = "✕"; del.title = "Remove tank";
    del.addEventListener("click", async () => {
      if (!confirm("Remove tank zone \"" + t.name + "\"? Past readings keep their recorded tank name.")) return;
      try { await moveToTrash("tanks", t.id, t); }
      catch (err){ alert("Couldn't delete this tank: " + err.message); }
    });

    row.appendChild(name); row.appendChild(level); row.appendChild(count);
    row.appendChild(crops); row.appendChild(nutrient); row.appendChild(del);
    list.appendChild(row);
  });
}

$("toggleTanksBtn").addEventListener("click", () => {
  const panel = $("tanksPanel");
  panel.style.display = panel.style.display === "none" ? "block" : "none";
});

$("addTankBtn").addEventListener("click", async () => {
  if (!isAdmin) return;
  const nameInput = $("newTankName");
  const name = requireValue(nameInput, "a zone name");
  if (!name) return;
  const level = $("newTankLevel").value;
  const countInput = $("newTankCount");
  const tankCount = countInput.value === "" ? null : Number(countInput.value);
  const crops = $("newTankCrops").value.trim();
  const nutrientType = $("newTankNutrient").value.trim();
  try {
    await addDoc(collection(db, "tanks"), { name, level, tankCount, crops, nutrientType });
    nameInput.value = ""; countInput.value = ""; $("newTankCrops").value = ""; $("newTankNutrient").value = "";
  } catch (err){
    alert("Couldn't add this tank: " + err.message);
  }
});

function populateEnvReadingsTankOptions(){
  const loc = $("envReadingsLocation").value;
  const row = $("envReadingsTankRow");
  const sel = $("envReadingsTank");
  const relevant = (loc === "level1" || loc === "level3") ? tanksCache.filter(t => t.level === loc) : [];
  if (relevant.length === 0){
    row.style.display = "none";
    sel.innerHTML = "";
    return;
  }
  row.style.display = "flex";
  const prev = sel.value;
  sel.innerHTML = "";
  const noneOpt = document.createElement("option");
  noneOpt.value = ""; noneOpt.textContent = "— None —";
  sel.appendChild(noneOpt);
  relevant.forEach(t => {
    const opt = document.createElement("option");
    opt.value = t.id; opt.textContent = t.name;
    sel.appendChild(opt);
  });
  if (prev && relevant.some(t => t.id === prev)) sel.value = prev;
}
$("envReadingsLocation").addEventListener("change", populateEnvReadingsTankOptions);

// ---- Harvest Destinations (Firestore: harvestDestinations/{id}) — where
// harvested crops go. Seeded once with a starter list if the collection is
// empty; managed the same way as Plant Types (rename inline, delete, add).
const DEFAULT_HARVEST_DESTINATIONS = ["Na Oh Restaurant", "Cafeteria", "Visitor Tour", "Food Bank"];
let harvestDestinationsCache = [];
let harvestDestinationsSeeded = false;

onSnapshot(collection(db, "harvestDestinations"), async (snap) => {
  harvestDestinationsCache = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => (a.name||"").localeCompare(b.name||""));
  renderHarvestDestinations();
  populateHarvestDestinationSelects();
  if (isDashboardActive()) renderDashboard();
  if (snap.empty && isAdmin && !harvestDestinationsSeeded){
    harvestDestinationsSeeded = true;
    try {
      const batch = writeBatch(db);
      DEFAULT_HARVEST_DESTINATIONS.forEach(name => batch.set(doc(collection(db, "harvestDestinations")), { name }));
      await batch.commit();
    } catch (err){ /* admin can add these manually if seeding fails (e.g. rules not published yet) */ }
  }
}, () => setSyncStatus("err", "Connection error"));

function harvestDestinationName(id){
  const dest = harvestDestinationsCache.find(d => d.id === id);
  return dest ? dest.name : null;
}

function renderHarvestDestinations(){
  const list = $("destinationsList");
  if (!list) return;
  list.innerHTML = "";
  if (harvestDestinationsCache.length === 0){
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No destinations added yet.";
    list.appendChild(empty);
    return;
  }
  harvestDestinationsCache.forEach(dest => {
    const row = document.createElement("div");
    row.className = "staff-row";

    const name = document.createElement("div");
    name.className = "staff-name";
    name.contentEditable = "true";
    name.textContent = dest.name;
    name.addEventListener("blur", async () => {
      const val = name.textContent.trim();
      if (!val){ name.textContent = dest.name; return; }
      if (val === dest.name) return;
      try { await updateDoc(doc(db, "harvestDestinations", dest.id), { name: val }); }
      catch (err){ alert("Couldn't rename this destination: " + err.message); name.textContent = dest.name; }
    });
    name.addEventListener("keydown", (e) => { if (e.key === "Enter"){ e.preventDefault(); name.blur(); } });

    const del = document.createElement("button");
    del.className = "icon-btn"; del.textContent = "✕"; del.title = "Remove destination";
    del.addEventListener("click", async () => {
      if (!confirm("Remove \"" + dest.name + "\" from destinations? Past harvest entries keep their recorded destination.")) return;
      try { await moveToTrash("harvestDestinations", dest.id, dest); }
      catch (err){ alert("Couldn't delete this destination: " + err.message); }
    });

    row.appendChild(name); row.appendChild(del);
    list.appendChild(row);
  });
}

$("toggleDestinationsBtn").addEventListener("click", () => {
  const panel = $("destinationsPanel");
  panel.style.display = panel.style.display === "none" ? "block" : "none";
});

$("addDestinationBtn").addEventListener("click", async () => {
  if (!isAdmin) return;
  const input = $("newDestinationName");
  const name = requireValue(input, "a destination name");
  if (!name) return;
  try {
    await addDoc(collection(db, "harvestDestinations"), { name });
    input.value = "";
  } catch (err){
    alert("Couldn't add this destination: " + err.message);
  }
});

function populateHarvestDestinationSelects(){
  const sel = $("harvestsDestination");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = "";
  if (harvestDestinationsCache.length === 0){
    const opt = document.createElement("option");
    opt.value = ""; opt.textContent = "Add a destination first (⚙ above)";
    sel.appendChild(opt);
    return;
  }
  harvestDestinationsCache.forEach(dest => {
    const opt = document.createElement("option");
    opt.value = dest.id; opt.textContent = dest.name;
    sel.appendChild(opt);
  });
  if (prev && harvestDestinationsCache.some(dest => dest.id === prev)) sel.value = prev;
}

// ---- Harvest / Seedling Transfer / Germination / Losses ----
// All four are "dated log: plant type + quantity + one-or-two location
// fields + notes + photos" — driven by one config-driven renderer instead
// of four near-identical copies of the Findings Log pattern.
const LOG_CONFIGS = {
  harvests: {
    locationField: { key: "location", options: [["level1","Level 1"],["level3","Level 3"]] },
    destinationField: { key: "destinationId" },
    batchField: true,
  },
  germinations: {
    locationField: { key: "room", options: [["germOnSite","Level 1 Germ"],["germLevel3","Level 3 Germ"],["germOffSite","Off Site"]] },
  },
  transplants: {
    locationField: { key: "sourceRoom", options: [["germOnSite","Level 1 Germ"],["germLevel3","Level 3 Germ"],["germOffSite","Off Site"]] },
    secondLocationField: { key: "destLevel", options: [["level1","Level 1"],["level3","Level 3"]] },
    ageAtTransferField: true,
    rackPositionField: true,
  },
  losses: {
    locationField: { key: "location", options: Object.entries(LOCATIONS) },
    batchField: true,
  },
};

let harvestsCache = [], transplantsCache = [], germinationsCache = [], lossesCache = [];
const expandedHarvests = {}, expandedTransplants = {}, expandedGerminations = {}, expandedLosses = {};
const LOG_CACHES = { harvests: () => harvestsCache, transplants: () => transplantsCache, germinations: () => germinationsCache, losses: () => lossesCache };
const LOG_EXPANDED = { harvests: expandedHarvests, transplants: expandedTransplants, germinations: expandedGerminations, losses: expandedLosses };
const LOG_SETTERS = {
  harvests: (v) => harvestsCache = v,
  transplants: (v) => transplantsCache = v,
  germinations: (v) => germinationsCache = v,
  losses: (v) => lossesCache = v,
};

// ---- Batches (a "batch" is simply a transplants entry — the moment seedlings move
// into a growing level is when a trackable cohort starts). Remaining quantity and age
// are always computed live from the transplant + whatever harvests/losses reference it
// by batchId, the same "derived, not stored" approach as computeStandingStock() — so
// there's nothing to keep in sync if a harvest or loss is later edited or deleted.
function computeBatchRemaining(batchId){
  const batch = transplantsCache.find(t => t.id === batchId);
  if (!batch) return 0;
  const used = harvestsCache.filter(h => h.batchId === batchId).reduce((s,h) => s + (Number(h.quantity) || 0), 0)
             + lossesCache.filter(l => l.batchId === batchId).reduce((s,l) => s + (Number(l.quantity) || 0), 0);
  return Math.max(0, (Number(batch.quantity) || 0) - used);
}
// Total age since germination started: the age it already was at transfer, plus
// however many days have passed since the transfer date.
function batchAgeDays(batch, asOfKey){
  const base = Number(batch.ageAtTransfer) || 0;
  const elapsed = Math.round((toDate(asOfKey) - toDate(batch.date)) / 86400000);
  return base + Math.max(0, elapsed);
}
// A germination entry is a dated tray too, same as a transplant is — remaining is
// whatever hasn't been drawn out yet by a transplant that named this specific tray
// as its sourceGermId (see openAddTrayModal). Transplants with no sourceGermId (an
// older record, or drawn from a room with no per-tray tracking like Off Site) simply
// don't count against any one tray, same as before this existed.
function computeGermRemaining(germId){
  const g = germinationsCache.find(x => x.id === germId);
  if (!g) return 0;
  const used = transplantsCache.filter(t => t.sourceGermId === germId).reduce((s,t) => s + (Number(t.quantity) || 0), 0);
  return Math.max(0, (Number(g.quantity) || 0) - used);
}
function germAgeDays(germ, asOfKey){
  return Math.max(0, Math.round((toDate(asOfKey) - toDate(germ.date)) / 86400000));
}
function openBatchesFor(plantTypeId, location){
  if (!plantTypeId || !location) return [];
  return transplantsCache
    .filter(t => t.plantTypeId === plantTypeId && t.destLevel === location)
    .map(t => ({ batch: t, remaining: computeBatchRemaining(t.id) }))
    .filter(x => x.remaining > 0)
    .sort((a,b) => (a.batch.date || "").localeCompare(b.batch.date || ""));
}
function batchLabel(t, remaining){
  return "Transferred " + (t.date || "?") + " — " + batchAgeDays(t, farmTodayKey()) + "d old — " + remaining + " left";
}
// Learns a typical "days from germination to first harvest" per plant type by looking
// at every batch that's actually been harvested from and averaging how old each one was
// on its earliest harvest date — used to color the Growing Stock dot grid so it reads as
// "getting close" / "overdue" relative to this crop's own observed history, not a guess.
function computeAvgDaysToHarvest(plantTypeId){
  const durations = [];
  transplantsCache.filter(t => t.plantTypeId === plantTypeId).forEach(b => {
    const harvestDates = harvestsCache.filter(h => h.batchId === b.id && h.date).map(h => h.date).sort();
    if (!harvestDates.length) return;
    durations.push(batchAgeDays(b, harvestDates[0]));
  });
  if (!durations.length) return null;
  return durations.reduce((a,b) => a + b, 0) / durations.length;
}

Object.keys(LOG_CONFIGS).forEach(col => {
  onSnapshot(collection(db, col), (snap) => {
    LOG_SETTERS[col](snap.docs.map(d => ({ id: d.id, photos: [], ...d.data() })));
    renderLogSection(col);
    if (isDashboardActive()) renderDashboard();
    renderStandingStock();
    populateAllBatchSelects();
  }, () => setSyncStatus("err", "Connection error"));
});

// ---- Currently Growing (computed live count, not its own collection) ----
// Standing quantity per location per plant type, derived entirely from the four logs above:
// germinations add to a germination room, transplants move stock from a germination room to a
// growing level, and harvests/losses remove stock from wherever they're logged against.
let standingFilterLoc = "";
function computeStandingStock(){
  const stock = {};
  Object.keys(LOCATIONS).forEach(loc => stock[loc] = {});
  const add = (loc, plantTypeId, delta) => {
    if (!loc || !plantTypeId || !stock[loc]) return;
    stock[loc][plantTypeId] = (stock[loc][plantTypeId] || 0) + delta;
  };
  germinationsCache.forEach(g => add(g.room, g.plantTypeId, g.quantity || 0));
  transplantsCache.forEach(t => {
    add(t.sourceRoom, t.plantTypeId, -(t.quantity || 0));
    add(t.destLevel, t.plantTypeId, t.quantity || 0);
  });
  harvestsCache.forEach(h => add(h.location, h.plantTypeId, -(h.quantity || 0)));
  lossesCache.forEach(l => add(l.location, l.plantTypeId, -(l.quantity || 0)));
  return stock;
}

$("standingLocationRow").addEventListener("click", (e) => {
  const btn = e.target.closest(".dash-loc-btn");
  if (!btn) return;
  standingFilterLoc = btn.dataset.loc;
  $("standingLocationRow").querySelectorAll(".dash-loc-btn").forEach(b => b.classList.toggle("active", b === btn));
  renderStandingStock();
});

function renderStandingStock(){
  const list = $("standingList");
  if (!list) return;
  list.innerHTML = "";

  const stock = computeStandingStock();
  const rows = [];
  Object.keys(LOCATIONS).forEach(loc => {
    if (standingFilterLoc && loc !== standingFilterLoc) return;
    Object.entries(stock[loc]).forEach(([plantTypeId, qty]) => {
      const clamped = Math.max(0, qty);
      if (clamped === 0) return;
      const pt = plantTypesCache.find(p => p.id === plantTypeId);
      rows.push({ loc, plantType: pt ? pt.name : "(deleted plant type)", qty: clamped });
    });
  });
  rows.sort((a,b) => LOCATIONS[a.loc].localeCompare(LOCATIONS[b.loc]) || a.plantType.localeCompare(b.plantType));

  if (rows.length === 0){
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Nothing currently growing yet — log germinations, transfers, harvests, and losses to see live counts here.";
    list.appendChild(empty);
    return;
  }

  rows.forEach(r => {
    const row = document.createElement("div");
    row.className = "standing-row";
    const locEl = document.createElement("span"); locEl.className = "standing-loc"; locEl.textContent = LOCATIONS[r.loc];
    const typeEl = document.createElement("span"); typeEl.className = "standing-type"; typeEl.textContent = r.plantType;
    const qtyEl = document.createElement("span"); qtyEl.className = "standing-qty"; qtyEl.textContent = r.qty;
    row.appendChild(locEl); row.appendChild(typeEl); row.appendChild(qtyEl);
    list.appendChild(row);
  });
}

function locOptLabel(key, opts){
  const found = opts.find(([k]) => k === key);
  return found ? found[1] : (key || "—");
}

function logEditableSelect(label, value, options, onSave){
  const field = document.createElement("div"); field.className = "field";
  const lbl = document.createElement("label"); lbl.textContent = label;
  field.appendChild(lbl);
  const select = document.createElement("select");
  select.disabled = !isAdmin;
  options.forEach(([val, text]) => {
    const opt = document.createElement("option"); opt.value = val; opt.textContent = text;
    select.appendChild(opt);
  });
  select.value = value || "";
  select.addEventListener("click", (e) => e.stopPropagation());
  select.addEventListener("change", async () => {
    try { await onSave(select.value || null); }
    catch (err){ alert("Couldn't save: " + err.message); }
  });
  field.appendChild(select);
  return field;
}

function logEditableNumber(label, value, onSave){
  const field = document.createElement("div"); field.className = "field";
  const lbl = document.createElement("label"); lbl.textContent = label;
  field.appendChild(lbl);
  const input = document.createElement("input");
  input.type = "number"; input.min = "0"; input.disabled = !isAdmin;
  if (value != null) input.value = value;
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("blur", async () => {
    if (input.value === "" || input.value == null) return;
    const num = Number(input.value);
    if (isNaN(num) || num === value) return;
    try { await onSave(num); }
    catch (err){ alert("Couldn't save: " + err.message); }
  });
  field.appendChild(input);
  return field;
}

function logEditableText(label, value, onSave){
  const field = document.createElement("div"); field.className = "field";
  const lbl = document.createElement("label"); lbl.textContent = label;
  field.appendChild(lbl);
  const input = document.createElement("input");
  input.type = "text"; input.disabled = !isAdmin;
  if (value != null) input.value = value;
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("blur", async () => {
    const val = input.value.trim();
    if (val === (value || "")) return;
    try { await onSave(val || null); }
    catch (err){ alert("Couldn't save: " + err.message); input.value = value || ""; }
  });
  field.appendChild(input);
  return field;
}

function renderLogSection(col){
  const cfg = LOG_CONFIGS[col];
  const cache = LOG_CACHES[col]();
  const expanded = LOG_EXPANDED[col];
  const list = $(col + "List");
  if (!list) return;
  list.innerHTML = "";

  const items = cache.slice().sort((a,b) => (b.date||"").localeCompare(a.date||""));
  if (items.length === 0){
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Nothing logged yet.";
    list.appendChild(empty);
    return;
  }

  items.forEach(r => {
    const isOpen = !!expanded[r.id];
    const card = document.createElement("div");
    card.className = "finding-card" + (isOpen ? " expanded" : "");

    const header = document.createElement("div");
    header.className = "finding-header";
    const left = document.createElement("div");
    left.className = "finding-header-left";
    const chevron = document.createElement("span");
    chevron.className = "finding-chevron"; chevron.textContent = "▶";
    const dateEl = document.createElement("span");
    dateEl.className = "finding-date"; dateEl.textContent = r.date || "—";
    left.appendChild(chevron); left.appendChild(dateEl);

    const needsDetails = !r.plantTypeId || r.quantity == null;
    if (needsDetails){
      const tag = document.createElement("span");
      tag.className = "report-badge open"; tag.textContent = "Needs details";
      left.appendChild(tag);
    }

    const locLabel = locOptLabel(r[cfg.locationField.key], cfg.locationField.options);
    const secondLabel = cfg.secondLocationField ? (" → " + locOptLabel(r[cfg.secondLocationField.key], cfg.secondLocationField.options)) : "";
    const destLabel = cfg.destinationField ? (" · for " + (harvestDestinationName(r[cfg.destinationField.key]) || "—")) : "";
    let batchLabelText = "";
    if (cfg.ageAtTransferField){
      const remaining = computeBatchRemaining(r.id);
      const rackLabel = (r.rackSide || r.rackTier != null) ? (" · " + [r.rackSide ? "Side " + r.rackSide : null, r.rackTier != null ? "Tier " + r.rackTier : null].filter(Boolean).join(" ")) : "";
      batchLabelText = rackLabel + " · " + batchAgeDays(r, farmTodayKey()) + "d old · " + remaining + " of " + (r.quantity != null ? r.quantity : "?") + " left";
    } else if (cfg.batchField && r.batchId){
      const srcBatch = transplantsCache.find(t => t.id === r.batchId);
      batchLabelText = srcBatch ? (" · from batch " + (srcBatch.date || "?") + " (" + batchAgeDays(srcBatch, r.date || farmTodayKey()) + "d old)") : "";
    }
    const summaryText = plantTypeName(r.plantTypeId) + " — " + (r.quantity != null ? r.quantity : "?") + " · " + locLabel + secondLabel + destLabel + batchLabelText;
    if (!isOpen){
      const preview = document.createElement("span");
      preview.className = "finding-preview";
      preview.textContent = summaryText;
      left.appendChild(preview);
    }
    header.appendChild(left);

    if (isAdmin){
      const del = document.createElement("button");
      del.className = "icon-btn"; del.textContent = "✕"; del.title = "Delete entry";
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("Delete this entry and its photos?")) return;
        try { await moveToTrash(col, r.id, r); }
        catch (err){ alert("Couldn't delete this entry: " + err.message); }
      });
      header.appendChild(del);
    }
    header.addEventListener("click", () => {
      if (expanded[r.id]) delete expanded[r.id]; else expanded[r.id] = true;
      renderLogSection(col);
    });
    card.appendChild(header);

    const body = document.createElement("div");
    body.className = "finding-body";
    if (isOpen){
      const summary = document.createElement("div");
      summary.className = "finding-text";
      summary.style.fontWeight = "600";
      summary.textContent = summaryText;
      body.appendChild(summary);

      if (isAdmin){
        const row1 = document.createElement("div"); row1.className = "row2"; row1.style.marginTop = "8px";
        const plantTypeOptions = [["", "— Select plant type —"], ...plantTypesCache.map(pt => [pt.id, pt.name])];
        row1.appendChild(logEditableSelect("Plant type", r.plantTypeId, plantTypeOptions, (v) => updateDoc(doc(db, col, r.id), { plantTypeId: v })));
        row1.appendChild(logEditableNumber("Quantity", r.quantity, (v) => updateDoc(doc(db, col, r.id), { quantity: v })));
        body.appendChild(row1);

        const row2 = document.createElement("div"); row2.className = "row2";
        row2.appendChild(logEditableSelect(cfg.secondLocationField ? "From" : "Location", r[cfg.locationField.key], cfg.locationField.options, (v) => updateDoc(doc(db, col, r.id), { [cfg.locationField.key]: v })));
        if (cfg.secondLocationField){
          row2.appendChild(logEditableSelect("To", r[cfg.secondLocationField.key], cfg.secondLocationField.options, (v) => updateDoc(doc(db, col, r.id), { [cfg.secondLocationField.key]: v })));
        } else if (cfg.destinationField){
          const destOptions = [["", "— Select destination —"], ...harvestDestinationsCache.map(d => [d.id, d.name])];
          row2.appendChild(logEditableSelect("Destination", r[cfg.destinationField.key], destOptions, (v) => updateDoc(doc(db, col, r.id), { [cfg.destinationField.key]: v })));
        }
        body.appendChild(row2);

        if (cfg.ageAtTransferField){
          const row3 = document.createElement("div"); row3.className = "row2";
          row3.appendChild(logEditableNumber("Age at transfer (days)", r.ageAtTransfer, (v) => updateDoc(doc(db, col, r.id), { ageAtTransfer: v })));
          body.appendChild(row3);
        }
        if (cfg.rackPositionField){
          const row4 = document.createElement("div"); row4.className = "row2";
          row4.appendChild(logEditableText("Rack side", r.rackSide, (v) => updateDoc(doc(db, col, r.id), { rackSide: v })));
          row4.appendChild(logEditableNumber("Rack tier", r.rackTier, (v) => updateDoc(doc(db, col, r.id), { rackTier: v })));
          body.appendChild(row4);
        }
        if (cfg.batchField){
          const row3 = document.createElement("div"); row3.className = "row2";
          const openBatches = openBatchesFor(r.plantTypeId, r[cfg.locationField.key]);
          const batchOptions = [["", "— No specific batch —"], ...openBatches.map(({ batch, remaining }) => [batch.id, batchLabel(batch, remaining)])];
          if (r.batchId && !openBatches.some(({ batch }) => batch.id === r.batchId)){
            const srcBatch = transplantsCache.find(t => t.id === r.batchId);
            if (srcBatch) batchOptions.push([srcBatch.id, batchLabel(srcBatch, computeBatchRemaining(srcBatch.id)) + " (already used)"]);
          }
          row3.appendChild(logEditableSelect("Batch", r.batchId, batchOptions, (v) => updateDoc(doc(db, col, r.id), { batchId: v })));
          body.appendChild(row3);
        }
      }

      if (isAdmin || r.notes){
        const notes = document.createElement("div");
        notes.className = "finding-text";
        notes.contentEditable = isAdmin ? "true" : "false";
        notes.textContent = r.notes || "";
        if (isAdmin) notes.dataset.placeholder = "Click to add notes…";
        notes.addEventListener("click", (e) => e.stopPropagation());
        notes.addEventListener("blur", async () => {
          if (!isAdmin) return;
          const val = notes.innerText.trim();
          if (val === (r.notes || "")) return;
          try { await updateDoc(doc(db, col, r.id), { notes: val }); }
          catch (err){ alert("Couldn't save notes: " + err.message); notes.textContent = r.notes || ""; }
        });
        body.appendChild(notes);
      }

      const strip = document.createElement("div");
      strip.className = "photo-strip";
      (r.photos || []).forEach(photo => {
        const item = document.createElement("div");
        item.className = "photo-item";
        const wrap = document.createElement("div");
        wrap.className = "photo-thumb-wrap";
        const img = document.createElement("img");
        img.className = "photo-thumb"; img.src = photo.url; img.loading = "lazy";
        img.addEventListener("click", (e) => { e.stopPropagation(); openLightbox(photo.url); });
        wrap.appendChild(img);
        if (isAdmin){
          const rem = document.createElement("button");
          rem.className = "photo-remove"; rem.textContent = "✕"; rem.title = "Delete photo";
          rem.addEventListener("click", async (e) => {
            e.stopPropagation();
            if (!confirm("Delete this photo?")) return;
            const newPhotos = (r.photos || []).filter(p => p.id !== photo.id);
            try { await updateDoc(doc(db, col, r.id), { photos: newPhotos }); }
            catch (err){ alert("Couldn't delete this photo: " + err.message); }
          });
          wrap.appendChild(rem);
        }
        item.appendChild(wrap);
        if (isAdmin){
          const ann = document.createElement("button");
          ann.className = "annotate-btn"; ann.textContent = "✎ Annotate";
          ann.addEventListener("click", (e) => { e.stopPropagation(); openAnnotateModal(col, r.id, photo.id); });
          item.appendChild(ann);
        }
        strip.appendChild(item);
      });
      if (isAdmin){
        const addBtn = document.createElement("div");
        addBtn.className = "add-photo-btn"; addBtn.textContent = "+ Add photo";
        addBtn.addEventListener("click", (e) => { e.stopPropagation(); openPhotoPicker(col, r.id, addBtn); });
        strip.appendChild(addBtn);
      }
      body.appendChild(strip);
    }
    card.appendChild(body);
    list.appendChild(card);
  });
}

function wireLogAddForm(col){
  const cfg = LOG_CONFIGS[col];
  const btn = $("add" + capitalize(col) + "Btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (!isAdmin) return;
    const dateInput = $(col + "Date");
    const plantTypeSelect = $(col + "PlantType");
    const qtyInput = $(col + "Quantity");
    const notesInput = $(col + "Notes");
    const locSelect = $(col + "Location");
    const loc2Select = cfg.secondLocationField ? $(col + "Location2") : null;
    const destSelect = cfg.destinationField ? $(col + "Destination") : null;
    const ageInput = cfg.ageAtTransferField ? $(col + "AgeAtTransfer") : null;
    const batchSelect = cfg.batchField ? $(col + "Batch") : null;
    const rackSideInput = cfg.rackPositionField ? $(col + "RackSide") : null;
    const rackTierInput = cfg.rackPositionField ? $(col + "RackTier") : null;

    const plantTypeId = plantTypeSelect.value;
    if (!plantTypeId){ alert("Add a plant type first, using the ⚙ Manage Plant Types button above."); return; }
    const quantity = Number(qtyInput.value);
    if (!quantity || quantity <= 0){ alert("Enter a quantity greater than 0."); return; }
    const date = dateInput.value || toKey(new Date());

    const payload = { date, plantTypeId, quantity, notes: notesInput.value.trim(), photos: [] };
    payload[cfg.locationField.key] = locSelect.value;
    if (cfg.secondLocationField) payload[cfg.secondLocationField.key] = loc2Select.value;
    if (cfg.destinationField) payload[cfg.destinationField.key] = destSelect.value;
    if (cfg.ageAtTransferField) payload.ageAtTransfer = ageInput.value === "" ? (plantTypeGermDays(plantTypeId) || 0) : Number(ageInput.value);
    if (cfg.batchField) payload.batchId = (batchSelect && batchSelect.value) || null;
    if (cfg.rackPositionField){
      payload.rackSide = rackSideInput.value.trim() || null;
      payload.rackTier = rackTierInput.value === "" ? null : Number(rackTierInput.value);
    }

    btn.disabled = true; btn.textContent = "Adding…";
    try {
      const newDoc = await addDoc(collection(db, col), payload);
      LOG_EXPANDED[col][newDoc.id] = true;
      qtyInput.value = ""; notesInput.value = "";
      if (ageInput) ageInput.value = "";
    } catch (err){
      alert("Couldn't save this entry: " + err.message + "\n\nIf this says \"permission denied\", the " + col + " rule in firestore.rules needs to be published in the Firebase console.");
    } finally {
      btn.disabled = false; btn.textContent = "Add";
    }
  });
}
Object.keys(LOG_CONFIGS).forEach(wireLogAddForm);
["harvests", "transplants", "germinations", "losses"].forEach(col => {
  const el = $(col + "Date");
  const t = toKey(new Date());
  el.value = inRange(t) ? t : START_DATE;
});

// Pre-fills the new-batch starting age from the plant type's configured germination
// days, and the rack side/tier from whichever transplant of this same plant type was
// logged most recently — for a daily-succession setup (a new tray of the same crop in
// the same rack slot every day) this means picking the plant type is usually the only
// thing that needs typing at all.
$("transplantsPlantType").addEventListener("change", () => {
  const plantTypeId = $("transplantsPlantType").value;
  const days = plantTypeGermDays(plantTypeId);
  if (days != null) $("transplantsAgeAtTransfer").value = days;
  const recent = transplantsCache.filter(t => t.plantTypeId === plantTypeId).sort((a,b) => (b.date || "").localeCompare(a.date || ""))[0];
  if (recent){
    $("transplantsRackSide").value = recent.rackSide || "";
    $("transplantsRackTier").value = recent.rackTier != null ? recent.rackTier : "";
  }
});

// The "From batch" dropdowns on Harvest/Losses are optional and always show an open
// batch (a transplants entry with quantity left) matching whatever plant type + level
// is currently selected in that same add-row — repopulated live as either changes, or
// as any relevant log updates change what's still open.
function populateBatchSelect(col){
  const cfg = LOG_CONFIGS[col];
  if (!cfg || !cfg.batchField) return;
  const sel = $(col + "Batch");
  if (!sel) return;
  const plantTypeId = $(col + "PlantType").value;
  const location = $(col + "Location").value;
  const prev = sel.value;
  sel.innerHTML = "";
  const noneOpt = document.createElement("option");
  noneOpt.value = ""; noneOpt.textContent = "— No specific batch —";
  sel.appendChild(noneOpt);
  openBatchesFor(plantTypeId, location).forEach(({ batch, remaining }) => {
    const opt = document.createElement("option");
    opt.value = batch.id; opt.textContent = batchLabel(batch, remaining);
    sel.appendChild(opt);
  });
  if (prev && Array.from(sel.options).some(o => o.value === prev)) sel.value = prev;
}
function populateAllBatchSelects(){
  Object.keys(LOG_CONFIGS).filter(col => LOG_CONFIGS[col].batchField).forEach(populateBatchSelect);
}
["harvests", "losses"].forEach(col => {
  $(col + "PlantType").addEventListener("change", () => populateBatchSelect(col));
  $(col + "Location").addEventListener("change", () => populateBatchSelect(col));
});

// Quick-capture: at harvest time you often want to snap a photo of a full tray/crate
// on the spot and count/log the details later at a desk, rather than typing plant
// type and quantity first. Creates a minimal draft entry (flagged "Needs details"
// wherever plant type or quantity is still missing) and jumps straight into the
// camera/file picker for it.
$("quickHarvestPhotoBtn").addEventListener("click", async () => {
  if (!isAdmin) return;
  const btn = $("quickHarvestPhotoBtn");
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = "Creating…";
  try {
    const newDoc = await addDoc(collection(db, "harvests"), {
      date: toKey(new Date()), plantTypeId: null, quantity: null,
      location: "", destinationId: null, notes: "", photos: []
    });
    expandedHarvests[newDoc.id] = true;
    openPhotoPicker("harvests", newDoc.id, null);
  } catch (err){
    alert("Couldn't start a quick harvest photo entry: " + err.message);
  } finally {
    btn.disabled = false; btn.textContent = original;
  }
});

// ---- Environment Readings (Firestore: envReadings/{id}) ----
let envReadingsCache = [];
let envReadingsFilterLoc = "";
onSnapshot(collection(db, "envReadings"), (snap) => {
  envReadingsCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderEnvReadings();
  if (isDashboardActive()) renderDashboard();
}, () => setSyncStatus("err", "Connection error"));

$("envReadingsFilter").addEventListener("change", (e) => { envReadingsFilterLoc = e.target.value; renderEnvReadings(); });

function renderEnvReadings(){
  const list = $("envReadingsList");
  list.innerHTML = "";
  let items = envReadingsCache.slice().sort((a,b) => (b.date||"").localeCompare(a.date||""));
  if (envReadingsFilterLoc) items = items.filter(r => r.location === envReadingsFilterLoc);

  if (items.length === 0){
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = envReadingsFilterLoc ? "No readings for this location yet." : "No readings logged yet.";
    list.appendChild(empty);
    return;
  }

  const mkCell = (label, val, unit) => {
    const span = document.createElement("span");
    const has = val !== null && val !== undefined && val !== "";
    span.className = "env-cell" + (has ? "" : " empty");
    span.dataset.label = label;
    span.textContent = has ? (val + (unit || "")) : "—";
    return span;
  };

  items.forEach(r => {
    const row = document.createElement("div");
    row.className = "env-row";
    const dateEl = document.createElement("span"); dateEl.className = "env-date"; dateEl.textContent = r.date || "—";
    const locEl = document.createElement("span"); locEl.className = "env-loc"; locEl.textContent = LOCATIONS[r.location] || r.location || "—";
    const tankEl = document.createElement("span"); tankEl.className = "env-tank"; tankEl.textContent = (r.tankId && tankName(r.tankId)) || "—";
    row.appendChild(dateEl);
    row.appendChild(locEl);
    row.appendChild(tankEl);
    row.appendChild(mkCell("pH", r.ph));
    row.appendChild(mkCell("TDS", r.tds));
    row.appendChild(mkCell("EC", r.ec));
    row.appendChild(mkCell("Water °C", r.waterTemp));
    row.appendChild(mkCell("Room °C", r.roomTemp));
    if (isAdmin){
      const del = document.createElement("button");
      del.className = "icon-btn"; del.textContent = "✕"; del.title = "Delete reading";
      del.addEventListener("click", async () => {
        if (!confirm("Delete this reading?")) return;
        try { await moveToTrash("envReadings", r.id, r); }
        catch (err){ alert("Couldn't delete this reading: " + err.message); }
      });
      row.appendChild(del);
    } else {
      row.appendChild(document.createElement("span"));
    }
    list.appendChild(row);
  });
}

$("addEnvReadingsBtn").addEventListener("click", async () => {
  if (!isAdmin) return;
  const btn = $("addEnvReadingsBtn");
  const numOrNull = (id) => { const v = $(id).value; return v === "" ? null : Number(v); };
  const payload = {
    date: $("envReadingsDate").value || toKey(new Date()),
    location: $("envReadingsLocation").value,
    tankId: $("envReadingsTankRow").style.display !== "none" ? ($("envReadingsTank").value || null) : null,
    ph: numOrNull("envReadingsPh"),
    tds: numOrNull("envReadingsTds"),
    ec: numOrNull("envReadingsEc"),
    waterTemp: numOrNull("envReadingsWaterTemp"),
    roomTemp: numOrNull("envReadingsRoomTemp"),
    notes: $("envReadingsNotes").value.trim(),
  };
  btn.disabled = true; btn.textContent = "Adding…";
  try {
    await addDoc(collection(db, "envReadings"), payload);
    ["envReadingsPh","envReadingsTds","envReadingsEc","envReadingsWaterTemp","envReadingsRoomTemp","envReadingsNotes"].forEach(id => { $(id).value = ""; });
  } catch (err){
    alert("Couldn't save this reading: " + err.message + "\n\nIf this says \"permission denied\", the envReadings rule in firestore.rules needs to be published in the Firebase console.");
  } finally {
    btn.disabled = false; btn.textContent = "Add reading";
  }
});
(() => { const t = toKey(new Date()); $("envReadingsDate").value = inRange(t) ? t : START_DATE; })();

// ---- Dashboard ----
function weekKey(dateStr){
  const d = toDate(dateStr);
  const diffToMonday = (d.getDay() + 6) % 7;
  const monday = new Date(d);
  monday.setDate(d.getDate() - diffToMonday);
  return toKey(monday);
}

function computeDeathRateSeries(scopeLoc){
  const weeks = {};
  const bump = (key, field, amount) => { if (!weeks[key]) weeks[key] = { losses: 0, denom: 0 }; weeks[key][field] += amount; };

  lossesCache.forEach(r => {
    if (scopeLoc && r.location !== scopeLoc) return;
    bump(weekKey(r.date), "losses", Number(r.quantity) || 0);
  });

  const isGrowLevel = scopeLoc === "level1" || scopeLoc === "level3";
  const isGermRoom = GERM_ROOMS.includes(scopeLoc);

  if (!scopeLoc || isGermRoom){
    germinationsCache.forEach(r => {
      if (isGermRoom && r.room !== scopeLoc) return;
      bump(weekKey(r.date), "denom", Number(r.quantity) || 0);
    });
  }
  if (!scopeLoc || isGrowLevel){
    transplantsCache.forEach(r => {
      if (isGrowLevel && r.destLevel !== scopeLoc) return;
      bump(weekKey(r.date), "denom", Number(r.quantity) || 0);
    });
  }

  return Object.keys(weeks).sort().map(wk => ({
    week: wk, lossQty: weeks[wk].losses, denom: weeks[wk].denom,
    rate: weeks[wk].denom > 0 ? (weeks[wk].losses / weeks[wk].denom * 100) : null,
  }));
}

function computeEnvSeries(scopeLoc, metricKey){
  let items = envReadingsCache.slice();
  if (scopeLoc) items = items.filter(r => r.location === scopeLoc);
  items = items.filter(r => r[metricKey] !== null && r[metricKey] !== undefined && r.date);
  const byDate = {};
  items.forEach(r => { (byDate[r.date] = byDate[r.date] || []).push(Number(r[metricKey])); });
  return Object.keys(byDate).sort().map(d => ({
    date: d, value: byDate[d].reduce((a,b) => a+b, 0) / byDate[d].length,
  }));
}

const chartInstances = {};
function renderLineChart(canvasId, labels, data, label, color){
  const canvas = $(canvasId);
  if (!canvas || typeof Chart === "undefined") return;
  if (chartInstances[canvasId]) chartInstances[canvasId].destroy();
  chartInstances[canvasId] = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: { labels, datasets: [{ label, data, borderColor: color, backgroundColor: color + "33", tension: 0.25, spanGaps: true }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, title: { display: true, text: label, font: { size: 12 } } },
      scales: { x: { ticks: { maxRotation: 0, autoSkip: true } } },
    },
  });
}

const DASH_PALETTE = ["#0b57d0", "#1e7e34", "#b5540b", "#6a2fb5", "#c0392b", "#0a8f8f", "#8a5c00", "#555555", "#a53e8c", "#3f6b1f"];
function renderDoughnutChart(canvasId, emptyId, labels, data){
  const canvas = $(canvasId);
  const emptyEl = $(emptyId);
  if (!canvas || typeof Chart === "undefined") return;
  if (chartInstances[canvasId]){ chartInstances[canvasId].destroy(); chartInstances[canvasId] = null; }
  if (labels.length === 0){
    canvas.style.display = "none";
    if (emptyEl) emptyEl.style.display = "block";
    return;
  }
  canvas.style.display = "";
  if (emptyEl) emptyEl.style.display = "none";
  chartInstances[canvasId] = new Chart(canvas.getContext("2d"), {
    type: "doughnut",
    data: { labels, datasets: [{ data, backgroundColor: labels.map((_, i) => DASH_PALETTE[i % DASH_PALETTE.length]) }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "right", labels: { boxWidth: 12, font: { size: 11 } } } },
    },
  });
}

// Ratio of harvested quantity by plant type / by destination, for the current location scope —
// answers "what are we growing the most of" and "who are we harvesting for" at a glance.
function computeHarvestByPlantType(scopeLoc){
  const totals = {};
  harvestsCache.forEach(h => {
    if (scopeLoc && h.location !== scopeLoc) return;
    const key = h.plantTypeId || "";
    if (!key) return;
    totals[key] = (totals[key] || 0) + (Number(h.quantity) || 0);
  });
  const labels = [], data = [];
  Object.entries(totals).forEach(([id, qty]) => {
    if (qty <= 0) return;
    labels.push(plantTypeName(id));
    data.push(qty);
  });
  return { labels, data };
}

function computeHarvestByDestination(scopeLoc){
  const totals = {};
  harvestsCache.forEach(h => {
    if (scopeLoc && h.location !== scopeLoc) return;
    const key = h.destinationId || "";
    totals[key] = (totals[key] || 0) + (Number(h.quantity) || 0);
  });
  const labels = [], data = [];
  Object.entries(totals).forEach(([id, qty]) => {
    if (qty <= 0) return;
    labels.push(id ? (harvestDestinationName(id) || "(deleted destination)") : "Not specified");
    data.push(qty);
  });
  return { labels, data };
}

function renderDashboardKPIs(){
  const scopeLoc = dashboardScopeLoc;

  const totalHarvested = harvestsCache
    .filter(h => !scopeLoc || h.location === scopeLoc)
    .reduce((sum, h) => sum + (Number(h.quantity) || 0), 0);

  const stock = computeStandingStock();
  const currentlyGrowing = Object.keys(LOCATIONS)
    .filter(loc => !scopeLoc || loc === scopeLoc)
    .reduce((sum, loc) => sum + Object.values(stock[loc]).reduce((s, q) => s + Math.max(0, q), 0), 0);

  const thisWeek = weekKey(toKey(new Date()));
  const lossesThisWeek = lossesCache
    .filter(l => (!scopeLoc || l.location === scopeLoc) && weekKey(l.date) === thisWeek)
    .reduce((sum, l) => sum + (Number(l.quantity) || 0), 0);

  const deathSeries = computeDeathRateSeries(scopeLoc);
  const latestRate = deathSeries.length ? deathSeries[deathSeries.length - 1].rate : null;

  $("kpiTotalHarvested").textContent = totalHarvested.toLocaleString();
  $("kpiCurrentlyGrowing").textContent = currentlyGrowing.toLocaleString();
  $("kpiLossesThisWeek").textContent = lossesThisWeek.toLocaleString();
  $("kpiDeathRate").textContent = latestRate != null ? latestRate.toFixed(1) + "%" : "—";
}

let dashboardScopeLoc = "";
function isDashboardActive(){
  const el = document.querySelector('#tab-growlog .subtab-panel[data-subtab="dashboard"]');
  return !!el && el.classList.contains("active");
}

$("dashLocationRow").addEventListener("click", (e) => {
  const btn = e.target.closest(".dash-loc-btn");
  if (!btn) return;
  dashboardScopeLoc = btn.dataset.loc;
  $("dashLocationRow").querySelectorAll(".dash-loc-btn").forEach(b => b.classList.toggle("active", b === btn));
  renderDashboard();
});

// Plain numeric rollup of computeStandingStock() — one line per plant type per
// floor (busiest crop first) plus a floor grand total, for a quick "how much of
// each thing do we have" glance without reading through the Growing Stock cards.
function renderPlantTotals(){
  const list = $("plantTotalsList");
  if (!list) return;
  list.innerHTML = "";

  const stock = computeStandingStock();
  const locs = dashboardScopeLoc ? [dashboardScopeLoc] : Object.keys(LOCATIONS);
  let anyRendered = false;

  locs.forEach(loc => {
    const rows = Object.entries(stock[loc] || {})
      .map(([plantTypeId, qty]) => ({ plantTypeId, qty: Math.max(0, qty) }))
      .filter(r => r.qty > 0)
      .sort((a, b) => b.qty - a.qty);
    if (!rows.length) return;
    anyRendered = true;

    const group = document.createElement("div"); group.className = "total-loc-group";
    const title = document.createElement("div"); title.className = "stock-loc-title";
    title.textContent = LOCATIONS[loc];
    group.appendChild(title);

    let locTotal = 0;
    rows.forEach(r => {
      locTotal += r.qty;
      const row = document.createElement("div"); row.className = "total-row";
      const name = document.createElement("span"); name.textContent = plantTypeName(r.plantTypeId);
      const qty = document.createElement("span"); qty.className = "qty"; qty.textContent = r.qty.toLocaleString();
      row.appendChild(name); row.appendChild(qty);
      group.appendChild(row);
    });

    const totalRow = document.createElement("div"); totalRow.className = "total-row total-row-sum";
    const totalLabel = document.createElement("span"); totalLabel.textContent = "Total";
    const totalQty = document.createElement("span"); totalQty.className = "qty"; totalQty.textContent = locTotal.toLocaleString();
    totalRow.appendChild(totalLabel); totalRow.appendChild(totalQty);
    group.appendChild(totalRow);

    list.appendChild(group);
  });

  if (!anyRendered){
    const empty = document.createElement("div"); empty.className = "empty-state";
    empty.textContent = "Nothing currently growing yet.";
    list.appendChild(empty);
  }
}

// One dot per 10 plants, grouped by level then plant type. Level 1/3 group into a
// cluster per open batch (a transplants entry that still has quantity left), shaded by
// how old that batch is relative to this crop's own observed average time-to-first-
// harvest (computeAvgDaysToHarvest) — green while young, amber approaching that average,
// red at/past it. Germination rooms have no batch concept in this model (germination is
// tracked as a pooled quantity, not an aged cohort), so they just get one plain cluster
// per plant type with no age shading.
function renderGrowingStock(){
  const grid = $("growingStockGrid");
  if (!grid) return;
  grid.innerHTML = "";

  const locs = dashboardScopeLoc ? [dashboardScopeLoc] : Object.keys(LOCATIONS);
  let anyRendered = false;

  // Split-card layout for aged batches — a full-height colored panel carries just the
  // day count, since that's the number that says "ready to harvest" and it needs to
  // read at a glance down a whole rack; date and quantity sit in the panel beside it.
  const buildBatchCard = (dotCount, colorClass, ageDays, dateKey, remaining, batchId, kind) => {
    const card = document.createElement("div"); card.className = "stock-batch-card";
    if (isAdmin){
      card.classList.add("editable");
      card.title = "Click to edit date / quantity";
      card.addEventListener("click", () => openTrayEditModal(batchId, kind));
    }
    const ageZone = document.createElement("div"); ageZone.className = "stock-age-zone " + colorClass;
    const num = document.createElement("span"); num.className = "stock-age-num";
    num.textContent = ageDays;
    const unit = document.createElement("span"); unit.className = "stock-age-unit";
    unit.textContent = "DAYS";
    ageZone.appendChild(num); ageZone.appendChild(unit);
    card.appendChild(ageZone);

    const info = document.createElement("div"); info.className = "stock-info-zone";
    const dateTag = document.createElement("div"); dateTag.className = "stock-date-tag";
    dateTag.textContent = fmtFriendlyDate(dateKey);
    info.appendChild(dateTag);
    // Capped so a big carousel batch (e.g. 1000+ plants) doesn't turn the dot grid
    // into a column hundreds of dots tall — past the cap it's just a full-looking
    // pile; the exact count is always the text underneath, never the dots.
    const dots = document.createElement("div"); dots.className = "stock-dots";
    for (let i = 0; i < Math.min(dotCount, 12); i++){
      const dot = document.createElement("span"); dot.className = "stock-dot " + colorClass;
      dots.appendChild(dot);
    }
    info.appendChild(dots);
    const qtyTag = document.createElement("div"); qtyTag.className = "stock-qty-tag";
    qtyTag.textContent = remaining + " left";
    info.appendChild(qtyTag);
    card.appendChild(info);
    return card;
  };

  // A dashed "+" tile at the end of a row of cards — same footprint as the cards next
  // to it (including the 3-per-row phone grid), just a click target instead of data.
  const buildAddCard = (label, onClick) => {
    const card = document.createElement("div"); card.className = "stock-add-card";
    const icon = document.createElement("span"); icon.className = "stock-add-icon"; icon.textContent = "+";
    const text = document.createElement("span"); text.className = "stock-add-label"; text.textContent = label;
    card.appendChild(icon); card.appendChild(text);
    card.addEventListener("click", onClick);
    return card;
  };

  locs.forEach(loc => {
    const isBatchLoc = loc === "level1" || loc === "level3";
    const group = document.createElement("div"); group.className = "stock-loc-group";
    const title = document.createElement("div"); title.className = "stock-loc-title";
    title.textContent = LOCATIONS[loc];
    group.appendChild(title);
    let hasAny = false;

    if (isBatchLoc){
      // Grouped by (rack side, rack tier, plant type) rather than just plant type — a
      // plant type can occupy more than one physical rack row (e.g. the same crop grown
      // on two tiers at once), and each occupies its own dot cluster with its own tier
      // label. Batches with no rack side/tier set just fall back to grouping by plant
      // type alone, sorted alphabetically, same as before this feature existed.
      // A group (one physical rack slot) is kept even once every tray in it has been
      // fully harvested — otherwise the row, and the "Add Tray" action on it, would
      // vanish right when it's needed most: to refill that slot with a new tray.
      const groups = {};
      transplantsCache.filter(t => t.destLevel === loc).forEach(t => {
        const key = (t.rackSide || "") + "|" + (t.rackTier != null ? t.rackTier : "") + "|" + t.plantTypeId;
        if (!groups[key]) groups[key] = { plantTypeId: t.plantTypeId, rackSide: t.rackSide || "", rackTier: t.rackTier != null ? t.rackTier : null, batches: [] };
        const remaining = computeBatchRemaining(t.id);
        if (remaining > 0) groups[key].batches.push({ batch: t, remaining });
      });
      const groupList = Object.values(groups).sort((a,b) => {
        if (a.rackSide !== b.rackSide) return a.rackSide.localeCompare(b.rackSide);
        if (a.rackTier != null && b.rackTier != null && a.rackTier !== b.rackTier) return b.rackTier - a.rackTier;
        if (a.rackTier != null && b.rackTier == null) return -1;
        if (a.rackTier == null && b.rackTier != null) return 1;
        return plantTypeName(a.plantTypeId).localeCompare(plantTypeName(b.plantTypeId));
      });
      let currentSide = null;
      groupList.forEach(g => {
        hasAny = true;
        if (g.rackSide && g.rackSide !== currentSide){
          const sideHeading = document.createElement("div"); sideHeading.className = "stock-side-heading";
          sideHeading.textContent = "Side " + g.rackSide;
          group.appendChild(sideHeading);
        }
        currentSide = g.rackSide || null;
        const batches = g.batches.slice().sort((a,b) => (a.batch.date||"").localeCompare(b.batch.date||""));
        const avg = computeAvgDaysToHarvest(g.plantTypeId);
        const groupTotal = batches.reduce((s, b) => s + b.remaining, 0);
        const row = document.createElement("div"); row.className = "stock-type-row";
        const nameEl = document.createElement("div"); nameEl.className = "stock-type-name";
        nameEl.textContent = (g.rackTier != null ? "Tier " + g.rackTier + " · " : "") + plantTypeName(g.plantTypeId);
        const totalTag = document.createElement("span"); totalTag.className = "stock-type-total";
        totalTag.textContent = groupTotal.toLocaleString() + " total";
        nameEl.appendChild(totalTag);
        if (avg != null){
          const avgTag = document.createElement("span"); avgTag.className = "stock-type-avg";
          avgTag.textContent = "avg " + Math.round(avg) + "d to harvest";
          nameEl.appendChild(avgTag);
        }
        row.appendChild(nameEl);
        const batchesWrap = document.createElement("div"); batchesWrap.className = "stock-batches";
        batches.forEach(({ batch, remaining }) => {
          const age = batchAgeDays(batch, farmTodayKey());
          let colorClass = "neutral";
          if (avg != null) colorClass = age >= avg ? "ready" : (age >= avg * 0.7 ? "close" : "fresh");
          batchesWrap.appendChild(buildBatchCard(Math.ceil(remaining / 10), colorClass, age, batch.date, remaining, batch.id, "transplants"));
        });
        // Each row is a physical rack row with a fixed number of tray slots — Side A
        // (herbs) rows hold 13 daily-succession trays, Side B (lettuce + ice plant)
        // rows hold 11. Once every slot is occupied by an open (remaining > 0) tray
        // there's nowhere to put a new one until one gets fully harvested. Level 1 is
        // capped differently — one carousel of a fixed 142 towers per plant type, so
        // it's a plant-count ceiling rather than a tray-count one (chunks refilled
        // there aren't always the same size).
        let atCapacity = false;
        if (loc === "level1"){
          const perTower = plantTypePlantsPerTower(g.plantTypeId);
          if (perTower){
            atCapacity = groupTotal >= LEVEL1_TOWER_CAP * perTower;
          }
        } else {
          const maxTrays = TRAY_MAX_BY_SIDE[g.rackSide] || null;
          atCapacity = maxTrays != null && batches.length >= maxTrays;
        }
        if (isAdmin && !atCapacity){
          batchesWrap.appendChild(buildAddCard(loc === "level1" ? "Add Tower" : "Add Tray", () => openAddTrayModal(g.plantTypeId, loc, g.rackSide, g.rackTier)));
        }
        row.appendChild(batchesWrap);
        group.appendChild(row);
      });
    } else {
      // Germination rooms are dated trays too, same idea as the growing racks above —
      // each germinations doc is one tray, grouped by plant type only (no rack side/
      // tier here). A plant type stays listed (even with 0 open trays) as long as this
      // room has ever germinated it, so the "Add Seedlings" action that tops it back
      // up doesn't disappear right when it's needed.
      const groups = {};
      germinationsCache.filter(g => g.room === loc).forEach(g => {
        if (!groups[g.plantTypeId]) groups[g.plantTypeId] = { plantTypeId: g.plantTypeId, batches: [] };
        const remaining = computeGermRemaining(g.id);
        if (remaining > 0) groups[g.plantTypeId].batches.push({ germ: g, remaining });
      });
      Object.values(groups)
        .sort((a,b) => plantTypeName(a.plantTypeId).localeCompare(plantTypeName(b.plantTypeId)))
        .forEach(g => {
          hasAny = true;
          const batches = g.batches.slice().sort((a,b) => (a.germ.date||"").localeCompare(b.germ.date||""));
          const germDays = plantTypeGermDays(g.plantTypeId);
          const groupTotal = batches.reduce((s, b) => s + b.remaining, 0);
          const row = document.createElement("div"); row.className = "stock-type-row";
          const nameEl = document.createElement("div"); nameEl.className = "stock-type-name";
          nameEl.textContent = plantTypeName(g.plantTypeId);
          const totalTag = document.createElement("span"); totalTag.className = "stock-type-total";
          totalTag.textContent = groupTotal.toLocaleString() + " total";
          nameEl.appendChild(totalTag);
          row.appendChild(nameEl);
          const batchesWrap = document.createElement("div"); batchesWrap.className = "stock-batches";
          batches.forEach(({ germ, remaining }) => {
            const age = germAgeDays(germ, farmTodayKey());
            let colorClass = "neutral";
            if (germDays != null) colorClass = age >= germDays ? "ready" : (age >= germDays * 0.7 ? "close" : "fresh");
            batchesWrap.appendChild(buildBatchCard(Math.ceil(remaining / 10), colorClass, age, germ.date, remaining, germ.id, "germinations"));
          });
          const maxTrays = GERM_TRAY_MAX[loc] || null;
          if (isAdmin && (maxTrays == null || batches.length < maxTrays)){
            batchesWrap.appendChild(buildAddCard("Add Seedlings", () => openAddGermModal(g.plantTypeId, loc)));
          }
          row.appendChild(batchesWrap);
          group.appendChild(row);
        });
    }

    if (hasAny){ grid.appendChild(group); anyRendered = true; }
  });

  if (!anyRendered){
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Nothing currently growing yet — log germinations, transfers, harvests, and losses to see it here.";
    grid.appendChild(empty);
  }
}

function renderDashboard(){
  renderDashboardKPIs();
  renderPlantTotals();
  renderGrowingStock();

  const byType = computeHarvestByPlantType(dashboardScopeLoc);
  renderDoughnutChart("harvestByTypeChart", "harvestByTypeEmpty", byType.labels, byType.data);

  const byDestination = computeHarvestByDestination(dashboardScopeLoc);
  renderDoughnutChart("harvestByDestinationChart", "harvestByDestinationEmpty", byDestination.labels, byDestination.data);

  const series = computeDeathRateSeries(dashboardScopeLoc);
  renderLineChart("deathRateChart", series.map(s => s.week), series.map(s => s.rate), "Death rate %", "#c0392b");

  const table = $("deathRateTable");
  if (series.length === 0){
    table.innerHTML = '<p class="empty-state">Not enough data yet — log some germination/transplant/loss entries.</p>';
  } else {
    let html = "<table><thead><tr><th>Week of</th><th>Losses</th><th>Germinated + Transplanted</th><th>Rate</th></tr></thead><tbody>";
    series.slice().reverse().forEach(s => {
      html += "<tr><td>" + s.week + "</td><td>" + s.lossQty + "</td><td>" + s.denom + "</td><td>" + (s.rate != null ? s.rate.toFixed(1) + "%" : "—") + "</td></tr>";
    });
    html += "</tbody></table>";
    table.innerHTML = html;
  }

  const envWrap = $("envChartsWrap");
  const hint = $("envTrendsHint");
  if (!dashboardScopeLoc){
    envWrap.style.display = "none";
    hint.textContent = "Pick a specific location above (not \"All\") to see its environment charts.";
  } else {
    envWrap.style.display = "";
    hint.textContent = "Daily average readings for " + LOCATIONS[dashboardScopeLoc] + ".";
    [
      ["ph", "phChart", "pH", "#0b57d0"],
      ["tds", "tdsChart", "TDS (ppm)", "#1e7e34"],
      ["ec", "ecChart", "EC (mS/cm)", "#b5540b"],
      ["waterTemp", "waterTempChart", "Water Temp (°C)", "#6a2fb5"],
      ["roomTemp", "roomTempChart", "Room Temp (°C)", "#c0392b"],
    ].forEach(([key, canvasId, label, color]) => {
      const s = computeEnvSeries(dashboardScopeLoc, key);
      renderLineChart(canvasId, s.map(p => p.date), s.map(p => p.value), label, color);
    });
  }
}

// ---- Grow Log tab re-render on nav click (chart sizing when dashboard sub-tab already active) ----
const growlogTabBtn = document.querySelector('.tab-btn[data-tab="growlog"]');
if (growlogTabBtn) growlogTabBtn.addEventListener("click", () => {
  if (isDashboardActive()) requestAnimationFrame(renderDashboard);
});

// ---- Cloudinary upload ----
// Downscales an image blob before it ever reaches Cloudinary. A phone camera photo is
// often 3000-4000px / several MB; nothing in this app displays a photo larger than a
// full-width mobile screen, so shrinking to a 1600px long edge cuts upload time and
// mobile-data usage substantially with no visible quality loss. Falls back to the
// original blob on any failure (unreadable image, canvas error) so a compression
// hiccup never blocks the upload itself — already-small images (e.g. the ~640px
// annotated-photo canvases) pass through untouched.
function compressImageForUpload(blob, maxDim = 1600, quality = 0.82){
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      if (scale >= 1){ resolve(blob); return; }
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((resized) => resolve(resized || blob), "image/jpeg", quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(blob); };
    img.src = url;
  });
}

async function uploadToCloudinary(blob){
  const compressed = await compressImageForUpload(blob);
  const cfg = window.CLOUDINARY_CONFIG;
  const formData = new FormData();
  formData.append("file", compressed);
  formData.append("upload_preset", cfg.uploadPreset);
  const resp = await fetch(`https://api.cloudinary.com/v1_1/${cfg.cloudName}/image/upload`, { method: "POST", body: formData });
  if (!resp.ok) throw new Error("Cloudinary upload failed (" + resp.status + ")");
  const data = await resp.json();
  return { url: data.secure_url, publicId: data.public_id };
}

// ============================================================================
// INVENTORY — Assets (Firestore: inventoryAssets/{id}) — company equipment,
// same collapsible-card/photo-strip pattern as Findings Log / Plant Guide.
// No reorder concept; assets aren't consumed, just tracked with a quantity
// and condition notes.
// ============================================================================
let assetsCache = [];
const expandedAssets = {};

onSnapshot(collection(db, "inventoryAssets"), (snap) => {
  assetsCache = snap.docs.map(d => ({ id: d.id, photos: [], ...d.data() }));
  renderAssets();
}, () => setSyncStatus("err", "Connection error"));

function renderAssets(){
  const list = $("assetsList");
  list.innerHTML = "";

  const items = assetsCache.slice().sort((a,b) => (a.name || "").localeCompare(b.name || ""));
  if (items.length === 0){
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No assets logged yet.";
    list.appendChild(empty);
    return;
  }

  items.forEach(a => {
    const isOpen = !!expandedAssets[a.id];
    const card = document.createElement("div");
    card.className = "finding-card" + (isOpen ? " expanded" : "");

    const header = document.createElement("div");
    header.className = "finding-header";
    const left = document.createElement("div");
    left.className = "finding-header-left";
    const chevron = document.createElement("span");
    chevron.className = "finding-chevron"; chevron.textContent = "▶";
    const nameEl = document.createElement("span");
    nameEl.className = "finding-date"; nameEl.textContent = a.name || "Untitled asset";
    left.appendChild(chevron); left.appendChild(nameEl);
    const qtyTag = document.createElement("span");
    qtyTag.className = "finding-latest-tag";
    qtyTag.textContent = "Qty " + (a.quantity ?? 0);
    left.appendChild(qtyTag);
    if (!isOpen && a.notes){
      const preview = document.createElement("span");
      preview.className = "finding-preview";
      preview.textContent = a.notes;
      left.appendChild(preview);
    }
    header.appendChild(left);

    if (isAdmin){
      const del = document.createElement("button");
      del.className = "icon-btn"; del.textContent = "✕"; del.title = "Delete asset";
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("Delete this asset and its photos?")) return;
        try { await moveToTrash("inventoryAssets", a.id, a); }
        catch (err){ alert("Couldn't delete this asset: " + err.message); }
      });
      header.appendChild(del);
    }
    header.addEventListener("click", () => {
      if (expandedAssets[a.id]) delete expandedAssets[a.id]; else expandedAssets[a.id] = true;
      renderAssets();
    });
    card.appendChild(header);

    const body = document.createElement("div");
    body.className = "finding-body";
    if (isOpen){
      const nameInput = document.createElement("div");
      nameInput.className = "finding-text";
      nameInput.style.fontWeight = "600";
      nameInput.contentEditable = isAdmin ? "true" : "false";
      nameInput.textContent = a.name || "";
      nameInput.addEventListener("click", (e) => e.stopPropagation());
      nameInput.addEventListener("blur", async () => {
        if (!isAdmin) return;
        const val = nameInput.innerText.trim();
        if (!val || val === a.name) { nameInput.textContent = a.name || ""; return; }
        try { await updateDoc(doc(db, "inventoryAssets", a.id), { name: val }); }
        catch (err){ alert("Couldn't save the name: " + err.message); nameInput.textContent = a.name || ""; }
      });
      body.appendChild(nameInput);

      if (isAdmin){
        const row = document.createElement("div");
        row.className = "row2";
        row.style.marginTop = "8px";
        const qtyField = document.createElement("div"); qtyField.className = "field";
        qtyField.innerHTML = "<label>Quantity</label>";
        const qtyInput = document.createElement("input");
        qtyInput.type = "number"; qtyInput.min = "0"; qtyInput.step = "1"; qtyInput.value = a.quantity ?? 0;
        qtyInput.addEventListener("change", async () => {
          const val = parseInt(qtyInput.value, 10) || 0;
          try { await updateDoc(doc(db, "inventoryAssets", a.id), { quantity: val }); }
          catch (err){ alert("Couldn't save the quantity: " + err.message); }
        });
        qtyField.appendChild(qtyInput);
        row.appendChild(qtyField);
        body.appendChild(row);
      }

      const notes = document.createElement("div");
      notes.className = "finding-text";
      notes.contentEditable = isAdmin ? "true" : "false";
      notes.textContent = a.notes || "";
      notes.addEventListener("click", (e) => e.stopPropagation());
      notes.addEventListener("blur", async () => {
        if (!isAdmin) return;
        const val = notes.innerText.trim();
        if (val === a.notes) return;
        try { await updateDoc(doc(db, "inventoryAssets", a.id), { notes: val }); }
        catch (err){ alert("Couldn't save the notes: " + err.message); notes.textContent = a.notes || ""; }
      });
      body.appendChild(notes);

      const strip = document.createElement("div");
      strip.className = "photo-strip";
      a.photos.forEach(photo => {
        const item = document.createElement("div");
        item.className = "photo-item";
        const wrap = document.createElement("div");
        wrap.className = "photo-thumb-wrap";
        const img = document.createElement("img");
        img.className = "photo-thumb"; img.src = photo.url; img.loading = "lazy";
        img.addEventListener("click", (e) => { e.stopPropagation(); openLightbox(photo.url); });
        wrap.appendChild(img);
        if (isAdmin){
          const rem = document.createElement("button");
          rem.className = "photo-remove"; rem.textContent = "✕"; rem.title = "Delete photo";
          rem.addEventListener("click", async (e) => {
            e.stopPropagation();
            if (!confirm("Delete this photo?")) return;
            const newPhotos = a.photos.filter(p => p.id !== photo.id);
            try { await updateDoc(doc(db, "inventoryAssets", a.id), { photos: newPhotos }); }
            catch (err){ alert("Couldn't delete this photo: " + err.message); }
          });
          wrap.appendChild(rem);
        }
        item.appendChild(wrap);
        if (isAdmin){
          const ann = document.createElement("button");
          ann.className = "annotate-btn"; ann.textContent = "✎ Annotate";
          ann.addEventListener("click", (e) => { e.stopPropagation(); openAnnotateModal("inventoryAssets", a.id, photo.id); });
          item.appendChild(ann);
        }
        strip.appendChild(item);
      });
      if (isAdmin){
        const addBtn = document.createElement("div");
        addBtn.className = "add-photo-btn"; addBtn.textContent = "+ Add photo";
        addBtn.addEventListener("click", (e) => { e.stopPropagation(); openPhotoPicker("inventoryAssets", a.id, addBtn); });
        strip.appendChild(addBtn);
      }
      body.appendChild(strip);
    }
    card.appendChild(body);
    list.appendChild(card);
  });
}

$("addAssetBtn").addEventListener("click", async () => {
  if (!isAdmin) return;
  const nameInput = $("newAssetName");
  const qtyInput = $("newAssetQuantity");
  const notesInput = $("newAssetNotes");
  const name = requireValue(nameInput, "an asset name");
  if (!name) return;
  const quantity = parseInt(qtyInput.value, 10) || 0;
  const notes = notesInput.value.trim();
  const btn = $("addAssetBtn");
  btn.disabled = true; btn.textContent = "Adding…";
  try {
    const newDoc = await addDoc(collection(db, "inventoryAssets"), { name, quantity, notes, photos: [] });
    expandedAssets[newDoc.id] = true;
    nameInput.value = ""; qtyInput.value = "1"; notesInput.value = "";
  } catch (err){
    alert("Couldn't save this asset: " + err.message + "\n\nIf this says \"permission denied\", the inventoryAssets rule in firestore.rules needs to be published in the Firebase console (Firestore Database → Rules).");
  } finally {
    btn.disabled = false; btn.textContent = "Add";
  }
});

// ============================================================================
// INVENTORY — Consumables (Firestore: inventoryConsumables/{id}) — dispensable
// items tracked against a reorder threshold. Updating the quantity inline
// *is* the weekly stock take; each update stamps lastCountedDate.
// ============================================================================
let consumablesCache = [];

onSnapshot(collection(db, "inventoryConsumables"), (snap) => {
  consumablesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderConsumables();
  renderReorderAlertBanner();
}, () => setSyncStatus("err", "Connection error"));

function needsReorder(c){ return (c.quantity ?? 0) <= (c.reorderThreshold ?? 0); }

function renderConsumables(){
  const list = $("consumablesList");
  list.innerHTML = "";

  const items = consumablesCache.slice().sort((a,b) => (a.name || "").localeCompare(b.name || ""));

  const summary = $("consumablesReorderSummary");
  const lowItems = items.filter(needsReorder);
  if (lowItems.length){
    summary.style.display = "block";
    summary.textContent = "⚠ Needs reordering: " + lowItems.map(c => c.name).join(", ");
  } else {
    summary.style.display = "none";
  }

  if (items.length === 0){
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No consumables logged yet.";
    list.appendChild(empty);
    return;
  }

  items.forEach(c => {
    const row = document.createElement("div");
    row.className = "consumable-row";

    const nameCell = document.createElement("div");
    nameCell.className = "consumable-name";
    if (c.notes) nameCell.title = c.notes;
    const nameText = document.createElement("span");
    nameText.contentEditable = isAdmin ? "true" : "false";
    nameText.textContent = c.name || "";
    nameText.addEventListener("blur", async () => {
      if (!isAdmin) return;
      const val = nameText.innerText.trim();
      if (!val || val === c.name) { nameText.textContent = c.name || ""; return; }
      try { await updateDoc(doc(db, "inventoryConsumables", c.id), { name: val }); }
      catch (err){ alert("Couldn't save the name: " + err.message); nameText.textContent = c.name || ""; }
    });
    nameCell.appendChild(nameText);
    if (needsReorder(c)){
      const badge = document.createElement("span");
      badge.className = "inv-badge reorder"; badge.textContent = "Reorder";
      nameCell.appendChild(badge);
    }
    row.appendChild(nameCell);

    const qtyCell = document.createElement("div");
    qtyCell.className = "consumable-qty";
    const qtyInput = document.createElement("input");
    qtyInput.type = "number"; qtyInput.min = "0"; qtyInput.step = "1"; qtyInput.value = c.quantity ?? 0;
    qtyInput.disabled = !isAdmin;
    qtyInput.addEventListener("change", async () => {
      const val = parseInt(qtyInput.value, 10) || 0;
      try { await updateDoc(doc(db, "inventoryConsumables", c.id), { quantity: val, lastCountedDate: toKey(new Date()) }); }
      catch (err){ alert("Couldn't save the quantity: " + err.message); }
    });
    qtyCell.appendChild(qtyInput);
    const unitEl = document.createElement("span");
    unitEl.className = "consumable-unit"; unitEl.textContent = c.unit || "";
    qtyCell.appendChild(unitEl);
    row.appendChild(qtyCell);

    const lastCell = document.createElement("div");
    lastCell.className = "consumable-last";
    lastCell.textContent = c.lastCountedDate ? "Counted " + c.lastCountedDate : "Not yet counted";
    row.appendChild(lastCell);

    const delCell = document.createElement("div");
    if (isAdmin){
      const del = document.createElement("button");
      del.className = "icon-btn"; del.textContent = "✕"; del.title = "Delete item";
      del.addEventListener("click", async () => {
        if (!confirm("Delete this consumable item?")) return;
        try { await moveToTrash("inventoryConsumables", c.id, c); }
        catch (err){ alert("Couldn't delete this item: " + err.message); }
      });
      delCell.appendChild(del);
    }
    row.appendChild(delCell);

    list.appendChild(row);
  });
}

$("addConsumableBtn").addEventListener("click", async () => {
  if (!isAdmin) return;
  const nameInput = $("newConsumableName");
  const unitInput = $("newConsumableUnit");
  const qtyInput = $("newConsumableQuantity");
  const thresholdInput = $("newConsumableThreshold");
  const notesInput = $("newConsumableNotes");
  const name = requireValue(nameInput, "an item name");
  if (!name) return;
  const unit = unitInput.value.trim();
  const quantity = parseInt(qtyInput.value, 10) || 0;
  const reorderThreshold = parseInt(thresholdInput.value, 10) || 0;
  const notes = notesInput.value.trim();
  const btn = $("addConsumableBtn");
  btn.disabled = true; btn.textContent = "Adding…";
  try {
    await addDoc(collection(db, "inventoryConsumables"), { name, unit, quantity, reorderThreshold, notes, lastCountedDate: toKey(new Date()) });
    nameInput.value = ""; unitInput.value = ""; qtyInput.value = ""; thresholdInput.value = ""; notesInput.value = "";
  } catch (err){
    alert("Couldn't save this item: " + err.message + "\n\nIf this says \"permission denied\", the inventoryConsumables rule in firestore.rules needs to be published in the Firebase console (Firestore Database → Rules).");
  } finally {
    btn.disabled = false; btn.textContent = "Add";
  }
});

// ============================================================================
// INVENTORY — Purchase Areas (Firestore: purchaseAreas/{id}) — where a planned
// purchase is for (Level 1, Level 3, Office, etc). Managed the same way as
// Plant Types / Harvest Destinations.
// ============================================================================
let purchaseAreasCache = [];

onSnapshot(collection(db, "purchaseAreas"), (snap) => {
  purchaseAreasCache = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => (a.name||"").localeCompare(b.name||""));
  renderPurchaseAreas();
  populatePurchaseAreaSelects();
  renderPurchasePlans();
  if (isPurchaseDashboardActive()) renderPurchaseDashboard();
}, () => setSyncStatus("err", "Connection error"));

function purchaseAreaName(id){
  const area = purchaseAreasCache.find(a => a.id === id);
  return area ? area.name : null;
}

function renderPurchaseAreas(){
  const list = $("purchaseAreasList");
  if (!list) return;
  list.innerHTML = "";
  if (purchaseAreasCache.length === 0){
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No areas added yet.";
    list.appendChild(empty);
    return;
  }
  purchaseAreasCache.forEach(area => {
    const row = document.createElement("div");
    row.className = "staff-row";

    const name = document.createElement("div");
    name.className = "staff-name";
    name.contentEditable = "true";
    name.textContent = area.name;
    name.addEventListener("blur", async () => {
      const val = name.textContent.trim();
      if (!val){ name.textContent = area.name; return; }
      if (val === area.name) return;
      try { await updateDoc(doc(db, "purchaseAreas", area.id), { name: val }); }
      catch (err){ alert("Couldn't rename this area: " + err.message); name.textContent = area.name; }
    });
    name.addEventListener("keydown", (e) => { if (e.key === "Enter"){ e.preventDefault(); name.blur(); } });

    const del = document.createElement("button");
    del.className = "icon-btn"; del.textContent = "✕"; del.title = "Remove area";
    del.addEventListener("click", async () => {
      if (!confirm("Remove \"" + area.name + "\" from areas? Past purchase entries keep their recorded area.")) return;
      try { await moveToTrash("purchaseAreas", area.id, area); }
      catch (err){ alert("Couldn't delete this area: " + err.message); }
    });

    row.appendChild(name); row.appendChild(del);
    list.appendChild(row);
  });
}

$("togglePurchaseAreasBtn").addEventListener("click", () => {
  const panel = $("purchaseAreasPanel");
  panel.style.display = panel.style.display === "none" ? "block" : "none";
});

$("addPurchaseAreaBtn").addEventListener("click", async () => {
  if (!isAdmin) return;
  const input = $("newPurchaseAreaName");
  const name = requireValue(input, "an area name");
  if (!name) return;
  try {
    await addDoc(collection(db, "purchaseAreas"), { name });
    input.value = "";
  } catch (err){
    alert("Couldn't add this area: " + err.message);
  }
});

function populatePurchaseAreaSelects(){
  ["newAssetPurchaseArea", "newConsumablePurchaseArea"].forEach(id => {
    const sel = $(id);
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = "";
    if (purchaseAreasCache.length === 0){
      const opt = document.createElement("option");
      opt.value = ""; opt.textContent = "Add an area first (⚙ above)";
      sel.appendChild(opt);
      return;
    }
    purchaseAreasCache.forEach(area => {
      const opt = document.createElement("option");
      opt.value = area.id; opt.textContent = area.name;
      sel.appendChild(opt);
    });
    if (prev && purchaseAreasCache.some(a => a.id === prev)) sel.value = prev;
  });
}

// ============================================================================
// INVENTORY — Purchase Planning (Firestore: purchasePlans/{id}) — items you're
// planning to buy, labeled "asset" or "consumable" depending on which tab's
// add form was used, and shown in that same tab's "Planning to Buy" section.
// Price and purchaseDate are stored on the same document as everything else
// (this app's Firestore rules are open-read, same as staff PINs — see the
// note at the top of firestore.rules) but are only ever rendered in the UI
// when isAdmin is true, so casual visitors browsing the site don't see them.
// ============================================================================
let purchasePlansCache = [];
const expandedPurchasePlans = {};

onSnapshot(collection(db, "purchasePlans"), (snap) => {
  purchasePlansCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderPurchasePlans();
  if (isPurchaseDashboardActive()) renderPurchaseDashboard();
  renderReorderAlertBanner();
}, () => setSyncStatus("err", "Connection error"));

function renderPurchasePlans(){
  renderPurchaseList("asset", "assetPurchaseList");
  renderPurchaseList("consumable", "consumablePurchaseList");
}

function renderPurchaseList(label, listId){
  const list = $(listId);
  if (!list) return;
  list.innerHTML = "";

  const items = purchasePlansCache
    .filter(p => p.label === label)
    .sort((a,b) => (a.purchased === b.purchased) ? (a.item || "").localeCompare(b.item || "") : (a.purchased ? 1 : -1));
  if (items.length === 0){
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No items planned yet.";
    list.appendChild(empty);
    return;
  }

  items.forEach(p => list.appendChild(buildPurchaseCard(p)));
}

function buildPurchaseCard(p){
  const isOpen = !!expandedPurchasePlans[p.id];
  const card = document.createElement("div");
  card.className = "finding-card" + (isOpen ? " expanded" : "");

  const header = document.createElement("div");
  header.className = "finding-header";
  const left = document.createElement("div");
  left.className = "finding-header-left";

  const checkWrap = document.createElement("label");
  checkWrap.className = "purchase-purchased-check";
  const check = document.createElement("input");
  check.type = "checkbox"; check.checked = !!p.purchased;
  check.disabled = !isAdmin;
  check.addEventListener("click", (e) => e.stopPropagation());
  check.addEventListener("change", async () => {
    const fields = { purchased: check.checked };
    if (check.checked && !p.purchaseDate) fields.purchaseDate = toKey(new Date());
    try { await updateDoc(doc(db, "purchasePlans", p.id), fields); }
    catch (err){ alert("Couldn't update this item: " + err.message); check.checked = !check.checked; }
  });
  checkWrap.appendChild(check);
  left.appendChild(checkWrap);

  const chevron = document.createElement("span");
  chevron.className = "finding-chevron"; chevron.textContent = "▶";
  left.appendChild(chevron);

  const nameEl = document.createElement("span");
  nameEl.className = "finding-date purchase-item-name" + (p.purchased ? " purchased" : "");
  nameEl.textContent = p.item || "Untitled item";
  left.appendChild(nameEl);

  const qtyTag = document.createElement("span");
  qtyTag.className = "finding-latest-tag";
  qtyTag.textContent = "Qty " + (p.quantity ?? 1);
  left.appendChild(qtyTag);

  if (p.areaId){
    const areaTag = document.createElement("span");
    areaTag.className = "finding-latest-tag";
    areaTag.style.background = "#eef4fe"; areaTag.style.color = "#0b57d0";
    areaTag.textContent = purchaseAreaName(p.areaId) || "(deleted area)";
    left.appendChild(areaTag);
  }

  if (isAdmin && p.price != null && p.price !== ""){
    const priceTag = document.createElement("span");
    priceTag.className = "purchase-price-tag";
    priceTag.textContent = "$" + Number(p.price).toFixed(2);
    left.appendChild(priceTag);
  }

  if (!isOpen && p.notes){
    const preview = document.createElement("span");
    preview.className = "finding-preview";
    preview.textContent = p.notes;
    left.appendChild(preview);
  }
  header.appendChild(left);

  if (isAdmin){
    const del = document.createElement("button");
    del.className = "icon-btn"; del.textContent = "✕"; del.title = "Delete item";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Delete \"" + (p.item || "this item") + "\" from the purchase plan?")) return;
      try { await moveToTrash("purchasePlans", p.id, p); }
      catch (err){ alert("Couldn't delete this item: " + err.message); }
    });
    header.appendChild(del);
  }
  header.addEventListener("click", () => {
    if (expandedPurchasePlans[p.id]) delete expandedPurchasePlans[p.id]; else expandedPurchasePlans[p.id] = true;
    renderPurchasePlans();
  });
  card.appendChild(header);

  const body = document.createElement("div");
  body.className = "finding-body";
  if (isOpen){
    const nameInput = document.createElement("div");
    nameInput.className = "finding-text";
    nameInput.style.fontWeight = "600";
    nameInput.contentEditable = isAdmin ? "true" : "false";
    nameInput.textContent = p.item || "";
    nameInput.addEventListener("click", (e) => e.stopPropagation());
    nameInput.addEventListener("blur", async () => {
      if (!isAdmin) return;
      const val = nameInput.innerText.trim();
      if (!val || val === p.item) { nameInput.textContent = p.item || ""; return; }
      try { await updateDoc(doc(db, "purchasePlans", p.id), { item: val }); }
      catch (err){ alert("Couldn't save the item name: " + err.message); nameInput.textContent = p.item || ""; }
    });
    body.appendChild(nameInput);

    const row1 = document.createElement("div");
    row1.className = "row2";
    row1.style.marginTop = "8px";
    const areaField = document.createElement("div"); areaField.className = "field";
    areaField.innerHTML = "<label>Area</label>";
    const areaSelect = document.createElement("select");
    areaSelect.disabled = !isAdmin;
    purchaseAreasCache.forEach(area => {
      const opt = document.createElement("option");
      opt.value = area.id; opt.textContent = area.name;
      areaSelect.appendChild(opt);
    });
    if (p.areaId) areaSelect.value = p.areaId;
    areaSelect.addEventListener("change", async () => {
      try { await updateDoc(doc(db, "purchasePlans", p.id), { areaId: areaSelect.value }); }
      catch (err){ alert("Couldn't save the area: " + err.message); }
    });
    areaField.appendChild(areaSelect);

    const qtyField = document.createElement("div"); qtyField.className = "field";
    qtyField.innerHTML = "<label>Quantity</label>";
    const qtyInput = document.createElement("input");
    qtyInput.type = "number"; qtyInput.min = "0"; qtyInput.step = "1"; qtyInput.value = p.quantity ?? 1;
    qtyInput.disabled = !isAdmin;
    qtyInput.addEventListener("change", async () => {
      const val = parseInt(qtyInput.value, 10) || 0;
      try { await updateDoc(doc(db, "purchasePlans", p.id), { quantity: val }); }
      catch (err){ alert("Couldn't save the quantity: " + err.message); }
    });
    qtyField.appendChild(qtyInput);

    row1.appendChild(areaField); row1.appendChild(qtyField);
    if (isAdmin) body.appendChild(row1);

    if (isAdmin){
      const row2 = document.createElement("div");
      row2.className = "row2";
      const priceField = document.createElement("div"); priceField.className = "field";
      priceField.innerHTML = "<label>Price</label>";
      const priceInput = document.createElement("input");
      priceInput.type = "number"; priceInput.min = "0"; priceInput.step = "0.01"; priceInput.value = p.price ?? "";
      priceInput.addEventListener("change", async () => {
        const val = priceInput.value === "" ? null : Number(priceInput.value);
        try { await updateDoc(doc(db, "purchasePlans", p.id), { price: val }); }
        catch (err){ alert("Couldn't save the price: " + err.message); }
      });
      priceField.appendChild(priceInput);

      const dateField = document.createElement("div"); dateField.className = "field";
      dateField.innerHTML = "<label>Purchase date</label>";
      const dateInput = document.createElement("input");
      dateInput.type = "date"; dateInput.value = p.purchaseDate || "";
      dateInput.addEventListener("change", async () => {
        try { await updateDoc(doc(db, "purchasePlans", p.id), { purchaseDate: dateInput.value }); }
        catch (err){ alert("Couldn't save the purchase date: " + err.message); }
      });
      dateField.appendChild(dateInput);

      row2.appendChild(priceField); row2.appendChild(dateField);
      body.appendChild(row2);
    }

    const notes = document.createElement("div");
    notes.className = "finding-text";
    notes.contentEditable = isAdmin ? "true" : "false";
    notes.textContent = p.notes || "";
    notes.addEventListener("click", (e) => e.stopPropagation());
    notes.addEventListener("blur", async () => {
      if (!isAdmin) return;
      const val = notes.innerText.trim();
      if (val === p.notes) return;
      try { await updateDoc(doc(db, "purchasePlans", p.id), { notes: val }); }
      catch (err){ alert("Couldn't save the notes: " + err.message); notes.textContent = p.notes || ""; }
    });
    body.appendChild(notes);
  }
  card.appendChild(body);
  return card;
}

function wirePurchaseAddForm(label, prefix){
  const btn = $("add" + prefix + "PurchaseBtn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (!isAdmin) return;
    const itemInput = $("new" + prefix + "PurchaseItem");
    const areaSelect = $("new" + prefix + "PurchaseArea");
    const qtyInput = $("new" + prefix + "PurchaseQuantity");
    const priceInput = $("new" + prefix + "PurchasePrice");
    const notesInput = $("new" + prefix + "PurchaseNotes");
    const item = requireValue(itemInput, "an item name");
    if (!item) return;
    const areaId = areaSelect.value || null;
    const quantity = parseInt(qtyInput.value, 10) || 1;
    const price = priceInput.value === "" ? null : Number(priceInput.value);
    const notes = notesInput.value.trim();
    btn.disabled = true; btn.textContent = "Adding…";
    try {
      await addDoc(collection(db, "purchasePlans"), { item, label, areaId, quantity, price, notes, purchased: false, purchaseDate: null });
      itemInput.value = ""; qtyInput.value = "1"; priceInput.value = ""; notesInput.value = "";
    } catch (err){
      alert("Couldn't save this item: " + err.message + "\n\nIf this says \"permission denied\", the purchasePlans rule in firestore.rules needs to be published in the Firebase console (Firestore Database → Rules).");
    } finally {
      btn.disabled = false; btn.textContent = "Add";
    }
  });
}
wirePurchaseAddForm("asset", "Asset");
wirePurchaseAddForm("consumable", "Consumable");

// ---- Purchases Dashboard (admin-only sub-tab) ----
function isPurchaseDashboardActive(){
  const el = document.querySelector('#tab-inventory .subtab-panel[data-subtab="purchaseDashboard"]');
  return !!el && el.classList.contains("active");
}

function computeSpendByArea(){
  const totals = {};
  purchasePlansCache.forEach(p => {
    if (!p.purchased) return;
    const key = p.areaId || "";
    totals[key] = (totals[key] || 0) + (Number(p.price) || 0) * (Number(p.quantity) || 1);
  });
  const labels = [], data = [];
  Object.entries(totals).forEach(([id, amt]) => {
    if (amt <= 0) return;
    labels.push(id ? (purchaseAreaName(id) || "(deleted area)") : "No area set");
    data.push(Number(amt.toFixed(2)));
  });
  return { labels, data };
}

function computeSpendByLabel(){
  const totals = { asset: 0, consumable: 0 };
  purchasePlansCache.forEach(p => {
    if (!p.purchased) return;
    totals[p.label] = (totals[p.label] || 0) + (Number(p.price) || 0) * (Number(p.quantity) || 1);
  });
  const labels = [], data = [];
  if (totals.asset > 0){ labels.push("Assets"); data.push(Number(totals.asset.toFixed(2))); }
  if (totals.consumable > 0){ labels.push("Consumables"); data.push(Number(totals.consumable.toFixed(2))); }
  return { labels, data };
}

// For each consumable item name bought 2+ times, average the days between purchases and
// project that forward from the last purchase date — a lightweight reorder prediction that
// doesn't require any extra data entry beyond marking items purchased with a date.
function computeReorderPredictions(){
  const groups = {};
  purchasePlansCache.forEach(p => {
    if (p.label !== "consumable" || !p.purchased || !p.purchaseDate) return;
    const key = (p.item || "").trim();
    if (!key) return;
    (groups[key] = groups[key] || []).push(p.purchaseDate);
  });
  const predictions = [];
  Object.entries(groups).forEach(([item, dates]) => {
    const sorted = dates.slice().sort();
    const last = sorted[sorted.length - 1];
    if (sorted.length < 2){
      predictions.push({ item, last, avgDays: null, nextDate: null });
      return;
    }
    let totalGap = 0;
    for (let i = 1; i < sorted.length; i++) totalGap += (toDate(sorted[i]) - toDate(sorted[i-1])) / 86400000;
    const avgDays = Math.round(totalGap / (sorted.length - 1));
    const nextD = toDate(last);
    nextD.setDate(nextD.getDate() + avgDays);
    predictions.push({ item, last, avgDays, nextDate: toKey(nextD) });
  });
  predictions.sort((a,b) => (a.nextDate || "9999-99-99").localeCompare(b.nextDate || "9999-99-99"));
  return predictions;
}

// A global, admin-only banner (visible on any tab, not just Inventory) combining the
// two existing "you should reorder something" signals: consumables at/below their
// stock threshold, and consumables whose purchase-history prediction says they're due
// within a week — matching the weekly stock-take cadence the rest of Inventory assumes.
function renderReorderAlertBanner(){
  const banner = $("reorderAlertBanner");
  if (!banner) return;
  if (!isAdmin){ banner.style.display = "none"; return; }

  const lowStock = consumablesCache.filter(needsReorder);
  const soonCutoffDate = new Date();
  soonCutoffDate.setDate(soonCutoffDate.getDate() + 7);
  const soonCutoff = toKey(soonCutoffDate);
  const duePredictions = computeReorderPredictions().filter(p => p.nextDate && p.nextDate <= soonCutoff);

  if (lowStock.length === 0 && duePredictions.length === 0){ banner.style.display = "none"; return; }

  const parts = [];
  if (lowStock.length) parts.push(lowStock.length + " low on stock (" + lowStock.map(c => c.name).join(", ") + ")");
  if (duePredictions.length) parts.push(duePredictions.length + " due to reorder soon (" + duePredictions.map(p => p.item).join(", ") + ")");
  banner.textContent = "⚠ " + parts.join(" · ") + " — tap to view";
  banner.style.display = "block";
  banner.onclick = () => {
    activateTab("inventory");
    const subtabKey = lowStock.length > 0 ? "consumables" : "purchaseDashboard";
    const btn = document.querySelector('#tab-inventory .subtab-btn[data-subtab="' + subtabKey + '"]');
    if (btn) btn.click();
  };
}

function renderReorderPredictions(){
  const list = $("reorderPredictionList");
  if (!list) return;
  list.innerHTML = "";
  const predictions = computeReorderPredictions();
  if (predictions.length === 0){
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Not enough purchase history yet — mark consumable items as purchased (with a date) to start predicting reorder timing.";
    list.appendChild(empty);
    return;
  }
  predictions.forEach(pr => {
    const row = document.createElement("div");
    row.className = "reorder-row";
    const nameEl = document.createElement("span"); nameEl.className = "reorder-item"; nameEl.textContent = pr.item;
    row.appendChild(nameEl);
    const lastEl = document.createElement("span"); lastEl.className = "reorder-detail"; lastEl.textContent = "Last bought " + pr.last;
    row.appendChild(lastEl);
    if (pr.avgDays != null){
      const intervalEl = document.createElement("span"); intervalEl.className = "reorder-detail"; intervalEl.textContent = "Avg every " + pr.avgDays + " days";
      row.appendChild(intervalEl);
      const nextEl = document.createElement("span"); nextEl.className = "reorder-next"; nextEl.textContent = "Predicted next: " + pr.nextDate;
      row.appendChild(nextEl);
    } else {
      const noteEl = document.createElement("span"); noteEl.className = "reorder-detail"; noteEl.textContent = "Bought once so far — buy again to start predicting.";
      row.appendChild(noteEl);
    }
    list.appendChild(row);
  });
}

function renderPurchaseDashboardKPIs(){
  const purchased = purchasePlansCache.filter(p => p.purchased);
  const pending = purchasePlansCache.filter(p => !p.purchased);
  const amount = p => (Number(p.price) || 0) * (Number(p.quantity) || 1);
  const totalSpent = purchased.reduce((s,p) => s + amount(p), 0);
  const thisMonthPrefix = toKey(new Date()).slice(0, 7);
  const spentThisMonth = purchased.filter(p => (p.purchaseDate || "").startsWith(thisMonthPrefix)).reduce((s,p) => s + amount(p), 0);
  const pendingCost = pending.reduce((s,p) => s + amount(p), 0);

  $("kpiTotalSpent").textContent = "$" + totalSpent.toFixed(2);
  $("kpiSpentThisMonth").textContent = "$" + spentThisMonth.toFixed(2);
  $("kpiPendingCount").textContent = pending.length;
  $("kpiPendingCost").textContent = "$" + pendingCost.toFixed(2);
}

function renderPurchaseDashboard(){
  renderPurchaseDashboardKPIs();
  const byArea = computeSpendByArea();
  renderDoughnutChart("spendByAreaChart", "spendByAreaEmpty", byArea.labels, byArea.data);
  const byLabel = computeSpendByLabel();
  renderDoughnutChart("spendByLabelChart", "spendByLabelEmpty", byLabel.labels, byLabel.data);
  renderReorderPredictions();
}

const inventoryTabBtn = document.querySelector('.tab-btn[data-tab="inventory"]');
if (inventoryTabBtn) inventoryTabBtn.addEventListener("click", () => {
  if (isPurchaseDashboardActive()) requestAnimationFrame(renderPurchaseDashboard);
});

// ============================================================================
// REPORTS TAB — formal reports for the client. First kind: Weekly Farm
// Inspection & Maintenance Report. Firestore: reports/{id} is the report
// header (date, who contacted/attended/fixed, notes, status); reportTasks/{id}
// is one issue within a report, kept as its own document (not a nested array)
// so the shared photo/annotate pipeline above can be reused for its two
// independent photo arrays — issuePhotos (the client-spotted problem, usually
// annotated) and fixPhotos (the follow-up rectification photo).
// ============================================================================
let reportsCache = [];
let reportTasksCache = [];
const expandedReports = {};
const expandedReportTasks = {};

onSnapshot(collection(db, "reports"), (snap) => {
  reportsCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderReports();
}, () => setSyncStatus("err", "Connection error"));

onSnapshot(collection(db, "reportTasks"), (snap) => {
  reportTasksCache = snap.docs.map(d => ({ id: d.id, issuePhotos: [], fixPhotos: [], ...d.data() }));
  renderReports();
}, () => setSyncStatus("err", "Connection error"));

function tasksForReport(reportId){
  return reportTasksCache.filter(t => t.reportId === reportId).sort((a,b) => (a.seq||0) - (b.seq||0));
}

function renderReports(){
  const list = $("reportsList");
  if (!list) return;
  list.innerHTML = "";

  const items = reportsCache.slice().sort((a,b) => (b.date||"").localeCompare(a.date||""));
  if (items.length === 0){
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No reports yet.";
    list.appendChild(empty);
    return;
  }
  items.forEach(r => list.appendChild(buildReportCard(r)));
}

function buildReportCard(r){
  const isOpen = !!expandedReports[r.id];
  const card = document.createElement("div");
  card.className = "finding-card" + (isOpen ? " expanded" : "");

  const header = document.createElement("div");
  header.className = "finding-header";
  const left = document.createElement("div");
  left.className = "finding-header-left";
  const chevron = document.createElement("span");
  chevron.className = "finding-chevron"; chevron.textContent = "▶";
  const dateEl = document.createElement("span");
  dateEl.className = "finding-date"; dateEl.textContent = r.date || "—";
  left.appendChild(chevron); left.appendChild(dateEl);

  const badge = document.createElement("span");
  badge.className = "report-badge " + (r.status === "closed" ? "closed" : "open");
  badge.textContent = r.status === "closed" ? "Closed" : "Open";
  left.appendChild(badge);

  if (!isOpen){
    const preview = document.createElement("span");
    preview.className = "finding-preview";
    const bits = [];
    if (r.contactedBy) bits.push("Contacted: " + r.contactedBy);
    if (r.attendedBy) bits.push("Attended: " + r.attendedBy);
    preview.textContent = bits.join(" · ");
    left.appendChild(preview);
  }
  header.appendChild(left);

  if (isAdmin){
    const del = document.createElement("button");
    del.className = "icon-btn"; del.textContent = "✕"; del.title = "Delete report";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Delete this report and all of its issues?")) return;
      try {
        await Promise.all(tasksForReport(r.id).map(t => moveToTrash("reportTasks", t.id, t)));
        await moveToTrash("reports", r.id, r);
      } catch (err){ alert("Couldn't delete this report: " + err.message); }
    });
    header.appendChild(del);
  }
  header.addEventListener("click", () => {
    if (expandedReports[r.id]) delete expandedReports[r.id]; else expandedReports[r.id] = true;
    renderReports();
  });
  card.appendChild(header);

  const body = document.createElement("div");
  body.className = "finding-body";
  if (isOpen) body.appendChild(buildReportBody(r));
  card.appendChild(body);
  return card;
}

function reportEditableField(label, value, onSave, type){
  const field = document.createElement("div");
  field.className = "field";
  const lbl = document.createElement("label"); lbl.textContent = label;
  field.appendChild(lbl);
  const input = document.createElement("input");
  input.type = type || "text";
  input.value = value || "";
  input.disabled = !isAdmin;
  const commit = async () => {
    if (input.value === (value || "")) return;
    try { await onSave(input.value.trim()); }
    catch (err){ alert("Couldn't save: " + err.message); input.value = value || ""; }
  };
  input.addEventListener("blur", commit);
  input.addEventListener("change", () => { if (type === "date") commit(); });
  field.appendChild(input);
  return field;
}

function buildReportBody(r){
  const wrap = document.createElement("div");

  const row1 = document.createElement("div"); row1.className = "row2";
  row1.appendChild(reportEditableField("Date", r.date, (v) => updateDoc(doc(db,"reports", r.id), { date: v }), "date"));
  row1.appendChild(reportEditableField("Contacted by", r.contactedBy, (v) => updateDoc(doc(db,"reports", r.id), { contactedBy: v })));
  wrap.appendChild(row1);

  const row2 = document.createElement("div"); row2.className = "row2";
  row2.appendChild(reportEditableField("Attended by", r.attendedBy, (v) => updateDoc(doc(db,"reports", r.id), { attendedBy: v })));
  row2.appendChild(reportEditableField("Fixed by", r.fixedBy, (v) => updateDoc(doc(db,"reports", r.id), { fixedBy: v })));
  wrap.appendChild(row2);

  const notes = document.createElement("div");
  notes.className = "finding-text";
  notes.contentEditable = isAdmin ? "true" : "false";
  notes.textContent = r.notes || "";
  if (isAdmin) notes.dataset.placeholder = "Click to add overall notes…";
  notes.addEventListener("click", (e) => e.stopPropagation());
  notes.addEventListener("blur", async () => {
    if (!isAdmin) return;
    const val = notes.innerText.trim();
    if (val === (r.notes || "")) return;
    try { await updateDoc(doc(db, "reports", r.id), { notes: val }); }
    catch (err){ alert("Couldn't save notes: " + err.message); notes.textContent = r.notes || ""; }
  });
  wrap.appendChild(notes);

  const statusRow = document.createElement("div");
  statusRow.style.margin = "12px 0";
  const statusBadge = document.createElement("span");
  statusBadge.className = "report-badge " + (r.status === "closed" ? "closed" : "open") + (isAdmin ? " clickable" : "");
  statusBadge.textContent = r.status === "closed" ? "Closed — click to reopen" : "Open — click to mark closed";
  if (isAdmin) statusBadge.addEventListener("click", async () => {
    try { await updateDoc(doc(db, "reports", r.id), { status: r.status === "closed" ? "open" : "closed" }); }
    catch (err){ alert("Couldn't update status: " + err.message); }
  });
  statusRow.appendChild(statusBadge);
  const statusHint = document.createElement("p");
  statusHint.className = "hint"; statusHint.style.margin = "6px 0 0";
  statusHint.textContent = "Mark closed once the client confirms the fix. If the client never comes back with feedback, this report stands as deemed closed either way — no signature required.";
  statusRow.appendChild(statusHint);
  wrap.appendChild(statusRow);

  const tasksWrap = document.createElement("div");
  tasksWrap.style.marginTop = "14px";
  const tasksHeading = document.createElement("h2"); tasksHeading.textContent = "Issues";
  tasksWrap.appendChild(tasksHeading);
  const tasks = tasksForReport(r.id);
  if (tasks.length === 0){
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No issues logged yet.";
    tasksWrap.appendChild(empty);
  } else {
    tasks.forEach((t, i) => tasksWrap.appendChild(buildTaskCard(t, i + 1)));
  }

  if (isAdmin){
    const addTaskRow = document.createElement("div");
    addTaskRow.className = "add-row"; addTaskRow.style.marginTop = "10px";
    const input = document.createElement("input");
    input.type = "text"; input.placeholder = "Describe the issue the client spotted…";
    const btn = document.createElement("button"); btn.textContent = "+ Add Issue";
    btn.addEventListener("click", async () => {
      const val = requireValue(input, "an issue description");
      if (!val) return;
      try {
        const newDoc = await addDoc(collection(db, "reportTasks"), {
          reportId: r.id, seq: Date.now(), issueDescription: val,
          comments: "", issuePhotos: [], rectificationNotes: "", fixPhotos: []
        });
        expandedReportTasks[newDoc.id] = true;
        input.value = "";
      } catch (err){ alert("Couldn't add this issue: " + err.message); }
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") btn.click(); });
    addTaskRow.appendChild(input); addTaskRow.appendChild(btn);
    tasksWrap.appendChild(addTaskRow);
  }
  wrap.appendChild(tasksWrap);

  if (isAdmin){
    const pdfRow = document.createElement("div");
    pdfRow.style.marginTop = "14px";
    const pdfBtn = document.createElement("button");
    pdfBtn.textContent = "⬇ Download PDF";
    pdfBtn.addEventListener("click", async () => {
      const original = pdfBtn.textContent;
      pdfBtn.disabled = true; pdfBtn.textContent = "Preparing PDF…";
      const area = $("pdfPrintArea");
      area.innerHTML = buildReportPdfHtml(r);
      await waitForImages(area, 8000);
      document.body.classList.add("printing-pdf");
      window.print();
      pdfBtn.disabled = false; pdfBtn.textContent = original;
    });
    pdfRow.appendChild(pdfBtn);
    wrap.appendChild(pdfRow);
  }

  return wrap;
}

function buildTaskPhotoStrip(t, field, addLabel){
  const strip = document.createElement("div");
  strip.className = "photo-strip";
  (t[field] || []).forEach(photo => {
    const item = document.createElement("div");
    item.className = "photo-item";
    const wrap = document.createElement("div");
    wrap.className = "photo-thumb-wrap";
    const img = document.createElement("img");
    img.className = "photo-thumb"; img.src = photo.url; img.loading = "lazy";
    img.addEventListener("click", (e) => { e.stopPropagation(); openLightbox(photo.url); });
    wrap.appendChild(img);
    if (isAdmin){
      const rem = document.createElement("button");
      rem.className = "photo-remove"; rem.textContent = "✕"; rem.title = "Delete photo";
      rem.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("Delete this photo?")) return;
        const newPhotos = (t[field] || []).filter(p => p.id !== photo.id);
        try { await updateDoc(doc(db, "reportTasks", t.id), { [field]: newPhotos }); }
        catch (err){ alert("Couldn't delete this photo: " + err.message); }
      });
      wrap.appendChild(rem);
    }
    item.appendChild(wrap);
    if (isAdmin){
      const ann = document.createElement("button");
      ann.className = "annotate-btn"; ann.textContent = "✎ Annotate";
      ann.addEventListener("click", (e) => { e.stopPropagation(); openAnnotateModal("reportTasks", t.id, photo.id, field); });
      item.appendChild(ann);
    }
    strip.appendChild(item);
  });
  if (isAdmin){
    const addBtn = document.createElement("div");
    addBtn.className = "add-photo-btn"; addBtn.textContent = "+ " + addLabel;
    addBtn.addEventListener("click", (e) => { e.stopPropagation(); openPhotoPicker("reportTasks", t.id, addBtn, field); });
    strip.appendChild(addBtn);
  }
  return strip;
}

function buildTaskCard(t, index){
  const isOpen = !!expandedReportTasks[t.id];
  const card = document.createElement("div");
  card.className = "finding-card" + (isOpen ? " expanded" : "");

  const header = document.createElement("div");
  header.className = "finding-header";
  const left = document.createElement("div");
  left.className = "finding-header-left";
  const chevron = document.createElement("span");
  chevron.className = "finding-chevron"; chevron.textContent = "▶";
  const idxTag = document.createElement("span");
  idxTag.className = "finding-latest-tag"; idxTag.textContent = "Issue " + index;
  left.appendChild(chevron); left.appendChild(idxTag);
  if (!isOpen){
    const preview = document.createElement("span");
    preview.className = "finding-preview";
    preview.textContent = t.issueDescription || "(no description)";
    left.appendChild(preview);
  }
  header.appendChild(left);

  if (isAdmin){
    const del = document.createElement("button");
    del.className = "icon-btn"; del.textContent = "✕"; del.title = "Delete issue";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Delete this issue?")) return;
      try { await moveToTrash("reportTasks", t.id, t); }
      catch (err){ alert("Couldn't delete this issue: " + err.message); }
    });
    header.appendChild(del);
  }
  header.addEventListener("click", () => {
    if (expandedReportTasks[t.id]) delete expandedReportTasks[t.id]; else expandedReportTasks[t.id] = true;
    renderReports();
  });
  card.appendChild(header);

  const body = document.createElement("div");
  body.className = "finding-body";
  if (isOpen){
    const descLabel = document.createElement("div"); descLabel.className = "hint"; descLabel.style.margin = "8px 0 2px"; descLabel.textContent = "Issue";
    body.appendChild(descLabel);
    const desc = document.createElement("div");
    desc.className = "finding-text"; desc.style.fontWeight = "600";
    desc.contentEditable = isAdmin ? "true" : "false";
    desc.textContent = t.issueDescription || "";
    if (isAdmin) desc.dataset.placeholder = "Describe the issue…";
    desc.addEventListener("click", (e) => e.stopPropagation());
    desc.addEventListener("blur", async () => {
      if (!isAdmin) return;
      const val = desc.innerText.trim();
      if (val === (t.issueDescription || "")) return;
      try { await updateDoc(doc(db, "reportTasks", t.id), { issueDescription: val }); }
      catch (err){ alert("Couldn't save: " + err.message); desc.textContent = t.issueDescription || ""; }
    });
    body.appendChild(desc);

    const commentsLabel = document.createElement("div"); commentsLabel.className = "hint"; commentsLabel.style.margin = "8px 0 2px"; commentsLabel.textContent = "Comments";
    body.appendChild(commentsLabel);
    const comments = document.createElement("div");
    comments.className = "finding-text";
    comments.contentEditable = isAdmin ? "true" : "false";
    comments.textContent = t.comments || "";
    if (isAdmin) comments.dataset.placeholder = "Click to add comments…";
    comments.addEventListener("click", (e) => e.stopPropagation());
    comments.addEventListener("blur", async () => {
      if (!isAdmin) return;
      const val = comments.innerText.trim();
      if (val === (t.comments || "")) return;
      try { await updateDoc(doc(db, "reportTasks", t.id), { comments: val }); }
      catch (err){ alert("Couldn't save: " + err.message); comments.textContent = t.comments || ""; }
    });
    body.appendChild(comments);

    body.appendChild(buildTaskPhotoStrip(t, "issuePhotos", "Issue photo"));

    const rectLabel = document.createElement("div"); rectLabel.className = "hint"; rectLabel.style.margin = "14px 0 2px"; rectLabel.textContent = "Rectification done";
    body.appendChild(rectLabel);
    const rect = document.createElement("div");
    rect.className = "finding-text";
    rect.contentEditable = isAdmin ? "true" : "false";
    rect.textContent = t.rectificationNotes || "";
    if (isAdmin) rect.dataset.placeholder = "Click to describe the fix…";
    rect.addEventListener("click", (e) => e.stopPropagation());
    rect.addEventListener("blur", async () => {
      if (!isAdmin) return;
      const val = rect.innerText.trim();
      if (val === (t.rectificationNotes || "")) return;
      try { await updateDoc(doc(db, "reportTasks", t.id), { rectificationNotes: val }); }
      catch (err){ alert("Couldn't save: " + err.message); rect.textContent = t.rectificationNotes || ""; }
    });
    body.appendChild(rect);

    body.appendChild(buildTaskPhotoStrip(t, "fixPhotos", "Fix photo"));
  }
  card.appendChild(body);
  return card;
}

function buildReportPdfHtml(report){
  const tasks = tasksForReport(report.id);
  const generated = new Date().toLocaleString("default", { dateStyle: "medium", timeStyle: "short" });
  let html = '<div class="pdf-doc pdf-report"><h1>Weekly Farm Inspection &amp; Maintenance Report</h1>';
  html += '<p class="pdf-meta">Indoor Farm — Takeover Tracker · Generated ' + escapeHtml(generated) + '</p>';
  html += '<div class="pdf-report-meta">';
  html += '<div><strong>Date:</strong> ' + escapeHtml(report.date || "—") + '</div>';
  html += '<div><strong>Contacted by:</strong> ' + escapeHtml(report.contactedBy || "—") + '</div>';
  html += '<div><strong>Attended by:</strong> ' + escapeHtml(report.attendedBy || "—") + '</div>';
  html += '<div><strong>Fixed by:</strong> ' + escapeHtml(report.fixedBy || "—") + '</div>';
  html += '<div><strong>Status:</strong> ' + (report.status === "closed" ? "Closed" : "Open") + '</div>';
  html += '</div>';
  if (report.notes) html += '<p class="pdf-report-notes">' + escapeHtml(report.notes).replace(/\n/g, "<br>") + '</p>';

  if (tasks.length === 0){
    html += '<p>No issues logged for this report.</p>';
  } else {
    tasks.forEach((t, i) => {
      html += '<div class="pdf-issue"><h2>Issue ' + (i + 1) + '</h2>';
      html += '<p class="pdf-issue-desc">' + escapeHtml(t.issueDescription || "(no description)").replace(/\n/g, "<br>") + '</p>';
      if (t.comments) html += '<p><strong>Comments:</strong> ' + escapeHtml(t.comments).replace(/\n/g, "<br>") + '</p>';
      if ((t.issuePhotos || []).length){
        html += '<div class="pdf-report-photo-grid">';
        t.issuePhotos.forEach(p => { html += '<img class="pdf-report-photo" src="' + escapeHtml(cloudinaryThumb(p.url, 1000)) + '">'; });
        html += '</div>';
      }
      html += '<div class="pdf-rect"><h3>Rectification</h3>';
      html += '<p>' + escapeHtml(t.rectificationNotes || "Pending.").replace(/\n/g, "<br>") + '</p>';
      if ((t.fixPhotos || []).length){
        html += '<div class="pdf-report-photo-grid">';
        t.fixPhotos.forEach(p => { html += '<img class="pdf-report-photo" src="' + escapeHtml(cloudinaryThumb(p.url, 1000)) + '">'; });
        html += '</div>';
      }
      html += '</div></div>';
    });
  }

  html += '<div class="pdf-report-footer">';
  html += '<p>This report is system-generated. No signature is required.</p>';
  html += '<p>If the client does not come back with feedback, this report is deemed closed — no signature required either way.</p>';
  html += '</div></div>';
  return html;
}

$("addReportBtn").addEventListener("click", async () => {
  if (!isAdmin) return;
  const dateInput = $("newReportDate");
  const contactedInput = $("newReportContactedBy");
  const attendedInput = $("newReportAttendedBy");
  const fixedInput = $("newReportFixedBy");
  const notesInput = $("newReportNotes");
  const date = dateInput.value || toKey(new Date());
  const btn = $("addReportBtn");
  btn.disabled = true; btn.textContent = "Adding…";
  try {
    const newDoc = await addDoc(collection(db, "reports"), {
      type: "weeklyInspection", date,
      contactedBy: contactedInput.value.trim(),
      attendedBy: attendedInput.value.trim(),
      fixedBy: fixedInput.value.trim(),
      notes: notesInput.value.trim(),
      status: "open"
    });
    expandedReports[newDoc.id] = true;
    contactedInput.value = ""; attendedInput.value = ""; fixedInput.value = ""; notesInput.value = "";
  } catch (err){
    alert("Couldn't create this report: " + err.message + "\n\nIf this says \"permission denied\", the reports rule in firestore.rules needs to be published in the Firebase console.");
  } finally {
    btn.disabled = false; btn.textContent = "Add Report";
  }
});
(() => { const t = toKey(new Date()); $("newReportDate").value = inRange(t) ? t : START_DATE; })();

// Photo/annotate pipeline is shared by every collection that stores records
// as { id, photos: [...] } — Findings Log, Plant Guide, Special Events,
// Inventory Assets, and the four Grow Log sections. Registry keeps adding a
// new gallery to a one-line lookup instead of growing an ever-longer ternary
// chain.
const GALLERY_REGISTRY = {
  findings: { cache: () => findingsCache, expanded: () => expandedFindings },
  plantGuide: { cache: () => plantGuideCache, expanded: () => expandedPlants },
  specialEvents: { cache: () => specialEventsCache, expanded: () => expandedSpecialEvents },
  proposals: { cache: () => proposalsCache, expanded: () => expandedProposals },
  inventoryAssets: { cache: () => assetsCache, expanded: () => expandedAssets },
  harvests: { cache: () => harvestsCache, expanded: () => expandedHarvests },
  transplants: { cache: () => transplantsCache, expanded: () => expandedTransplants },
  germinations: { cache: () => germinationsCache, expanded: () => expandedGerminations },
  losses: { cache: () => lossesCache, expanded: () => expandedLosses },
  reportTasks: { cache: () => reportTasksCache, expanded: () => expandedReportTasks },
  claims: { cache: () => claimsCache, expanded: () => expandedClaims },
};
function galleryCache(col){ return GALLERY_REGISTRY[col].cache(); }
function galleryExpanded(col){ return GALLERY_REGISTRY[col].expanded(); }

let photoTargetCollection = "findings";
let photoTargetFindingId = null;
let photoTargetBtn = null;
let photoTargetField = "photos";
const photoFileInput = $("photoFileInput");
// field defaults to "photos" (every existing caller keeps working unchanged) — Report
// tasks are the first record with two independent photo arrays on one document
// (issuePhotos, fixPhotos), so a specific field name can be passed instead.
function openPhotoPicker(col, recordId, btnEl, field){
  photoTargetCollection = col; photoTargetFindingId = recordId; photoTargetBtn = btnEl || null;
  photoTargetField = field || "photos";
  photoFileInput.value = ""; photoFileInput.click();
}

photoFileInput.addEventListener("change", async () => {
  const files = Array.from(photoFileInput.files || []);
  if (!files.length || !photoTargetFindingId) return;
  const col = photoTargetCollection;
  const recordId = photoTargetFindingId;
  const btn = photoTargetBtn;
  const field = photoTargetField;
  const record = galleryCache(col).find(r => r.id === recordId);
  if (!record) return;

  galleryExpanded(col)[recordId] = true;
  if (btn){ btn.textContent = files.length > 1 ? "Uploading 1/" + files.length + "…" : "Uploading…"; btn.style.pointerEvents = "none"; btn.style.opacity = "0.6"; }
  try {
    const uploaded = [];
    for (let i = 0; i < files.length; i++){
      try {
        const { url, publicId } = await uploadToCloudinary(files[i]);
        uploaded.push({ id: uid(), url, publicId });
        if (btn && i + 1 < files.length) btn.textContent = "Uploading " + (i + 2) + "/" + files.length + "…";
      } catch (err){
        alert("Photo upload failed: " + err.message + "\n\nCheck your Cloudinary cloud name / upload preset in firebase-config.js (see SETUP.md).");
      }
    }
    if (uploaded.length === 0) return;
    if (btn) btn.textContent = "Saving…";
    const newPhotos = [...(record[field] || []), ...uploaded];
    try {
      await updateDoc(doc(db, col, recordId), { [field]: newPhotos });
    } catch (err){
      alert("Photo uploaded, but saving it to the entry failed: " + err.message + "\n\nIf this says \"permission denied\", the Firestore rules for this collection need to be published in the Firebase console.");
      return;
    }

    if (uploaded.length === 1 && (col === "findings" || (col === "reportTasks" && field === "issuePhotos"))){
      // jump straight into annotate mode for a single upload, same as before
      // (skipped for Plant Guide and fix/rectification photos — those don't need the auto-jump)
      setTimeout(() => openAnnotateModal(col, recordId, uploaded[0].id, field), 300);
    }
  } finally {
    if (btn){ btn.textContent = "+ Add photo"; btn.style.pointerEvents = ""; btn.style.opacity = ""; }
  }
});

// ---- lightbox ----
const lightbox = $("lightbox");
function openLightbox(src){ $("lightboxImg").src = src; lightbox.classList.add("active"); }
$("lightboxClose").addEventListener("click", () => lightbox.classList.remove("active"));
lightbox.addEventListener("click", (e) => { if (e.target === lightbox) lightbox.classList.remove("active"); });

// ---- annotate ----
const annotateOverlay = $("annotateOverlay");
const baseCanvas = $("baseCanvas"), drawCanvas = $("drawCanvas");
const baseCtx = baseCanvas.getContext("2d"), drawCtx = drawCanvas.getContext("2d");
let annotateCollection = "findings", annotateFindingId = null, annotatePhotoId = null, annotateField = "photos";
let currentColor = "#e02020";
let drawing = false, lastX = 0, lastY = 0;
let annotateMode = "draw"; // "draw" | "text"
let annotateHistory = [], annotateRedoStack = [];

document.querySelectorAll(".color-dot").forEach(dot => {
  dot.addEventListener("click", () => {
    document.querySelectorAll(".color-dot").forEach(d => d.classList.remove("selected"));
    dot.classList.add("selected");
    currentColor = dot.dataset.color;
  });
});

function setAnnotateMode(mode){
  annotateMode = mode;
  $("annotateToolDraw").classList.toggle("primary", mode === "draw");
  $("annotateToolText").classList.toggle("primary", mode === "text");
  finishTextInput();
}
$("annotateToolDraw").addEventListener("click", () => setAnnotateMode("draw"));
$("annotateToolText").addEventListener("click", () => setAnnotateMode("text"));

function updateUndoRedoButtons(){
  $("annotateUndo").disabled = annotateHistory.length <= 1;
  $("annotateRedo").disabled = annotateRedoStack.length === 0;
}
function pushAnnotateHistory(){
  annotateHistory.push(drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height));
  if (annotateHistory.length > 50) annotateHistory.shift();
  annotateRedoStack = [];
  updateUndoRedoButtons();
}
$("annotateUndo").addEventListener("click", () => {
  if (annotateHistory.length <= 1) return;
  annotateRedoStack.push(annotateHistory.pop());
  drawCtx.putImageData(annotateHistory[annotateHistory.length - 1], 0, 0);
  updateUndoRedoButtons();
});
$("annotateRedo").addEventListener("click", () => {
  if (annotateRedoStack.length === 0) return;
  const state = annotateRedoStack.pop();
  annotateHistory.push(state);
  drawCtx.putImageData(state, 0, 0);
  updateUndoRedoButtons();
});

function openAnnotateModal(col, recordId, photoId, field){
  if (!isAdmin) return;
  annotateCollection = col; annotateFindingId = recordId; annotatePhotoId = photoId;
  annotateField = field || "photos";
  const record = galleryCache(col).find(r => r.id === recordId);
  const photo = record[annotateField].find(p => p.id === photoId);
  $("annotateStatus").textContent = "";
  setAnnotateMode("draw");

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    const maxW = Math.min(window.innerWidth * 0.8, 640);
    const scale = Math.min(1, maxW / img.width);
    const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
    baseCanvas.width = w; baseCanvas.height = h;
    drawCanvas.width = w; drawCanvas.height = h;
    baseCanvas.style.width = w + "px"; baseCanvas.style.height = h + "px";
    drawCanvas.style.width = w + "px"; drawCanvas.style.height = h + "px";
    $("canvasWrap").style.width = w + "px"; $("canvasWrap").style.height = h + "px";
    baseCtx.clearRect(0,0,w,h);
    baseCtx.drawImage(img, 0, 0, w, h);
    drawCtx.clearRect(0,0,w,h);
    annotateHistory = [drawCtx.getImageData(0, 0, w, h)];
    annotateRedoStack = [];
    updateUndoRedoButtons();
    annotateOverlay.classList.add("active");
  };
  img.onerror = () => { alert("Couldn't load the photo for annotating (Cloudinary CORS or network issue)."); };
  img.src = photo.url;
}

function canvasPos(e){
  const rect = drawCanvas.getBoundingClientRect();
  const scaleX = drawCanvas.width / rect.width, scaleY = drawCanvas.height / rect.height;
  return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
}

// ---- text tool: click on the canvas to drop a floating input, styled in the
// currently-selected color, positioned in CSS pixels (not canvas-internal
// resolution, which can differ once the photo is scaled to fit the modal).
const annotateTextInput = $("annotateTextInput");
function cancelTextInput(){
  annotateTextInput.style.display = "none";
  annotateTextInput.value = "";
}
// Hiding the input (or moving focus elsewhere) fires a native blur, which also
// calls commitTextInput below — the display check guards against re-entering
// this function from that nested blur once we've already committed once.
function commitTextInput(canvasX, canvasY){
  if (annotateTextInput.style.display === "none") return;
  const text = annotateTextInput.value.trim();
  cancelTextInput();
  if (!text) return;
  drawCtx.font = "22px sans-serif";
  drawCtx.textBaseline = "top";
  drawCtx.fillStyle = currentColor;
  drawCtx.fillText(text, canvasX, canvasY);
  pushAnnotateHistory();
}
function finishTextInput(){
  if (annotateTextInput.style.display !== "none" && annotateTextInput.value.trim()){
    commitTextInput(annotateTextInput._canvasX, annotateTextInput._canvasY);
  } else {
    cancelTextInput();
  }
}
drawCanvas.addEventListener("pointerdown", (e) => {
  if (annotateMode === "text"){
    // Without this, the mousedown that follows this pointerdown steals focus back
    // (to the canvas or nowhere) right after we call .focus() below, which blurs
    // the input before the user can type anything.
    e.preventDefault();
    if (annotateTextInput.style.display !== "none") commitTextInput(annotateTextInput._canvasX, annotateTextInput._canvasY);
    const wrapRect = $("canvasWrap").getBoundingClientRect();
    const p = canvasPos(e);
    annotateTextInput._canvasX = p.x; annotateTextInput._canvasY = p.y;
    annotateTextInput.style.left = (e.clientX - wrapRect.left) + "px";
    annotateTextInput.style.top = (e.clientY - wrapRect.top) + "px";
    annotateTextInput.style.color = currentColor;
    annotateTextInput.style.display = "block";
    annotateTextInput.value = "";
    setTimeout(() => annotateTextInput.focus(), 0);
    return;
  }
  drawing = true;
  const p = canvasPos(e); lastX = p.x; lastY = p.y;
  drawCtx.beginPath(); drawCtx.arc(p.x, p.y, 1.6, 0, Math.PI*2); drawCtx.fillStyle = currentColor; drawCtx.fill();
});
drawCanvas.addEventListener("pointermove", (e) => {
  if (!drawing || annotateMode === "text") return;
  const p = canvasPos(e);
  drawCtx.strokeStyle = currentColor; drawCtx.lineWidth = 3; drawCtx.lineCap = "round"; drawCtx.lineJoin = "round";
  drawCtx.beginPath(); drawCtx.moveTo(lastX, lastY); drawCtx.lineTo(p.x, p.y); drawCtx.stroke();
  lastX = p.x; lastY = p.y;
});
window.addEventListener("pointerup", () => {
  if (drawing) pushAnnotateHistory();
  drawing = false;
});
annotateTextInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter"){ e.preventDefault(); commitTextInput(annotateTextInput._canvasX, annotateTextInput._canvasY); }
  else if (e.key === "Escape"){ e.preventDefault(); cancelTextInput(); }
});
annotateTextInput.addEventListener("blur", () => commitTextInput(annotateTextInput._canvasX, annotateTextInput._canvasY));
$("annotateClear").addEventListener("click", () => {
  drawCtx.clearRect(0,0,drawCanvas.width, drawCanvas.height);
  pushAnnotateHistory();
});
$("annotateCancel").addEventListener("click", () => { cancelTextInput(); annotateOverlay.classList.remove("active"); });

$("annotateSave").addEventListener("click", async () => {
  finishTextInput();
  $("annotateStatus").textContent = "Uploading annotated photo…";
  const merged = document.createElement("canvas");
  merged.width = baseCanvas.width; merged.height = baseCanvas.height;
  const mctx = merged.getContext("2d");
  mctx.drawImage(baseCanvas, 0, 0);
  mctx.drawImage(drawCanvas, 0, 0);

  merged.toBlob(async (blob) => {
    try {
      const { url, publicId } = await uploadToCloudinary(blob);
      const record = galleryCache(annotateCollection).find(r => r.id === annotateFindingId);
      const newPhotos = record[annotateField].map(p => p.id === annotatePhotoId ? { ...p, url, publicId } : p);
      await updateDoc(doc(db, annotateCollection, annotateFindingId), { [annotateField]: newPhotos });
      annotateOverlay.classList.remove("active");
    } catch (err){
      $("annotateStatus").textContent = "Upload failed: " + err.message;
    }
  }, "image/jpeg", 0.85);
});

// ============================================================================
// DATA TAB — export / import (admin only)
// ============================================================================
$("exportDataBtn").addEventListener("click", async () => {
  $("dataStatus").textContent = "Gathering data…";
  try {
    const [scheduleSnap, seriesSnap, houseRulesSnap, findingsSnap, proposalsSnap, plantGuideSnap, specialEventsSnap, plantTypesSnap, harvestDestinationsSnap, harvestsSnap, transplantsSnap, germinationsSnap, lossesSnap, envReadingsSnap, tanksSnap, staffSnap, attendanceSnap, inventoryAssetsSnap, inventoryConsumablesSnap, purchaseAreasSnap, purchasePlansSnap, reportsSnap, reportTasksSnap, claimsSnap] = await Promise.all([
      getDocs(collection(db, "schedule")),
      getDocs(collection(db, "series")),
      getDoc(doc(db, "meta", "houseRules")),
      getDocs(collection(db, "findings")),
      getDocs(collection(db, "proposals")),
      getDocs(collection(db, "plantGuide")),
      getDocs(collection(db, "specialEvents")),
      getDocs(collection(db, "plantTypes")),
      getDocs(collection(db, "harvestDestinations")),
      getDocs(collection(db, "harvests")),
      getDocs(collection(db, "transplants")),
      getDocs(collection(db, "germinations")),
      getDocs(collection(db, "losses")),
      getDocs(collection(db, "envReadings")),
      getDocs(collection(db, "tanks")),
      getDocs(collection(db, "staff")),
      getDocs(collection(db, "attendance")),
      getDocs(collection(db, "inventoryAssets")),
      getDocs(collection(db, "inventoryConsumables")),
      getDocs(collection(db, "purchaseAreas")),
      getDocs(collection(db, "purchasePlans")),
      getDocs(collection(db, "reports")),
      getDocs(collection(db, "reportTasks")),
      getDocs(collection(db, "claims"))
    ]);
    const dump = {
      exportedAt: new Date().toISOString(),
      schedule: Object.fromEntries(scheduleSnap.docs.map(d => [d.id, d.data()])),
      series: Object.fromEntries(seriesSnap.docs.map(d => [d.id, d.data()])),
      houseRules: houseRulesSnap.exists() ? houseRulesSnap.data() : { rules: DEFAULT_RULES },
      findings: Object.fromEntries(findingsSnap.docs.map(d => [d.id, d.data()])),
      proposals: Object.fromEntries(proposalsSnap.docs.map(d => [d.id, d.data()])),
      plantGuide: Object.fromEntries(plantGuideSnap.docs.map(d => [d.id, d.data()])),
      specialEvents: Object.fromEntries(specialEventsSnap.docs.map(d => [d.id, d.data()])),
      plantTypes: Object.fromEntries(plantTypesSnap.docs.map(d => [d.id, d.data()])),
      harvestDestinations: Object.fromEntries(harvestDestinationsSnap.docs.map(d => [d.id, d.data()])),
      harvests: Object.fromEntries(harvestsSnap.docs.map(d => [d.id, d.data()])),
      transplants: Object.fromEntries(transplantsSnap.docs.map(d => [d.id, d.data()])),
      germinations: Object.fromEntries(germinationsSnap.docs.map(d => [d.id, d.data()])),
      losses: Object.fromEntries(lossesSnap.docs.map(d => [d.id, d.data()])),
      envReadings: Object.fromEntries(envReadingsSnap.docs.map(d => [d.id, d.data()])),
      tanks: Object.fromEntries(tanksSnap.docs.map(d => [d.id, d.data()])),
      staff: Object.fromEntries(staffSnap.docs.map(d => [d.id, d.data()])),
      attendance: Object.fromEntries(attendanceSnap.docs.map(d => [d.id, d.data()])),
      inventoryAssets: Object.fromEntries(inventoryAssetsSnap.docs.map(d => [d.id, d.data()])),
      inventoryConsumables: Object.fromEntries(inventoryConsumablesSnap.docs.map(d => [d.id, d.data()])),
      purchaseAreas: Object.fromEntries(purchaseAreasSnap.docs.map(d => [d.id, d.data()])),
      purchasePlans: Object.fromEntries(purchasePlansSnap.docs.map(d => [d.id, d.data()])),
      reports: Object.fromEntries(reportsSnap.docs.map(d => [d.id, d.data()])),
      reportTasks: Object.fromEntries(reportTasksSnap.docs.map(d => [d.id, d.data()])),
      claims: Object.fromEntries(claimsSnap.docs.map(d => [d.id, d.data()]))
    };
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "indoor-farm-tracker-backup-" + toKey(new Date()) + ".json";
    a.click();
    $("dataStatus").textContent = "Exported.";
  } catch (err){
    $("dataStatus").textContent = "Export failed: " + err.message;
  }
});

$("importDataBtn").addEventListener("click", () => $("importFileInput").click());
$("importFileInput").addEventListener("change", async () => {
  const file = $("importFileInput").files[0];
  if (!file) return;
  if (!confirm("Importing will OVERWRITE current schedule, series, house rules, findings, plant guide, special events, grow log data, staff, attendance, and inventory data with the contents of this file. This can't be undone. Continue?")) {
    $("importFileInput").value = "";
    return;
  }
  $("dataStatus").textContent = "Importing…";
  try {
    const text = await file.text();
    const dump = JSON.parse(text);
    const ops = [];
    Object.entries(dump.schedule || {}).forEach(([id, data]) => ops.push(["schedule", id, data]));
    Object.entries(dump.series || {}).forEach(([id, data]) => ops.push(["series", id, data]));
    Object.entries(dump.findings || {}).forEach(([id, data]) => ops.push(["findings", id, data]));
    Object.entries(dump.proposals || {}).forEach(([id, data]) => ops.push(["proposals", id, data]));
    Object.entries(dump.plantGuide || {}).forEach(([id, data]) => ops.push(["plantGuide", id, data]));
    Object.entries(dump.specialEvents || {}).forEach(([id, data]) => ops.push(["specialEvents", id, data]));
    Object.entries(dump.plantTypes || {}).forEach(([id, data]) => ops.push(["plantTypes", id, data]));
    Object.entries(dump.harvestDestinations || {}).forEach(([id, data]) => ops.push(["harvestDestinations", id, data]));
    Object.entries(dump.harvests || {}).forEach(([id, data]) => ops.push(["harvests", id, data]));
    Object.entries(dump.transplants || {}).forEach(([id, data]) => ops.push(["transplants", id, data]));
    Object.entries(dump.germinations || {}).forEach(([id, data]) => ops.push(["germinations", id, data]));
    Object.entries(dump.losses || {}).forEach(([id, data]) => ops.push(["losses", id, data]));
    Object.entries(dump.envReadings || {}).forEach(([id, data]) => ops.push(["envReadings", id, data]));
    Object.entries(dump.tanks || {}).forEach(([id, data]) => ops.push(["tanks", id, data]));
    Object.entries(dump.staff || {}).forEach(([id, data]) => ops.push(["staff", id, data]));
    Object.entries(dump.attendance || {}).forEach(([id, data]) => ops.push(["attendance", id, data]));
    Object.entries(dump.inventoryAssets || {}).forEach(([id, data]) => ops.push(["inventoryAssets", id, data]));
    Object.entries(dump.inventoryConsumables || {}).forEach(([id, data]) => ops.push(["inventoryConsumables", id, data]));
    Object.entries(dump.purchaseAreas || {}).forEach(([id, data]) => ops.push(["purchaseAreas", id, data]));
    Object.entries(dump.purchasePlans || {}).forEach(([id, data]) => ops.push(["purchasePlans", id, data]));
    Object.entries(dump.reports || {}).forEach(([id, data]) => ops.push(["reports", id, data]));
    Object.entries(dump.reportTasks || {}).forEach(([id, data]) => ops.push(["reportTasks", id, data]));
    Object.entries(dump.claims || {}).forEach(([id, data]) => ops.push(["claims", id, data]));

    // Firestore batches cap at 500 operations — chunk to be safe.
    for (let i = 0; i < ops.length; i += 400){
      const chunk = ops.slice(i, i + 400);
      const batch = writeBatch(db);
      chunk.forEach(([col, id, data]) => batch.set(doc(db, col, id), data));
      await batch.commit();
    }
    if (dump.houseRules) await setDoc(doc(db, "meta", "houseRules"), dump.houseRules);

    $("dataStatus").textContent = "Import complete (" + ops.length + " records).";
  } catch (err){
    $("dataStatus").textContent = "Import failed: " + err.message;
  }
  $("importFileInput").value = "";
});

// ============================================================================
// TRASH (Firestore: trash/{id}) — every delete button in the app (and the bulk
// "Clear a collection" tool below) routes through moveToTrash() instead of a hard
// Firestore delete, so a wrong delete has an undo. Kept for 365 days, but this is a
// static client-side app with no server-side cron — sweepExpiredTrash() only runs
// when an admin's browser loads the trash list, so "365 days" means "purged the
// next time someone with admin access opens the app after that date," not a
// guaranteed-to-the-second background job.
// ============================================================================
let trashCache = [];
const TRASH_RETENTION_DAYS = 365;

function describeTrashItem(col, data){
  if (data.plantTypeId) return plantTypeName(data.plantTypeId) + (data.quantity != null ? " — " + data.quantity : "") + (data.date ? " (" + data.date + ")" : "");
  if (data.name) return data.name;
  if (data.title) return data.title;
  if (data.text) return data.text.slice(0, 60);
  if (data.item) return data.item;
  if (data.notes) return data.notes.slice(0, 60);
  if (data.date) return data.date;
  return "record";
}

async function moveToTrash(col, id, data){
  const clean = { ...data };
  delete clean.id;
  const deletedAt = new Date();
  const purgeAt = new Date(deletedAt);
  purgeAt.setDate(purgeAt.getDate() + TRASH_RETENTION_DAYS);
  await addDoc(collection(db, "trash"), {
    collection: col,
    docId: id,
    data: clean,
    label: describeTrashItem(col, clean),
    deletedAt: deletedAt.toISOString(),
    purgeAt: purgeAt.toISOString()
  });
  await deleteDoc(doc(db, col, id));
}

async function sweepExpiredTrash(){
  const now = new Date().toISOString();
  const expired = trashCache.filter(t => t.purgeAt && t.purgeAt <= now);
  for (const item of expired){
    try { await deleteDoc(doc(db, "trash", item.id)); } catch {}
  }
}

onSnapshot(collection(db, "trash"), (snap) => {
  trashCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  sweepExpiredTrash();
  renderTrash();
}, () => {});

async function restoreFromTrash(trashId){
  const item = trashCache.find(t => t.id === trashId);
  if (!item) return;
  await setDoc(doc(db, item.collection, item.docId), item.data);
  await deleteDoc(doc(db, "trash", trashId));
}

function renderTrash(){
  const list = $("trashList");
  const countEl = $("trashCount");
  if (!list || !countEl) return;
  list.innerHTML = "";
  if (!isAdmin) return;
  const items = trashCache.slice().sort((a,b) => (b.deletedAt || "").localeCompare(a.deletedAt || ""));
  countEl.textContent = items.length ? (items.length + " item" + (items.length === 1 ? "" : "s") + " in trash") : "Trash is empty.";
  items.forEach(item => {
    const row = document.createElement("div");
    row.className = "trash-row";

    const info = document.createElement("div");
    info.className = "trash-info";
    const daysLeft = Math.max(0, Math.ceil((new Date(item.purgeAt) - new Date()) / 86400000));
    const collLabel = (typeof CLEARABLE_COLLECTIONS !== "undefined" && CLEARABLE_COLLECTIONS[item.collection]) || item.collection;
    info.innerHTML =
      '<div class="trash-label">' + escapeHtml(collLabel) + ' — ' + escapeHtml(item.label || "record") + '</div>' +
      '<div class="trash-meta">Deleted ' + escapeHtml((item.deletedAt || "").slice(0,10)) + ' · purges in ' + daysLeft + ' day' + (daysLeft === 1 ? "" : "s") + '</div>';
    row.appendChild(info);

    const actions = document.createElement("div");
    actions.className = "trash-actions";
    const restoreBtn = document.createElement("button");
    restoreBtn.className = "btn primary"; restoreBtn.textContent = "↺ Restore";
    restoreBtn.addEventListener("click", async () => {
      restoreBtn.disabled = true; restoreBtn.textContent = "Restoring…";
      try { await restoreFromTrash(item.id); }
      catch (err){ alert("Couldn't restore: " + err.message); restoreBtn.disabled = false; restoreBtn.textContent = "↺ Restore"; }
    });
    const purgeBtn = document.createElement("button");
    purgeBtn.className = "btn danger"; purgeBtn.textContent = "Delete forever";
    purgeBtn.addEventListener("click", async () => {
      if (!confirm("Permanently delete this — it can't be restored after this?")) return;
      try { await deleteDoc(doc(db, "trash", item.id)); }
      catch (err){ alert("Couldn't delete: " + err.message); }
    });
    actions.appendChild(restoreBtn); actions.appendChild(purgeBtn);
    row.appendChild(actions);

    list.appendChild(row);
  });
}

// Wipes every record in one collection — meant for right before an Import, so a
// corrected re-import doesn't leave the previous attempt's records sitting alongside
// the new ones under different IDs. Each deleted record still lands in Trash first
// (see moveToTrash() above), so this needs only one confirmation, not two.
const CLEARABLE_COLLECTIONS = {
  schedule: "Schedule", series: "Recurring Series", findings: "Findings",
  proposals: "Planning / Proposals", plantGuide: "Plant Guide", specialEvents: "Special Events",
  plantTypes: "Plant Types", harvestDestinations: "Harvest Destinations",
  harvests: "Harvests", transplants: "Transfers (batches)", germinations: "Germinations", losses: "Losses",
  envReadings: "Environment Readings", tanks: "Tanks", staff: "Staff", attendance: "Attendance",
  inventoryAssets: "Inventory Assets", inventoryConsumables: "Inventory Consumables",
  purchaseAreas: "Purchase Areas", purchasePlans: "Purchase Plans",
  reports: "Reports", reportTasks: "Report Tasks", claims: "Claims"
};
(() => {
  const sel = $("clearCollectionSelect");
  Object.entries(CLEARABLE_COLLECTIONS).forEach(([col, label]) => {
    const opt = document.createElement("option");
    opt.value = col; opt.textContent = label;
    sel.appendChild(opt);
  });
})();

$("clearCollectionBtn").addEventListener("click", async () => {
  if (!isAdmin) return;
  const col = $("clearCollectionSelect").value;
  if (!col){ alert("Pick a collection first."); return; }
  const label = CLEARABLE_COLLECTIONS[col];
  const btn = $("clearCollectionBtn");
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = "Checking…";
  $("clearCollectionStatus").textContent = "";
  try {
    const snap = await getDocs(collection(db, col));
    if (snap.empty){
      $("clearCollectionStatus").textContent = label + " is already empty.";
      return;
    }
    const count = snap.size;
    if (!confirm("Move all " + count + " record" + (count === 1 ? "" : "s") + " in \"" + label + "\" to Trash? You'll be able to restore them individually from there for the next " + TRASH_RETENTION_DAYS + " days.")) return;
    btn.textContent = "Moving to trash…";
    const docsToDelete = snap.docs;
    const deletedAt = new Date();
    const purgeAt = new Date(deletedAt);
    purgeAt.setDate(purgeAt.getDate() + TRASH_RETENTION_DAYS);
    for (let i = 0; i < docsToDelete.length; i += 200){
      const chunk = docsToDelete.slice(i, i + 200);
      const batch = writeBatch(db);
      chunk.forEach(d => {
        const data = d.data();
        batch.set(doc(collection(db, "trash")), {
          collection: col, docId: d.id, data,
          label: describeTrashItem(col, data),
          deletedAt: deletedAt.toISOString(), purgeAt: purgeAt.toISOString()
        });
        batch.delete(d.ref);
      });
      await batch.commit();
    }
    $("clearCollectionStatus").textContent = "Moved " + count + " record" + (count === 1 ? "" : "s") + " from \"" + label + "\" to Trash.";
  } catch (err){
    $("clearCollectionStatus").textContent = "Failed: " + err.message;
  } finally {
    btn.disabled = false; btn.textContent = original;
  }
});

// ============================================================================
// INIT
// ============================================================================
(async () => {
  // give the initial onSnapshot calls a moment to populate caches, then top up
  // any recurring series into the rolling horizon.
  setTimeout(() => { topUpAllSeries(); }, 1500);
  subscribeAttendance();
  renderCalendar();
  renderDailySchedule();
})();
