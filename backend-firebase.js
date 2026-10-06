// Cloud backend: Firebase Auth for accounts, Firestore for everything else.
//
// Data layout (all of it private to the signed-in user, see firestore.rules):
//   users/{uid}                          profile: name, settings, geminiKey, usageTotal
//   users/{uid}/chats/{chatId}           title, pinned, model, createdAt, updatedAt
//   users/{uid}/chats/{chatId}/messages  role, text, thoughts, images, model, usage, createdAt
//   users/{uid}/usage/{YYYY-MM-DD}       per-day token and request counters

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, sendPasswordResetEmail, updateProfile,
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, deleteDoc, getDocs, onSnapshot, query, orderBy, where, limit,
  serverTimestamp, increment, writeBatch,
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";
import { dayKey } from "./util.js";

const AUTH_MESSAGES = {
  "auth/invalid-credential": "That email and password don't match an account.",
  "auth/wrong-password": "That email and password don't match an account.",
  "auth/user-not-found": "That email and password don't match an account.",
  "auth/email-already-in-use": "An account with that email already exists. Sign in instead.",
  "auth/weak-password": "Use a password with at least 6 characters.",
  "auth/invalid-email": "Enter a valid email address.",
  "auth/missing-password": "Enter your password.",
  "auth/too-many-requests": "Too many attempts. Wait a minute and try again.",
  "auth/network-request-failed": "Can't reach the server. Check your connection and try again.",
  "auth/operation-not-allowed": "Email sign-in isn't switched on for this project yet.",
  "auth/user-disabled": "This account has been disabled.",
};

function friendly(err) {
  return new Error(AUTH_MESSAGES[err?.code] || `Something went wrong (${err?.code || "unknown error"}). Try again.`);
}

const millis = (ts) => (ts && typeof ts.toMillis === "function" ? ts.toMillis() : Date.now());

// Firestore rejects undefined, so drop empty fields before writing.
function clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}

// Model ids contain dots, which would read as nested paths in some APIs.
const modelKey = (id) => id.replaceAll(".", "_");
const modelFromKey = (key) => key.replace(/(\d)_(\d)/g, "$1.$2");

export function createBackend(config, { onError = () => {} } = {}) {
  const app = initializeApp(config);
  const auth = getAuth(app);
  let db;
  try {
    db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch {
    db = getFirestore(app);
  }

  const authListeners = new Set();
  const currentUser = () => {
    const u = auth.currentUser;
    return u ? { uid: u.uid, email: u.email || "", name: u.displayName || (u.email || "").split("@")[0] } : null;
  };
  const emitUser = () => authListeners.forEach((cb) => cb(currentUser()));
  let authReady = false;
  onAuthStateChanged(auth, () => { authReady = true; emitUser(); });

  const uid = () => auth.currentUser.uid;
  const userRef = () => doc(db, "users", uid());
  const chatsCol = () => collection(db, "users", uid(), "chats");
  const chatRef = (chatId) => doc(db, "users", uid(), "chats", chatId);
  const messagesCol = (chatId) => collection(db, "users", uid(), "chats", chatId, "messages");
  const usageCol = () => collection(db, "users", uid(), "usage");
  const report = (err) => onError(err);

  return {
    kind: "firebase",

    onAuth(cb) {
      authListeners.add(cb);
      if (authReady) cb(currentUser());
      return () => authListeners.delete(cb);
    },

    async signUp(name, email, password) {
      try {
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        if (name) await updateProfile(cred.user, { displayName: name });
        await setDoc(userRef(), clean({ name, email, createdAt: serverTimestamp() }), { merge: true });
        emitUser();
      } catch (err) {
        throw friendly(err);
      }
    },

    async signIn(email, password) {
      try { await signInWithEmailAndPassword(auth, email, password); } catch (err) { throw friendly(err); }
    },

    signOut() {
      return signOut(auth);
    },

    async resetPassword(email) {
      try { await sendPasswordResetEmail(auth, email); } catch (err) { throw friendly(err); }
    },

    async updateName(name) {
      await updateProfile(auth.currentUser, { displayName: name });
      await setDoc(userRef(), { name }, { merge: true });
      emitUser();
    },

    watchProfile(cb) {
      return onSnapshot(userRef(), (snap) => cb(snap.data() || {}), report);
    },

    saveProfile(patch) {
      return setDoc(userRef(), patch, { merge: true }).catch(report);
    },

    watchChats(cb) {
      const q = query(chatsCol(), orderBy("updatedAt", "desc"), limit(500));
      return onSnapshot(q, (snap) => {
        cb(snap.docs.map((d) => {
          const data = d.data({ serverTimestamps: "estimate" });
          return { id: d.id, title: data.title || "", pinned: !!data.pinned, model: data.model || "", updatedAt: millis(data.updatedAt) };
        }));
      }, report);
    },

    createChat({ title, model }) {
      const ref = doc(chatsCol());
      setDoc(ref, clean({ title, model, pinned: false, createdAt: serverTimestamp(), updatedAt: serverTimestamp() })).catch(report);
      return ref.id;
    },

    updateChat(chatId, patch) {
      return setDoc(chatRef(chatId), patch, { merge: true }).catch(report);
    },

    async deleteChat(chatId) {
      const snap = await getDocs(messagesCol(chatId));
      for (let i = 0; i < snap.docs.length; i += 400) {
        const batch = writeBatch(db);
        snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
      await deleteDoc(chatRef(chatId));
    },

    async deleteAllChats() {
      const snap = await getDocs(chatsCol());
      for (const d of snap.docs) await this.deleteChat(d.id);
    },

    watchMessages(chatId, cb) {
      const q = query(messagesCol(chatId), orderBy("createdAt", "asc"));
      return onSnapshot(q, (snap) => {
        cb(snap.docs.map((d) => {
          const data = d.data({ serverTimestamps: "estimate" });
          return { ...data, id: d.id, createdAt: millis(data.createdAt) };
        }));
      }, report);
    },

    addMessage(chatId, message) {
      const ref = doc(messagesCol(chatId));
      const batch = writeBatch(db);
      batch.set(ref, { ...clean(message), createdAt: serverTimestamp() });
      batch.set(chatRef(chatId), { updatedAt: serverTimestamp() }, { merge: true });
      batch.commit().catch(report);
      return ref.id;
    },

    deleteMessage(chatId, messageId) {
      return deleteDoc(doc(messagesCol(chatId), messageId)).catch(report);
    },

    recordUsage(model, usage) {
      if (!usage) return;
      const counters = {
        requests: increment(1),
        input: increment(usage.input),
        output: increment(usage.output),
        thoughts: increment(usage.thoughts),
        total: increment(usage.total),
      };
      const date = dayKey();
      const batch = writeBatch(db);
      batch.set(doc(usageCol(), date), { date, ...counters, byModel: { [modelKey(model)]: counters } }, { merge: true });
      batch.set(userRef(), { usageTotal: counters }, { merge: true });
      batch.commit().catch(report);
    },

    /** Usage rows for the last `days` days (only days that have any). */
    async loadUsage(days) {
      const start = new Date();
      start.setDate(start.getDate() - (days - 1));
      const snap = await getDocs(query(usageCol(), where("date", ">=", dayKey(start)), orderBy("date")));
      return snap.docs.map((d) => {
        const data = d.data();
        const byModel = {};
        for (const [key, value] of Object.entries(data.byModel || {})) byModel[modelFromKey(key)] = value;
        return { ...data, byModel };
      });
    },
  };
}
