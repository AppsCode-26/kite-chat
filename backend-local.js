// Development-only backend: same interface as backend-firebase.js, backed by
// localStorage. Loaded only on localhost with ?local in the URL, so the UI can
// be exercised without touching the real project. Nothing here syncs anywhere.

import { dayKey } from "./util.js";

const STORE = "kite.local";

export function createBackend() {
  const blank = { user: null, profile: {}, chats: {}, messages: {}, usage: {} };
  let data;
  try { data = { ...blank, ...JSON.parse(localStorage.getItem(STORE) || "{}") }; } catch { data = blank; }

  const listeners = { auth: new Set(), profile: new Set(), chats: new Set(), messages: new Map() };
  const save = () => localStorage.setItem(STORE, JSON.stringify(data));
  const id = () => Math.random().toString(36).slice(2, 12);
  const later = (fn) => queueMicrotask(fn);

  const chatList = () => Object.values(data.chats).sort((a, b) => b.updatedAt - a.updatedAt);
  const emit = {
    auth: () => listeners.auth.forEach((cb) => cb(data.user)),
    profile: () => listeners.profile.forEach((cb) => cb(structuredClone(data.profile))),
    chats: () => listeners.chats.forEach((cb) => cb(chatList())),
    messages: (chatId) => listeners.messages.get(chatId)?.forEach((cb) => cb(structuredClone(data.messages[chatId] || []))),
  };
  const watch = (set, cb, first) => { set.add(cb); later(first); return () => set.delete(cb); };
  const bump = (target, usage) => {
    target.requests = (target.requests || 0) + 1;
    for (const k of ["input", "output", "thoughts", "total"]) target[k] = (target[k] || 0) + usage[k];
  };

  return {
    kind: "local",
    onAuth(cb) { return watch(listeners.auth, cb, () => cb(data.user)); },
    async signUp(name, email) { data.user = { uid: "local", email, name: name || email.split("@")[0] }; save(); emit.auth(); },
    async signIn(email) { data.user = { uid: "local", email, name: data.user?.name || email.split("@")[0] }; save(); emit.auth(); },
    async signOut() { data.user = null; save(); emit.auth(); },
    async resetPassword() {},
    async updateName(name) { data.user = { ...data.user, name }; save(); emit.auth(); },

    watchProfile(cb) { return watch(listeners.profile, cb, () => cb(structuredClone(data.profile))); },
    async saveProfile(patch) {
      data.profile = { ...data.profile, ...patch, settings: { ...data.profile.settings, ...patch.settings } };
      save(); emit.profile();
    },

    watchChats(cb) { return watch(listeners.chats, cb, () => cb(chatList())); },
    createChat({ title, model }) {
      const chatId = id();
      data.chats[chatId] = { id: chatId, title, model, pinned: false, updatedAt: Date.now() };
      save(); later(emit.chats);
      return chatId;
    },
    async updateChat(chatId, patch) { Object.assign(data.chats[chatId], patch); save(); emit.chats(); },
    async deleteChat(chatId) { delete data.chats[chatId]; delete data.messages[chatId]; save(); emit.chats(); },
    async deleteAllChats() { data.chats = {}; data.messages = {}; save(); emit.chats(); },

    watchMessages(chatId, cb) {
      if (!listeners.messages.has(chatId)) listeners.messages.set(chatId, new Set());
      return watch(listeners.messages.get(chatId), cb, () => cb(structuredClone(data.messages[chatId] || [])));
    },
    addMessage(chatId, message) {
      const messageId = id();
      (data.messages[chatId] ||= []).push({ ...message, id: messageId, createdAt: Date.now() });
      if (data.chats[chatId]) data.chats[chatId].updatedAt = Date.now();
      save(); later(() => { emit.messages(chatId); emit.chats(); });
      return messageId;
    },
    async deleteMessage(chatId, messageId) {
      data.messages[chatId] = (data.messages[chatId] || []).filter((m) => m.id !== messageId);
      save(); emit.messages(chatId);
    },

    recordUsage(model, usage) {
      if (!usage) return;
      const date = dayKey();
      const day = (data.usage[date] ||= { date, byModel: {} });
      bump(day, usage);
      bump((day.byModel[model] ||= {}), usage);
      bump((data.profile.usageTotal ||= {}), usage);
      save(); emit.profile();
    },
    async loadUsage(days) {
      const start = new Date();
      start.setDate(start.getDate() - (days - 1));
      return Object.values(data.usage).filter((d) => d.date >= dayKey(start)).sort((a, b) => a.date.localeCompare(b.date));
    },
  };
}
