// ============================================================================
// PASTE YOUR CONFIG HERE — see SETUP.md for exactly where to get each value.
// ============================================================================
//
// These values are NOT secret. Firebase's web "config" is meant to be public —
// it just tells the browser which project to talk to. Real access control
// happens in firestore.rules (which documents can be read/written by whom) and
// in Firebase Authentication (who is allowed to log in as admin). It's normal
// and safe for this file to sit in a public GitHub repo.
//
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyBfy6Q1Mc8etcsxvx-O9-Y90C725Lpqe6c",
  authDomain: "indoor-farm-tracker.firebaseapp.com",
  projectId: "indoor-farm-tracker",
  storageBucket: "indoor-farm-tracker.firebasestorage.app",
  messagingSenderId: "765595382982",
  appId: "1:765595382982:web:1456fe5ef9bdbadb12d3c7"
};

// Cloudinary is used for photo storage (Findings Log uploads + annotations).
// cloudName: shown on your Cloudinary dashboard home page.
// uploadPreset: the name of the UNSIGNED upload preset you create — see SETUP.md.
window.CLOUDINARY_CONFIG = {
  cloudName: "du3f8jjrp",
  uploadPreset: "farm_findings"
};
