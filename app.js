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
  addDoc, query, where, onSnapshot, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const firebaseApp = initializeApp(window.FIREBASE_CONFIG);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

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
function inRange(key){ return key >= START_DATE; }
function horizonEnd(fromKey){
  const d = fromKey ? toDate(fromKey) : new Date();
  d.setDate(d.getDate() + HORIZON_DAYS);
  return toKey(d);
}
function nowTimeStr(){
  const d = new Date();
  return String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0");
}
function eventTimeStatus(ev, isToday){
  if (!isToday) return "";
  const now = nowTimeStr();
  const overnight = ev.end < ev.start;
  if (overnight) return now >= ev.start ? "current" : "";
  if (now >= ev.end) return "past";
  if (now >= ev.start) return "current";
  return "";
}
function escapeHtml(s){
  return String(s || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function $(id){ return document.getElementById(id); }

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

onAuthStateChanged(auth, (user) => {
  isAdmin = !!user;
  refreshAdminUI();
  renderCalendar();
  renderDailySchedule();
  renderAttendance();
  renderStaffList();
  renderRules();
  renderFindings();
  renderPlantGuide();
  renderSpecialEvents();
  renderPlantTypes();
  Object.keys(LOG_CONFIGS).forEach(renderLogSection);
  renderEnvReadings();
  if (isDashboardActive()) renderDashboard();
  renderAssets();
  renderConsumables();
});

function refreshAdminUI(){
  $("adminArea").style.display = isAdmin ? "flex" : "none";
  $("addRuleRow").style.display = isAdmin ? "flex" : "none";
  $("addFindingRow").style.display = isAdmin ? "flex" : "none";
  $("addPlantRow").style.display = isAdmin ? "flex" : "none";
  $("addSpecialEventRow").style.display = isAdmin ? "flex" : "none";
  $("dsAddEventBtn").style.display = isAdmin ? "inline-block" : "none";
  $("dsResetBtn").style.display = isAdmin ? "inline-block" : "none";
  $("addAttRow").style.display = isAdmin ? "flex" : "none";
  $("staffToggleRow").style.display = isAdmin ? "block" : "none";
  $("plantTypesToggleRow").style.display = isAdmin ? "block" : "none";
  $("addHarvestsRow").style.display = isAdmin ? "flex" : "none";
  $("addTransplantsRow").style.display = isAdmin ? "flex" : "none";
  $("addGerminationsRow").style.display = isAdmin ? "flex" : "none";
  $("addLossesRow").style.display = isAdmin ? "flex" : "none";
  $("addEnvReadingsRow").style.display = isAdmin ? "flex" : "none";
  $("addAssetRow").style.display = isAdmin ? "flex" : "none";
  $("addConsumableRow").style.display = isAdmin ? "flex" : "none";
  $("dataTabBtn").style.display = isAdmin ? "inline-block" : "none";
  if (!isAdmin){
    $("staffPanel").style.display = "none";
    $("plantTypesPanel").style.display = "none";
    if ($("tab-data").classList.contains("active")) activateTab("calendar");
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
}
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => activateTab(btn.dataset.tab));
});

document.querySelectorAll(".subtab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const container = btn.closest(".tab-panel");
    const key = btn.dataset.subtab;
    container.querySelectorAll(".subtab-btn").forEach(b => b.classList.toggle("active", b === btn));
    container.querySelectorAll(".subtab-panel").forEach(p => p.classList.toggle("active", p.dataset.subtab === key));
    if (container.id === "tab-growlog" && key === "dashboard") renderDashboard();
  });
});

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
    if (key === toKey(new Date())) cell.classList.add("today");
    if (key === highlightDate) cell.classList.add("search-highlight");

    const numRow = document.createElement("div");
    numRow.className = "day-num";
    const tagClass = entry.dayType === "visitor" ? "visitor" : (entry.dayType === "holiday" ? "holiday" : "maint");
    numRow.innerHTML = "<span>" + day + "</span>" + '<span class="day-tag ' + tagClass + '">' + DAY_TYPE_TAG_LABELS[entry.dayType] + '</span>';
    cell.appendChild(numRow);

    const summary = document.createElement("div");
    summary.className = "day-summary";
    const sorted = entry.events.slice().sort((a,b) => a.start.localeCompare(b.start));
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
$("calTodayBtn").addEventListener("click", () => jumpCalendarToDate(toKey(new Date())));
$("calGoToDate").addEventListener("change", (e) => { if (e.target.value) jumpCalendarToDate(e.target.value); });

