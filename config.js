// App-wide configuration. Nothing in this file is secret.

export const APP_NAME = "Kite";

// The Firebase project that provides sign-in and cloud sync. These values only
// identify the project; access is enforced by the rules in firestore.rules.
export const firebaseConfig = {
  apiKey: "",
  authDomain: "kite-chat-1cdb9.firebaseapp.com",
  projectId: "kite-chat-1cdb9",
  storageBucket: "kite-chat-1cdb9.firebasestorage.app",
  messagingSenderId: "26798514698",
  appId: "1:26798514698:web:021be2dea1f12cd937b5f3",
};

// When apiKey above is empty, the project's web API key is read from this file.
// It can hold the bare key or the whole config snippet copied from Firebase.
export const FIREBASE_KEY_FILE = "firebase-web-key.txt";

// Where the setup screen points until that file exists.
export const SETUP_LINKS = {
  firebase: "https://console.firebase.google.com/project/kite-chat-1cdb9/settings/general",
  github: "https://github.com/AppsCode-26/kite-chat/new/main?filename=firebase-web-key.txt",
};
