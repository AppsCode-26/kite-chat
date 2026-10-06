// App-wide configuration. Nothing in this file is secret.

export const APP_NAME = "Kite";

// Firebase web config for sign-in and cloud chat sync. These values identify
// the project and are designed to ship in public client code — access is
// enforced by the Firestore security rules in firestore.rules, not by hiding
// this object. Leave as null to show the "setup needed" screen.
export const firebaseConfig = null;
