# Indoor Farm — Takeover Tracker: Setup Guide

No coding or command line needed — everything below is clicking through three websites you already have accounts for: Firebase, Cloudinary, and GitHub. Should take about 15–20 minutes.

## What changed from the old version

The old tracker was a single file that only remembered data in one browser, on one computer. This version stores everything in Firebase (so it's shared and backed up automatically, and works from any device) and stores photos in Cloudinary (so they don't fill up browser storage). It also adds: real admin login (instead of a password hidden in the code), export/import backup, a search box for the Findings Log, confirm-before-delete on every delete button, and the ability to edit a whole recurring series at once instead of just deleting it.

---

## Part 1 — Firebase (the database + admin login)

1. Go to https://console.firebase.google.com and sign in with your Firebase account.
2. Click **Add project**, give it any name (e.g. `indoor-farm-tracker`), and finish the wizard (you can turn off Google Analytics, it's not needed).
3. In the left sidebar, click **Build → Firestore Database**, then **Create database**. Choose a location close to the farm, and start in **production mode**.
4. Still in the left sidebar, click **Build → Authentication → Get started**. Click the **Sign-in method** tab, choose **Email/Password**, and enable it.
5. Click the **Users** tab (still under Authentication) → **Add user**. Enter the email and password *you* (the admin) want to log in with. This is your new admin login — write it down somewhere safe. You can add more admin users the same way later.
6. Click the gear icon next to "Project Overview" → **Project settings**. Scroll to **Your apps**, click the **</>** (web) icon, give the app any nickname, and click **Register app**. Firebase will show you a code block that looks like:
   ```js
   const firebaseConfig = {
     apiKey: "...",
     authDomain: "...",
     projectId: "...",
     storageBucket: "...",
     messagingSenderId: "...",
     appId: "..."
   };
   ```
7. Open `firebase-config.js` in this folder and paste each value into the matching field inside `window.FIREBASE_CONFIG`.
8. Back in the Firebase console, go to **Firestore Database → Rules** tab. Delete everything there and paste in the entire contents of `firestore.rules` (in this folder), then click **Publish**.

That's the whole Firebase side — no billing/credit card needed for this (Firestore and Authentication both have a generous free tier that easily covers a small team).

## Part 2 — Cloudinary (photo storage)

1. Go to https://cloudinary.com/console and sign in.
2. On the dashboard home page, note your **Cloud name** (shown near the top).
3. Click the gear icon (**Settings**) → **Upload** tab → scroll to **Upload presets** → **Add upload preset**.
4. Set **Signing Mode** to **Unsigned** (important — this lets the app upload photos directly from the browser without needing a secret key). Give the preset a name you'll recognize, e.g. `farm_findings`. Save.
5. Open `firebase-config.js` again and fill in `window.CLOUDINARY_CONFIG`: your cloud name, and the preset name you just created.

## Part 3 — Put it on GitHub (so it has a real web address)

1. Go to https://github.com/new and create a new repository (e.g. `indoor-farm-tracker`). Public or private both work fine.
2. On the new repo's page, click **uploading an existing file** (or drag files in). Upload all the files from this folder: `index.html`, `app.js`, `styles.css`, `firebase-config.js` (with your real values already pasted in), `firestore.rules`, `SETUP.md`. Commit the upload.
3. In the repo, go to **Settings → Pages**. Under "Build and deployment", set **Source** to **Deploy from a branch**, branch **main**, folder **/(root)**. Save.
4. GitHub will give you a URL (something like `https://yourusername.github.io/indoor-farm-tracker/`) — it can take a minute or two to go live the first time. That's the link to share with your team (or just use yourself).

## Testing it

1. Open the GitHub Pages link. You should see the tracker load with a green "Synced" indicator top-right (if it stays on "Connecting…" or turns red, double check the values in `firebase-config.js` and that you published the Firestore rules).
2. Click the page title 5 times quickly (or press Ctrl+Alt+A) to open the hidden Admin Login, and sign in with the email/password you created in Firebase step 5.
3. Try adding a house rule, a schedule event, and a finding with a photo to confirm everything saves.
4. Open the same link on your phone (or a different browser) — you should see the same data, proving it's really shared now instead of stuck in one browser.

## Known limitations (worth knowing, not urgent)

- **Staff PINs are not truly secret.** Anyone who reads the app's network traffic could see the staff/PIN list, same trust level as before (previously the admin password was visible in the page's own code). It's a casual kiosk deterrent, not real security. A fully hidden version would need a small server-side function — ask if you want that built later.
- **Deleting an annotated photo's old version:** annotating a photo uploads a new copy to Cloudinary rather than editing the original in place, so old versions accumulate in your Cloudinary media library over time. Harmless, just something to know if you're tidying up Cloudinary later.
- **Export/Import** is a full overwrite, not a merge — importing a backup replaces current data in the categories included in the file. Confirmation dialogs guard against doing this by accident.
