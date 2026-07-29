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
});

function refreshAdminUI(){
  $("adminArea").style.display = isAdmin ? "flex" : "none";
  $("addRuleRow").style.display = isAdmin ? "flex" : "none";
  $("addFindingRow").style.display = isAdmin ? "flex" : "none";
  $("dsAddEventBtn").style.display = isAdmin ? "inline-block" : "none";
  $("dsResetBtn").style.display = isAdmin ? "inline-block" : "none";
  $("addAttRow").style.display = isAdmin ? "flex" : "none";
  $("staffToggleRow").style.display = isAdmin ? "block" : "none";
  $("dataTabBtn").style.display = isAdmin ? "inline-block" : "none";
  if (!isAdmin){
    $("staffPanel").style.display = "none";
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
function activateTab(name){
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("active", p.id === "tab-" + name));
}
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => activateTab(btn.dataset.tab));
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
    ? "Happens every day going forward — skips Mondays (maintenance) and any day marked as a holiday / off day. Keeps going indefinitely until you delete the series."
    : "Turns this into a recurring series starting today — skips Mondays (maintenance) and any day marked as a holiday / off day. Keeps going indefinitely until you delete the series.";

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
    if (dayEntry.dayType !== "visitor") continue;
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
    let lastKey = series.fromDate;
    Object.keys(scheduleCache).forEach(key => {
      const dayEntry = scheduleCache[key];
      if (dayEntry && dayEntry.events && dayEntry.events.some(e => e.seriesId === series.id) && key > lastKey) lastKey = key;
    });
    const nextStart = toDate(lastKey);
    nextStart.setDate(nextStart.getDate() + 1);
    const nextStartKey = toKey(nextStart);
    if (nextStartKey <= horizon) await materializeSeries(series.id, nextStartKey, series, horizon);
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
    if (rec[field] && rec[locField]) group.appendChild(makeLocLine(rec[locField]));
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
    if (rec[locField]) group.appendChild(makeLocLine(rec[locField]));
  } else if (canAct){
    const btn = document.createElement("button");
    btn.className = "att-btn " + kind;
    btn.textContent = label;
    btn.addEventListener("click", async () => { await updateDoc(doc(db, "attendance", rec.id), { [field]: nowTimeStr() }); });
    group.appendChild(btn);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "att-time-value empty";
    placeholder.textContent = "—";
    group.appendChild(placeholder);
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
  const latestDate = sorted[0].date;
  sorted.forEach(f => {
    if (!seenFindingIds[f.id]){
      seenFindingIds[f.id] = true;
      if (f.date === latestDate) expandedFindings[f.id] = true;
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
    const isOpen = !!expandedFindings[f.id];
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
            await updateDoc(doc(db, "findings", f.id), { photos: newPhotos });
          });
          wrap.appendChild(rem);
        }
        item.appendChild(wrap);
        if (isAdmin){
          const ann = document.createElement("button");
          ann.className = "annotate-btn"; ann.textContent = "✎ Annotate";
          ann.addEventListener("click", (e) => { e.stopPropagation(); openAnnotateModal(f.id, photo.id); });
          item.appendChild(ann);
        }
        strip.appendChild(item);
      });
      if (isAdmin){
        const addBtn = document.createElement("div");
        addBtn.className = "add-photo-btn"; addBtn.textContent = "+ Add photo";
        addBtn.addEventListener("click", (e) => { e.stopPropagation(); openPhotoPicker(f.id); });
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

let photoTargetFindingId = null;
const photoFileInput = $("photoFileInput");
function openPhotoPicker(findingId){ photoTargetFindingId = findingId; photoFileInput.value = ""; photoFileInput.click(); }

photoFileInput.addEventListener("change", async () => {
  const files = Array.from(photoFileInput.files || []);
  if (!files.length || !photoTargetFindingId) return;
  const findingId = photoTargetFindingId;
  const finding = findingsCache.find(f => f.id === findingId);
  if (!finding) return;

  expandedFindings[findingId] = true;
  const uploaded = [];
  for (const file of files){
    try {
      const { url, publicId } = await uploadToCloudinary(file);
      uploaded.push({ id: uid(), url, publicId });
    } catch (err){
      alert("Photo upload failed: " + err.message + "\n\nCheck your Cloudinary cloud name / upload preset in firebase-config.js (see SETUP.md).");
    }
  }
  if (uploaded.length === 0) return;
  const newPhotos = [...(finding.photos || []), ...uploaded];
  await updateDoc(doc(db, "findings", findingId), { photos: newPhotos });

  if (uploaded.length === 1){
    // jump straight into annotate mode for a single upload, same as before
    setTimeout(() => openAnnotateModal(findingId, uploaded[0].id), 300);
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
let annotateFindingId = null, annotatePhotoId = null;
let currentColor = "#e02020";
let drawing = false, lastX = 0, lastY = 0;

document.querySelectorAll(".color-dot").forEach(dot => {
  dot.addEventListener("click", () => {
    document.querySelectorAll(".color-dot").forEach(d => d.classList.remove("selected"));
    dot.classList.add("selected");
    currentColor = dot.dataset.color;
  });
});

function openAnnotateModal(findingId, photoId){
  if (!isAdmin) return;
  annotateFindingId = findingId; annotatePhotoId = photoId;
  const finding = findingsCache.find(f => f.id === findingId);
  const photo = finding.photos.find(p => p.id === photoId);
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
      const finding = findingsCache.find(f => f.id === annotateFindingId);
      const newPhotos = finding.photos.map(p => p.id === annotatePhotoId ? { ...p, url, publicId } : p);
      await updateDoc(doc(db, "findings", annotateFindingId), { photos: newPhotos });
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
    const [scheduleSnap, seriesSnap, houseRulesSnap, findingsSnap, staffSnap, attendanceSnap] = await Promise.all([
      getDocs(collection(db, "schedule")),
      getDocs(collection(db, "series")),
      getDoc(doc(db, "meta", "houseRules")),
      getDocs(collection(db, "findings")),
      getDocs(collection(db, "staff")),
      getDocs(collection(db, "attendance"))
    ]);
    const dump = {
      exportedAt: new Date().toISOString(),
      schedule: Object.fromEntries(scheduleSnap.docs.map(d => [d.id, d.data()])),
      series: Object.fromEntries(seriesSnap.docs.map(d => [d.id, d.data()])),
      houseRules: houseRulesSnap.exists() ? houseRulesSnap.data() : { rules: DEFAULT_RULES },
      findings: Object.fromEntries(findingsSnap.docs.map(d => [d.id, d.data()])),
      staff: Object.fromEntries(staffSnap.docs.map(d => [d.id, d.data()])),
      attendance: Object.fromEntries(attendanceSnap.docs.map(d => [d.id, d.data()]))
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
  if (!confirm("Importing will OVERWRITE current schedule, series, house rules, findings, staff, and attendance data with the contents of this file. This can't be undone. Continue?")) {
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
    Object.entries(dump.staff || {}).forEach(([id, data]) => ops.push(["staff", id, data]));
    Object.entries(dump.attendance || {}).forEach(([id, data]) => ops.push(["attendance", id, data]));

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