// ============================================================================
// DAILY SCHEDULE TAB
// ============================================================================
const todayKeyGlobal = toKey(new Date());
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
  const t = toKey(new Date());
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

  const isToday = selectedDate === toKey(new Date());
  const nowClock = $("dsNowClock");
  if (isToday){
    nowClock.textContent = "Now " + nowTimeStr();
    nowClock.style.display = "inline";
  } else {
    nowClock.style.display = "none";
  }

  const list = $("dsEventList");
  list.innerHTML = "";
  const sorted = entry.events.slice().sort((a,b) => a.start.localeCompare(b.start));

  if (sorted.length === 0){
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No events scheduled for this day.";
    list.appendChild(empty);
  }

  sorted.forEach(ev => {
    const row = document.createElement("div");
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
  if (selectedDate === toKey(new Date())) renderDailySchedule();
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

  // Repeat-daily checkbox: offered when creating a new event, and also when editing an
  // existing one-off event (so it can be turned into a recurring series later if you forgot
  // to tick it originally). Not shown if the event is already part of a series — use the
  // "this and all future days" scope option above instead.
  $("fRepeat").checked = false;
  $("repeatFieldRow").style.display = hasSeries ? "none" : "flex";
  $("repeatFieldRow").querySelector("small").textContent = isNew
    ? "Happens every day going forward, including maintenance Mondays — skips only days marked as a holiday / off day. Keeps going indefinitely until you delete the series."
    : "Turns this into a recurring series starting today, including maintenance Mondays — skips only days marked as a holiday / off day. Keeps going indefinitely until you delete the series.";

  overlay.classList.add("active");
}
function closeEventModal(){ overlay.classList.remove("active"); editingDate = null; editingEventId = null; }
$("cancelBtn").addEventListener("click", closeEventModal);
overlay.addEventListener("click", (e) => { if (e.target === overlay) closeEventModal(); });

// ---- recurring series ----
async function materializeSeries(seriesId, fromKey, template, toKeyStr){
  const batch = writeBatch(db);
  let d = toDate(fromKey);
  const endD = toDate(toKeyStr);
  let count = 0;
  for (; d <= endD; d.setDate(d.getDate() + 1)){
    const key = toKey(d);
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

async function addRecurringEvents(startKey, template){
  const seriesId = uid();
  await materializeSeries(seriesId, startKey, template, horizonEnd(startKey));
  const seriesDoc = { title: template.title, start: template.start, end: template.end, person: template.person, notes: template.notes, fromDate: startKey };
  await setDoc(doc(db, "series", seriesId), seriesDoc);
  seriesCache.push({ id: seriesId, ...seriesDoc });
}

// Turns an already-existing, one-off event into the first occurrence of a new recurring
// series (used when editing an event you forgot to mark "repeat daily" when creating it).
async function convertToRecurring(dateKey, eventId, fields){
  const seriesId = uid();
  const entry = editableDay(dateKey);
  const ev = entry.events.find(e => e.id === eventId);
  if (!ev) return;
  ev.seriesId = seriesId; ev.start = fields.start; ev.end = fields.end;
  ev.title = fields.title; ev.person = fields.person; ev.notes = fields.notes;
  await saveDay(dateKey, entry);

  const seriesDoc = { title: fields.title, start: fields.start, end: fields.end, person: fields.person, notes: fields.notes, fromDate: dateKey };
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

// updates every already-materialized occurrence of a series from fromKey onward,
// and updates the series template so future auto-generated days match too.
async function updateSeriesForward(seriesId, fromKey, fields){
  const batch = writeBatch(db);
  let touched = 0;
  Object.keys(scheduleCache).forEach(key => {
    if (key < fromKey) return;
    const dayEntry = scheduleCache[key];
    if (!dayEntry || !dayEntry.events) return;
    const ev = dayEntry.events.find(e => e.seriesId === seriesId);
    if (!ev) return;
    ev.start = fields.start; ev.end = fields.end; ev.title = fields.title; ev.person = fields.person; ev.notes = fields.notes;
    batch.set(doc(db, "schedule", key), dayEntry);
    touched++;
  });
  if (touched > 0) await batch.commit();

  const seriesRef = doc(db, "series", seriesId);
  await updateDoc(seriesRef, fields);
  const idx = seriesCache.findIndex(s => s.id === seriesId);
  if (idx >= 0) seriesCache[idx] = { ...seriesCache[idx], ...fields };
}

$("saveBtn").addEventListener("click", async () => {
  if (!editingDate) return;
  const start = $("fStart").value || "09:00";
  const end = $("fEnd").value || "10:00";
  const title = $("fTitle").value.trim() || "Untitled Event";
  const person = $("fPerson").value.trim();
  const notes = $("fNotes").value.trim();
  const repeat = $("fRepeat").checked;

  if (editingEventId){
    const entry = editableDay(editingDate);
    const ev = entry.events.find(e => e.id === editingEventId);
    const scopeAll = ev && ev.seriesId && document.querySelector('input[name=seriesScope]:checked').value === "all";
    if (scopeAll){
      await updateSeriesForward(ev.seriesId, editingDate, { start, end, title, person, notes });
    } else if (ev && !ev.seriesId && repeat){
      await convertToRecurring(editingDate, editingEventId, { start, end, title, person, notes });
    } else {
      if (ev){ ev.start = start; ev.end = end; ev.title = title; ev.person = person; ev.notes = notes; }
      await saveDay(editingDate, entry);
    }
  } else if (repeat){
    await addRecurringEvents(editingDate, { start, end, title, person, notes });
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
  if (!confirm("Delete this entire recurring series? This removes it from every day it was scheduled on.")) return;
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
      await deleteDoc(doc(db, "staff", s.id));
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
  await addDoc(collection(db, "staff"), { name, pin });
  nameInput.value = ""; pinInput.value = "";
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
  const t = toKey(new Date());
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
        await deleteDoc(doc(db, "attendance", rec.id));
      });
      row.appendChild(del);
    }
    list.appendChild(row);
  });
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
  const name = input.value.trim();
  if (!name) return;
  await addDoc(collection(db, "attendance"), { date: attSelectedDate, name, signIn: "", signOut: "", signInLoc: null, signOutLoc: null });
  input.value = "";
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
  const today = toKey(new Date());
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
  const val = input.value.trim();
  if (!val) return;
  rulesCache.push(val);
  input.value = "";
  await saveRules();
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
        await deleteDoc(doc(db, "findings", f.id));
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
  const val = textInput.value.trim();
  if (!val) return;
  const date = dateInput.value || toKey(new Date());
  const newDoc = await addDoc(collection(db, "findings"), { date, text: val, photos: [] });
  expandedFindings[newDoc.id] = true;
  textInput.value = "";
});
$("newFindingInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("addFindingBtn").click(); });
(() => { const t = toKey(new Date()); $("newFindingDate").value = inRange(t) ? t : START_DATE; })();

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
          await deleteDoc(doc(db, "plantGuide", p.id));
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
  const title = titleInput.value.trim();
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
    dateEl.textContent = ev.endDate && ev.endDate !== ev.startDate ? ((ev.startDate || "") + " → " + ev.endDate) : (ev.startDate || "");
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
        try { await deleteDoc(doc(db, "specialEvents", ev.id)); }
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
  const notesInput = $("newSpecialEventNotes");
  const title = titleInput.value.trim();
  if (!title) return;
  const startDate = startInput.value || toKey(new Date());
  const endDate = endInput.value || "";
  const notes = notesInput.value.trim();
  const btn = $("addSpecialEventBtn");
  btn.disabled = true; btn.textContent = "Adding…";
  try {
    const newDoc = await addDoc(collection(db, "specialEvents"), { title, startDate, endDate, notes, photos: [] });
    expandedSpecialEvents[newDoc.id] = true;
    titleInput.value = ""; startInput.value = ""; endInput.value = ""; notesInput.value = "";
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
const LOCATIONS = { level1: "Level 1", level3: "Level 3", germOnSite: "Germination Room (On Site)", germOffSite: "Germination Room (Off Site)" };
function capitalize(s){ return s.charAt(0).toUpperCase() + s.slice(1); }

// ---- Plant Types (Firestore: plantTypes/{id}) ----
let plantTypesCache = [];
onSnapshot(collection(db, "plantTypes"), (snap) => {
  plantTypesCache = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => (a.name||"").localeCompare(b.name||""));
  renderPlantTypes();
  populatePlantTypeSelects();
}, () => setSyncStatus("err", "Connection error"));

function plantTypeName(id){
  const pt = plantTypesCache.find(p => p.id === id);
  return pt ? pt.name : "(unknown plant)";
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

    const del = document.createElement("button");
    del.className = "icon-btn"; del.textContent = "✕"; del.title = "Remove plant type";
    del.addEventListener("click", async () => {
      if (!confirm("Remove \"" + pt.name + "\" from plant types? Past log entries keep their recorded name.")) return;
      try { await deleteDoc(doc(db, "plantTypes", pt.id)); }
      catch (err){ alert("Couldn't delete this plant type: " + err.message); }
    });

    row.appendChild(name); row.appendChild(del);
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
  const name = input.value.trim();
  if (!name) return;
  try {
    await addDoc(collection(db, "plantTypes"), { name });
    input.value = "";
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

// ---- Harvest / Seedling Transfer / Germination / Losses ----
// All four are "dated log: plant type + quantity + one-or-two location
// fields + notes + photos" — driven by one config-driven renderer instead
// of four near-identical copies of the Findings Log pattern.
const LOG_CONFIGS = {
  harvests: {
    locationField: { key: "location", options: [["level1","Level 1"],["level3","Level 3"]] },
  },
  germinations: {
    locationField: { key: "room", options: [["germOnSite","On Site"],["germOffSite","Off Site"]] },
  },
  transplants: {
    locationField: { key: "sourceRoom", options: [["germOnSite","On Site"],["germOffSite","Off Site"]] },
    secondLocationField: { key: "destLevel", options: [["level1","Level 1"],["level3","Level 3"]] },
  },
  losses: {
    locationField: { key: "location", options: Object.entries(LOCATIONS) },
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

Object.keys(LOG_CONFIGS).forEach(col => {
  onSnapshot(collection(db, col), (snap) => {
    LOG_SETTERS[col](snap.docs.map(d => ({ id: d.id, photos: [], ...d.data() })));
    renderLogSection(col);
    if (col !== "harvests" && isDashboardActive()) renderDashboard();
  }, () => setSyncStatus("err", "Connection error"));
});

function locOptLabel(key, opts){
  const found = opts.find(([k]) => k === key);
  return found ? found[1] : (key || "—");
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

    const locLabel = locOptLabel(r[cfg.locationField.key], cfg.locationField.options);
    const secondLabel = cfg.secondLocationField ? (" → " + locOptLabel(r[cfg.secondLocationField.key], cfg.secondLocationField.options)) : "";
    const summaryText = plantTypeName(r.plantTypeId) + " — " + (r.quantity != null ? r.quantity : "?") + " · " + locLabel + secondLabel;
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
        try { await deleteDoc(doc(db, col, r.id)); }
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

      if (r.notes){
        const notes = document.createElement("div");
        notes.className = "finding-text";
        notes.textContent = r.notes;
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

    const plantTypeId = plantTypeSelect.value;
    if (!plantTypeId){ alert("Add a plant type first, using the ⚙ Manage Plant Types button above."); return; }
    const quantity = Number(qtyInput.value);
    if (!quantity || quantity <= 0){ alert("Enter a quantity greater than 0."); return; }
    const date = dateInput.value || toKey(new Date());

    const payload = { date, plantTypeId, quantity, notes: notesInput.value.trim(), photos: [] };
    payload[cfg.locationField.key] = locSelect.value;
    if (cfg.secondLocationField) payload[cfg.secondLocationField.key] = loc2Select.value;

    btn.disabled = true; btn.textContent = "Adding…";
    try {
      const newDoc = await addDoc(collection(db, col), payload);
      LOG_EXPANDED[col][newDoc.id] = true;
      qtyInput.value = ""; notesInput.value = "";
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
    row.appendChild(dateEl);
    row.appendChild(locEl);
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
        try { await deleteDoc(doc(db, "envReadings", r.id)); }
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
  const isGermRoom = scopeLoc === "germOnSite" || scopeLoc === "germOffSite";

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

let dashboardScopeLoc = "";
function isDashboardActive(){
  const el = document.querySelector('#tab-growlog .subtab-panel[data-subtab="dashboard"]');
  return !!el && el.classList.contains("active");
}

$("dashLocationRow").addEventListener("click", (e) => {
  const btn = e.target.closest(".dash-loc-btn");
  if (!btn) return;
  dashboardScopeLoc = btn.dataset.loc;
  document.querySelectorAll(".dash-loc-btn").forEach(b => b.classList.toggle("active", b === btn));
  renderDashboard();
});

function renderDashboard(){
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
async function uploadToCloudinary(blob){
  const cfg = window.CLOUDINARY_CONFIG;
  const formData = new FormData();
  formData.append("file", blob);
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
        try { await deleteDoc(doc(db, "inventoryAssets", a.id)); }
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
  const name = nameInput.value.trim();
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
        try { await deleteDoc(doc(db, "inventoryConsumables", c.id)); }
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
  const name = nameInput.value.trim();
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

// Photo/annotate pipeline is shared by every collection that stores records
// as { id, photos: [...] } — Findings Log, Plant Guide, Special Events,
// Inventory Assets, and the four Grow Log sections. Registry keeps adding a
// new gallery to a one-line lookup instead of growing an ever-longer ternary
// chain.
const GALLERY_REGISTRY = {
  findings: { cache: () => findingsCache, expanded: () => expandedFindings },
  plantGuide: { cache: () => plantGuideCache, expanded: () => expandedPlants },
  specialEvents: { cache: () => specialEventsCache, expanded: () => expandedSpecialEvents },
  inventoryAssets: { cache: () => assetsCache, expanded: () => expandedAssets },
  harvests: { cache: () => harvestsCache, expanded: () => expandedHarvests },
  transplants: { cache: () => transplantsCache, expanded: () => expandedTransplants },
  germinations: { cache: () => germinationsCache, expanded: () => expandedGerminations },
  losses: { cache: () => lossesCache, expanded: () => expandedLosses },
};
function galleryCache(col){ return GALLERY_REGISTRY[col].cache(); }
function galleryExpanded(col){ return GALLERY_REGISTRY[col].expanded(); }

let photoTargetCollection = "findings";
let photoTargetFindingId = null;
let photoTargetBtn = null;
const photoFileInput = $("photoFileInput");
function openPhotoPicker(col, recordId, btnEl){
  photoTargetCollection = col; photoTargetFindingId = recordId; photoTargetBtn = btnEl || null;
  photoFileInput.value = ""; photoFileInput.click();
}

photoFileInput.addEventListener("change", async () => {
  const files = Array.from(photoFileInput.files || []);
  if (!files.length || !photoTargetFindingId) return;
  const col = photoTargetCollection;
  const recordId = photoTargetFindingId;
  const btn = photoTargetBtn;
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
    const newPhotos = [...(record.photos || []), ...uploaded];
    try {
      await updateDoc(doc(db, col, recordId), { photos: newPhotos });
    } catch (err){
      alert("Photo uploaded, but saving it to the entry failed: " + err.message + "\n\nIf this says \"permission denied\", the Firestore rules for this collection need to be published in the Firebase console.");
      return;
    }

    if (uploaded.length === 1 && col === "findings"){
      // jump straight into annotate mode for a single upload, same as before
      // (skipped for Plant Guide — reference uploads don't need the auto-jump)
      setTimeout(() => openAnnotateModal(col, recordId, uploaded[0].id), 300);
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
let annotateCollection = "findings", annotateFindingId = null, annotatePhotoId = null;
let currentColor = "#e02020";
let drawing = false, lastX = 0, lastY = 0;

document.querySelectorAll(".color-dot").forEach(dot => {
  dot.addEventListener("click", () => {
    document.querySelectorAll(".color-dot").forEach(d => d.classList.remove("selected"));
    dot.classList.add("selected");
    currentColor = dot.dataset.color;
  });
});

function openAnnotateModal(col, recordId, photoId){
  if (!isAdmin) return;
  annotateCollection = col; annotateFindingId = recordId; annotatePhotoId = photoId;
  const record = galleryCache(col).find(r => r.id === recordId);
  const photo = record.photos.find(p => p.id === photoId);
  $("annotateStatus").textContent = "";

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
drawCanvas.addEventListener("pointerdown", (e) => {
  drawing = true;
  const p = canvasPos(e); lastX = p.x; lastY = p.y;
  drawCtx.beginPath(); drawCtx.arc(p.x, p.y, 1.6, 0, Math.PI*2); drawCtx.fillStyle = currentColor; drawCtx.fill();
});
drawCanvas.addEventListener("pointermove", (e) => {
  if (!drawing) return;
  const p = canvasPos(e);
  drawCtx.strokeStyle = currentColor; drawCtx.lineWidth = 3; drawCtx.lineCap = "round"; drawCtx.lineJoin = "round";
  drawCtx.beginPath(); drawCtx.moveTo(lastX, lastY); drawCtx.lineTo(p.x, p.y); drawCtx.stroke();
  lastX = p.x; lastY = p.y;
});
window.addEventListener("pointerup", () => { drawing = false; });
$("annotateClear").addEventListener("click", () => drawCtx.clearRect(0,0,drawCanvas.width, drawCanvas.height));
$("annotateCancel").addEventListener("click", () => annotateOverlay.classList.remove("active"));

$("annotateSave").addEventListener("click", async () => {
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
      const newPhotos = record.photos.map(p => p.id === annotatePhotoId ? { ...p, url, publicId } : p);
      await updateDoc(doc(db, annotateCollection, annotateFindingId), { photos: newPhotos });
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
    const [scheduleSnap, seriesSnap, houseRulesSnap, findingsSnap, plantGuideSnap, specialEventsSnap, plantTypesSnap, harvestsSnap, transplantsSnap, germinationsSnap, lossesSnap, envReadingsSnap, staffSnap, attendanceSnap, inventoryAssetsSnap, inventoryConsumablesSnap] = await Promise.all([
      getDocs(collection(db, "schedule")),
      getDocs(collection(db, "series")),
      getDoc(doc(db, "meta", "houseRules")),
      getDocs(collection(db, "findings")),
      getDocs(collection(db, "plantGuide")),
      getDocs(collection(db, "specialEvents")),
      getDocs(collection(db, "plantTypes")),
      getDocs(collection(db, "harvests")),
      getDocs(collection(db, "transplants")),
      getDocs(collection(db, "germinations")),
      getDocs(collection(db, "losses")),
      getDocs(collection(db, "envReadings")),
      getDocs(collection(db, "staff")),
      getDocs(collection(db, "attendance")),
      getDocs(collection(db, "inventoryAssets")),
      getDocs(collection(db, "inventoryConsumables"))
    ]);
    const dump = {
      exportedAt: new Date().toISOString(),
      schedule: Object.fromEntries(scheduleSnap.docs.map(d => [d.id, d.data()])),
      series: Object.fromEntries(seriesSnap.docs.map(d => [d.id, d.data()])),
      houseRules: houseRulesSnap.exists() ? houseRulesSnap.data() : { rules: DEFAULT_RULES },
      findings: Object.fromEntries(findingsSnap.docs.map(d => [d.id, d.data()])),
      plantGuide: Object.fromEntries(plantGuideSnap.docs.map(d => [d.id, d.data()])),
      specialEvents: Object.fromEntries(specialEventsSnap.docs.map(d => [d.id, d.data()])),
      plantTypes: Object.fromEntries(plantTypesSnap.docs.map(d => [d.id, d.data()])),
      harvests: Object.fromEntries(harvestsSnap.docs.map(d => [d.id, d.data()])),
      transplants: Object.fromEntries(transplantsSnap.docs.map(d => [d.id, d.data()])),
      germinations: Object.fromEntries(germinationsSnap.docs.map(d => [d.id, d.data()])),
      losses: Object.fromEntries(lossesSnap.docs.map(d => [d.id, d.data()])),
      envReadings: Object.fromEntries(envReadingsSnap.docs.map(d => [d.id, d.data()])),
      staff: Object.fromEntries(staffSnap.docs.map(d => [d.id, d.data()])),
      attendance: Object.fromEntries(attendanceSnap.docs.map(d => [d.id, d.data()])),
      inventoryAssets: Object.fromEntries(inventoryAssetsSnap.docs.map(d => [d.id, d.data()])),
      inventoryConsumables: Object.fromEntries(inventoryConsumablesSnap.docs.map(d => [d.id, d.data()]))
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
    Object.entries(dump.plantGuide || {}).forEach(([id, data]) => ops.push(["plantGuide", id, data]));
    Object.entries(dump.specialEvents || {}).forEach(([id, data]) => ops.push(["specialEvents", id, data]));
    Object.entries(dump.plantTypes || {}).forEach(([id, data]) => ops.push(["plantTypes", id, data]));
    Object.entries(dump.harvests || {}).forEach(([id, data]) => ops.push(["harvests", id, data]));
    Object.entries(dump.transplants || {}).forEach(([id, data]) => ops.push(["transplants", id, data]));
    Object.entries(dump.germinations || {}).forEach(([id, data]) => ops.push(["germinations", id, data]));
    Object.entries(dump.losses || {}).forEach(([id, data]) => ops.push(["losses", id, data]));
    Object.entries(dump.envReadings || {}).forEach(([id, data]) => ops.push(["envReadings", id, data]));
    Object.entries(dump.staff || {}).forEach(([id, data]) => ops.push(["staff", id, data]));
    Object.entries(dump.attendance || {}).forEach(([id, data]) => ops.push(["attendance", id, data]));
    Object.entries(dump.inventoryAssets || {}).forEach(([id, data]) => ops.push(["inventoryAssets", id, data]));
    Object.entries(dump.inventoryConsumables || {}).forEach(([id, data]) => ops.push(["inventoryConsumables", id, data]));

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
