// Manage admins — only the super admin (listed in meta/admins.super) sees this.
// Creates new logins from inside the site, so nobody has to open the Firebase console.
// Uses a second, throw-away Firebase app so you stay logged in as yourself while the account is created.
import { getApps, getApp, initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import { getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signOut, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { getFirestore, doc, onSnapshot, setDoc } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const app = getApps().length ? getApp() : initializeApp(window.FIREBASE_CONFIG);
const auth = getAuth(app), db = getFirestore(app);
const REF = doc(db, "meta", "admins");
let me = null, data = { super: [], list: [] };

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const isSuper = () => !!me && (data.super || []).map(x => String(x).toLowerCase()).includes(String(me.email || "").toLowerCase());

const STYLE = `
.adm-ov{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;display:none;align-items:center;justify-content:center;padding:16px}
.adm-ov.on{display:flex}
.adm-box{background:var(--card,#f7f3ee);border-radius:18px;max-width:460px;width:100%;max-height:90vh;overflow:auto;padding:22px;font-family:Inter,system-ui,sans-serif;color:#2c3a30}
.adm-box h3{margin:0 0 4px;font-size:22px}
.adm-box p{margin:4px 0 12px;font-size:13px;color:#667}
.adm-box label{display:block;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#778;margin:10px 0 4px}
.adm-box input{width:100%;box-sizing:border-box;font:inherit;font-size:16px;padding:11px 12px;border-radius:12px;border:1.5px solid #c9c3bb;background:#fff}
.adm-row{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}
.adm-row button{font:600 15px Inter,system-ui,sans-serif;border-radius:12px;padding:11px 16px;border:1.5px solid #35473a;background:#fff;color:#35473a;cursor:pointer}
.adm-row button.p{background:#35473a;color:#fff}
.adm-msg{margin-top:12px;font-size:14px;font-weight:600}
.adm-msg.ok{color:#35473a}.adm-msg.err{color:#9a4a3a}
.adm-list{margin:14px 0 0;padding:0;list-style:none;font-size:14px}
.adm-list li{display:flex;justify-content:space-between;gap:8px;padding:7px 0;border-top:1px solid #e3ddd5}
.adm-list small{color:#889}
`;

let fab, ov;
function build(){
  const st = document.createElement("style"); st.textContent = STYLE; document.head.appendChild(st);
  fab = document.createElement("button"); fab.className = "admin-btn"; fab.id = "manageAdminsBtn"; fab.textContent = "Admins"; fab.style.display = "none";
  ov = document.createElement("div"); ov.className = "adm-ov";
  const logout = document.getElementById("adminToggleBtn");
  if (logout && logout.parentElement) logout.parentElement.insertBefore(fab, logout); else document.body.appendChild(fab);
  document.body.appendChild(ov);
  fab.addEventListener("click", () => { render(""); ov.classList.add("on"); });
  ov.addEventListener("click", onClick);
}

function render(msg, ok){
  const list = (data.list || []).slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  ov.innerHTML = '<div class="adm-box"><h3>Manage admins</h3><p>Everyone with a login can edit all data. Create a login here; the person can change the password later from the reset link.</p>' +
    '<label>Email</label><input type="email" id="admEmail" autocomplete="off" placeholder="name@company.com">' +
    '<label>Password (at least 6 characters)</label><input type="text" id="admPass" autocomplete="off" placeholder="type a password">' +
    '<div class="adm-row"><button class="p" data-a="create">Create admin</button><button data-a="reset">Send password reset email</button><button data-a="close">Close</button></div>' +
    (msg ? '<div class="adm-msg ' + (ok ? "ok" : "err") + '">' + esc(msg) + '</div>' : "") +
    (list.length ? '<ul class="adm-list">' + list.map(x => '<li><span>' + esc(x.email) + '</span><small>' + esc(x.date || "") + '</small></li>').join("") + '</ul>' : "") + '</div>';
}

async function create(){
  const email = document.getElementById("admEmail").value.trim().toLowerCase(), pass = document.getElementById("admPass").value;
  if (!/^\S+@\S+\.\S+$/.test(email)) return render("Enter a valid email.");
  if (pass.length < 6) return render("Password must be at least 6 characters.");
  render("Creating…", true);
  let sec;
  try {
    sec = initializeApp(window.FIREBASE_CONFIG, "adminCreator" + Date.now());
    const sa = getAuth(sec);
    await createUserWithEmailAndPassword(sa, email, pass);
    await signOut(sa);
  } catch (e){
    if (sec) deleteApp(sec).catch(() => {});
    return render(e && e.code === "auth/email-already-in-use" ? "That email already has a login." : "Couldn't create: " + (e.code || e.message));
  }
  deleteApp(sec).catch(() => {});
  const list = (data.list || []).concat([{ email, date: new Date().toISOString().slice(0, 10), by: me.email }]);
  try { await setDoc(REF, Object.assign({}, data, { list })); } catch (e){}
  render("Created " + email + ". They can log in now.", true);
}

async function reset(){
  const email = document.getElementById("admEmail").value.trim();
  if (!email) return render("Type the email first.");
  try { await sendPasswordResetEmail(auth, email); render("Reset email sent to " + email + ".", true); }
  catch (e){ render("Couldn't send: " + (e.code || e.message)); }
}

function onClick(e){
  if (e.target === ov) return ov.classList.remove("on");
  const b = e.target.closest("[data-a]"); if (!b) return;
  if (b.dataset.a === "close") ov.classList.remove("on");
  else if (b.dataset.a === "create") create();
  else if (b.dataset.a === "reset") reset();
}

function sync(){ if (fab) fab.style.display = isSuper() ? "" : "none"; }

build();
onAuthStateChanged(auth, (u) => { me = u; sync(); });
onSnapshot(REF, (snap) => { data = snap.exists() ? Object.assign({ super: [], list: [] }, snap.data()) : { super: [], list: [] }; sync(); }, () => {});
