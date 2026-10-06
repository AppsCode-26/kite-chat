import { marked } from "https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.esm.js";
import DOMPurify from "https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.es.mjs";
import hljs from "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/es/highlight.min.js";
import { APP_NAME, FIREBASE_KEY_FILE, SETUP_LINKS, firebaseConfig } from "./config.js";
import { dayKey } from "./util.js";
import {
  DEFAULT_MODEL, FALLBACK_MODELS, GeminiError, buildSteps, describeModel, featuredModels,
  generateOnce, listModels, streamInteraction,
} from "./gemini.js";

const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";
const TIER_RANK = { "flash-lite": 0, flash: 1, pro: 2, other: 3 };
const DEFAULT_SETTINGS = { model: DEFAULT_MODEL, extendedThinking: false, theme: "dark", menuModels: null };
const MAX_IMAGES = 3;
// Base64 characters per image, so a three-image message still fits in one 1 MiB Firestore document.
const IMAGE_BUDGET = 270_000;
const KEY_HELP_URL = "https://aistudio.google.com/apikey";

const num = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

const state = {
  user: null,
  profile: {},
  profileLoaded: false,
  settings: { ...DEFAULT_SETTINGS },
  chats: [],
  chatsLoaded: false,
  chatId: null,
  messages: [],
  loadingChat: false,
  jump: false,
  temp: false,
  tempMessages: [],
  models: FALLBACK_MODELS,
  modelsKey: "",
  stream: null,
  lastError: null,
  pendingImages: [],
  search: "",
  usageRange: 30,
};
const unsub = { profile: null, chats: null, messages: null };
const nodeCache = new Map();
let backend = null;

/* ---------- Small helpers ---------- */

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid);
  return node;
}

function icon(name, cls = "") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", `i ${cls}`.trim());
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
const localId = () => Math.random().toString(36).slice(2, 12);
const isMobile = () => matchMedia("(max-width: 860px)").matches;
const isTouch = () => matchMedia("(hover: none)").matches;
const apiKey = () => state.profile.geminiKey || "";
const chatKey = () => (state.temp ? "temp" : state.chatId);
const currentMessages = () => (state.temp ? state.tempMessages : state.messages);
const busy = () => !!state.stream && !state.stream.done;
const firstName = () => (state.user?.name || "").trim().split(/\s+/)[0] || "there";
const initial = () => (state.user?.name || state.user?.email || "?").trim().charAt(0) || "?";

let toastTimer = 0;
function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3200);
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      const label = button.textContent;
      button.textContent = "Copied";
      setTimeout(() => { button.textContent = label; }, 1400);
    } else toast("Copied");
  } catch {
    toast("Couldn't copy — your browser blocked clipboard access.");
  }
}

function applyTheme(theme) {
  try { localStorage.setItem("kite.theme", theme); } catch { /* private mode */ }
  const resolved = theme === "system" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : theme;
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]').content = resolved === "light" ? "#ffffff" : "#070709";
}
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if (state.settings.theme === "system") applyTheme("system");
});

/* ---------- Markdown ---------- */

marked.setOptions({ gfm: true, breaks: true });
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});
const renderMarkdown = (text) => DOMPurify.sanitize(marked.parse(text || ""));

// Adds copy buttons to code blocks and lets wide tables scroll.
function enhance(root, highlight) {
  root.querySelectorAll("pre > code").forEach((code) => {
    const pre = code.parentElement;
    if (pre.querySelector(".code-head")) return;
    const lang = (code.className.match(/language-([\w+#-]+)/) || [])[1] || "";
    if (highlight && lang && hljs.getLanguage(lang)) {
      try { hljs.highlightElement(code); } catch { /* leave it plain */ }
    }
    const button = el("button", { type: "button", text: "Copy", onclick: () => copyText(code.textContent, button) });
    pre.prepend(el("div", { class: "code-head" }, el("span", { text: lang || "code" }), button));
  });
  root.querySelectorAll("table").forEach((table) => {
    if (table.parentElement.classList.contains("table-wrap")) return;
    const wrap = el("div", { class: "table-wrap" });
    table.replaceWith(wrap);
    wrap.append(table);
  });
}

/* ---------- Dialog and menus ---------- */

function askDialog({ title, body = "", input = null, ok = "OK", danger = false }) {
  return new Promise((resolve) => {
    const dialog = $("dialog");
    const field = $("dialogInput");
    $("dialogTitle").textContent = title;
    $("dialogBody").textContent = body;
    $("dialogBody").hidden = !body;
    field.hidden = input === null;
    field.value = input ?? "";
    $("dialogOk").textContent = ok;
    $("dialogOk").classList.toggle("is-danger", danger);
    const finish = (value) => { dialog.close(); resolve(value); };
    $("dialogForm").onsubmit = (e) => { e.preventDefault(); finish(input === null ? true : field.value.trim()); };
    $("dialogCancel").onclick = () => finish(null);
    dialog.oncancel = (e) => { e.preventDefault(); finish(null); };
    dialog.showModal();
    if (input !== null) field.select();
  });
}

let closeMenu = () => {};
function openMenu(anchor, items, { className = "", align = "left", cover = false } = {}) {
  if (anchor.getAttribute("aria-expanded") === "true") { closeMenu(); return; }
  closeMenu();
  const menu = el("div", { class: `menu ${className}`.trim(), role: "menu" });
  for (const item of items) {
    if (!item) continue;
    if (item.sep) { menu.append(el("div", { class: "menu-sep" })); continue; }
    if (item.head) { menu.append(el("div", { class: "menu-head" }, el("strong", { text: item.head }), el("span", { text: item.sub }))); continue; }
    menu.append(el("button", {
      class: `menu-item${item.danger ? " danger" : ""}`,
      role: item.checked === undefined ? "menuitem" : "menuitemradio",
      "aria-checked": item.checked === undefined ? null : String(item.checked),
      onclick: () => { closeMenu(); item.onSelect(); },
    },
      item.icon ? icon(item.icon) : item.checked ? icon("check") : el("span"),
      el("span", { class: "mi-title", text: item.title }),
      item.sub && el("span", { class: "mi-sub", text: item.sub })));
  }
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  const left = align === "right" ? rect.right - menu.offsetWidth : rect.left;
  let top = cover ? rect.top - 4 : rect.bottom + 6;
  if (top + menu.offsetHeight > innerHeight - 12) top = Math.max(12, rect.top - menu.offsetHeight - 6);
  menu.style.left = `${Math.max(12, Math.min(left, innerWidth - menu.offsetWidth - 12))}px`;
  menu.style.top = `${top}px`;
  anchor.setAttribute("aria-expanded", "true");

  const onPointer = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) closeMenu(); };
  const onKey = (e) => { if (e.key === "Escape") { closeMenu(); anchor.focus(); } };
  document.addEventListener("pointerdown", onPointer, true);
  document.addEventListener("keydown", onKey);
  closeMenu = () => {
    menu.remove();
    anchor.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onPointer, true);
    document.removeEventListener("keydown", onKey);
    closeMenu = () => {};
  };
}

/* ---------- Sign in ---------- */

let authMode = "signin";

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === "signup";
  $("authTitle").textContent = signup ? `Create your ${APP_NAME} account` : `Sign in to ${APP_NAME}`;
  $("nameField").hidden = !signup;
  $("authPassword").autocomplete = signup ? "new-password" : "current-password";
  $("authSubmit").textContent = signup ? "Create account" : "Sign in";
  $("forgotBtn").hidden = signup;
  $("switchText").textContent = signup ? "Already have an account?" : "New here?";
  $("switchMode").textContent = signup ? "Sign in" : "Create an account";
  showAuthMessage("");
}

function showAuthMessage(message, isError = true) {
  const node = $("authError");
  node.textContent = message;
  node.hidden = !message;
  node.style.color = isError ? "" : "var(--text-2)";
}

function wireAuth() {
  $("switchMode").onclick = () => setAuthMode(authMode === "signin" ? "signup" : "signin");
  $("pwToggle").onclick = () => {
    const field = $("authPassword");
    const show = field.type === "password";
    field.type = show ? "text" : "password";
    $("pwToggle").textContent = show ? "Hide" : "Show";
  };
  $("forgotBtn").onclick = async () => {
    const email = $("authEmail").value.trim();
    if (!email) { showAuthMessage("Enter your email above, then choose Forgot password."); return; }
    try {
      await backend.resetPassword(email);
      showAuthMessage(`If there's an account for ${email}, a reset link is on its way.`, false);
    } catch (err) {
      showAuthMessage(err.message);
    }
  };
  $("authForm").onsubmit = async (e) => {
    e.preventDefault();
    const name = $("authName").value.trim();
    const email = $("authEmail").value.trim();
    const password = $("authPassword").value;
    if (!email || !password) { showAuthMessage("Enter your email and password."); return; }
    if (authMode === "signup" && password.length < 6) { showAuthMessage("Use a password with at least 6 characters."); return; }
    const button = $("authSubmit");
    const label = button.textContent;
    button.disabled = true;
    button.textContent = authMode === "signup" ? "Creating account…" : "Signing in…";
    showAuthMessage("");
    try {
      if (authMode === "signup") await backend.signUp(name, email, password);
      else await backend.signIn(email, password);
      $("authPassword").value = "";
    } catch (err) {
      showAuthMessage(err.message);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  };
}

/* ---------- Session ---------- */

function onAuthChange(user) {
  const sameUser = user && state.user && user.uid === state.user.uid;
  state.user = user;
  $("boot").hidden = true;
  if (!user) {
    teardown();
    $("app").hidden = true;
    $("settings").hidden = true;
    $("auth").hidden = false;
    setAuthMode("signin");
    return;
  }
  $("auth").hidden = true;
  $("app").hidden = false;
  if (sameUser) { renderAccount(); renderEmpty(); return; }

  setSidebar(!isMobile() && localStorage.getItem("kite.sidebar") !== "0");
  unsub.profile = backend.watchProfile((profile) => {
    state.profile = profile;
    state.profileLoaded = true;
    state.settings = { ...DEFAULT_SETTINGS, ...(profile.settings || {}) };
    applyTheme(state.settings.theme);
    if (apiKey() !== state.modelsKey) refreshModels();
    renderHeader();
    renderEmpty();
    syncSettings();
  });
  unsub.chats = backend.watchChats((chats) => {
    state.chats = chats;
    state.chatsLoaded = true;
    renderChats();
  });
  renderAccount();
  renderHeader();
  renderChats();
  renderThread();
  refreshSend();
}

function teardown() {
  Object.keys(unsub).forEach((k) => { unsub[k]?.(); unsub[k] = null; });
  state.stream?.controller.abort();
  Object.assign(state, {
    profile: {}, profileLoaded: false, settings: { ...DEFAULT_SETTINGS }, chats: [], chatsLoaded: false,
    chatId: null, messages: [], loadingChat: false, temp: false, tempMessages: [], models: FALLBACK_MODELS,
    modelsKey: "", stream: null, lastError: null, pendingImages: [], search: "",
  });
  nodeCache.clear();
  closeMenu();
}

async function refreshModels() {
  const key = apiKey();
  state.modelsKey = key;
  if (!key) { state.models = FALLBACK_MODELS; return; }
  try {
    const models = await listModels(key);
    if (apiKey() !== key) return;
    if (models.length) state.models = models;
  } catch {
    state.models = FALLBACK_MODELS;
  }
  renderHeader();
  syncSettings();
}

function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  backend.saveProfile({ settings: patch });
  if (patch.theme) applyTheme(patch.theme);
  renderHeader();
}

function modelInfo(id) {
  return state.models.find((m) => m.id === id) || describeModel(id);
}

// What the model menu lists: the user's picks, or the newest of each tier.
function menuModels() {
  const picked = state.settings.menuModels;
  const list = picked?.length ? picked.map(modelInfo) : featuredModels(state.models);
  if (!list.some((m) => m.id === state.settings.model)) list.push(modelInfo(state.settings.model));
  return list.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.version - a.version);
}

/* ---------- Sidebar ---------- */

function setSidebar(open) {
  document.body.classList.toggle("sb-open", open);
  $("menuBtn").setAttribute("aria-label", open ? "Close menu" : "Open menu");
  if (!isMobile()) { try { localStorage.setItem("kite.sidebar", open ? "1" : "0"); } catch { /* private mode */ } }
}

function renderAccount() {
  $("accountAvatar").textContent = initial();
  $("topAvatar").textContent = initial();
  $("accountName").textContent = state.user?.name || state.user?.email || "";
}

function renderChats() {
  const q = state.search.trim().toLowerCase();
  const chats = q ? state.chats.filter((c) => c.title.toLowerCase().includes(q)) : state.chats;
  const pinned = chats.filter((c) => c.pinned);
  const rest = chats.filter((c) => !c.pinned);
  const nodes = [];
  if (pinned.length) nodes.push(el("div", { class: "sb-label", text: "Pinned" }), ...pinned.map(chatRow));
  nodes.push(el("div", { class: "sb-label", text: q ? "Results" : "Recents" }));
  if (rest.length) nodes.push(...rest.map(chatRow));
  else if (!pinned.length) {
    nodes.push(el("p", { class: "sb-empty", text: !state.chatsLoaded ? "Loading…" : q ? "No chats match that search." : "Your chats will show up here." }));
  }
  $("chatList").replaceChildren(...nodes);
}

function chatRow(chat) {
  const title = chat.title || "New chat";
  const more = el("button", { class: "icon-btn sm chat-more", "aria-label": `Options for ${title}`, "aria-haspopup": "menu", onclick: () => openChatMenu(more, chat) }, icon("more"));
  return el("div", { class: `chat-row${chat.id === state.chatId ? " active" : ""}` },
    el("button", { class: "chat-title", text: title, title, onclick: () => openChat(chat.id) }), more);
}

function openChatMenu(anchor, chat) {
  openMenu(anchor, [
    { icon: "edit", title: "Rename", onSelect: async () => {
      const title = await askDialog({ title: "Rename chat", input: chat.title, ok: "Rename" });
      if (title) backend.updateChat(chat.id, { title });
    } },
    { icon: "pin", title: chat.pinned ? "Unpin" : "Pin", onSelect: () => backend.updateChat(chat.id, { pinned: !chat.pinned }) },
    { icon: "trash", title: "Delete", danger: true, onSelect: async () => {
      const ok = await askDialog({ title: "Delete this chat?", body: `“${chat.title || "New chat"}” will be removed from your account on every device.`, ok: "Delete", danger: true });
      if (!ok) return;
      if (state.chatId === chat.id) newChat();
      try { await backend.deleteChat(chat.id); } catch { toast("Couldn't delete that chat. Try again."); }
    } },
  ], { align: "right" });
}

function leaveChat() {
  if (state.stream?.done) state.stream = null;
  unsub.messages?.();
  unsub.messages = null;
  nodeCache.clear();
  state.messages = [];
  state.lastError = null;
  state.loadingChat = false;
}

function openChat(chatId) {
  if (chatId === state.chatId && !state.temp) { if (isMobile()) setSidebar(false); return; }
  leaveChat();
  state.temp = false;
  state.tempMessages = [];
  state.chatId = chatId;
  state.loadingChat = true;
  state.jump = true;
  subscribeMessages(chatId);
  if (isMobile()) setSidebar(false);
  renderAll();
}

function newChat() {
  leaveChat();
  state.temp = false;
  state.tempMessages = [];
  state.chatId = null;
  if (isMobile()) setSidebar(false);
  renderAll();
  if (!isTouch()) $("input").focus();
}

function setTemp(on) {
  leaveChat();
  if (state.stream?.key === "temp") { state.stream.controller.abort(); state.stream = null; }
  state.temp = on;
  state.tempMessages = [];
  state.chatId = null;
  renderAll();
  if (!isTouch()) $("input").focus();
}

function subscribeMessages(chatId) {
  unsub.messages?.();
  unsub.messages = backend.watchMessages(chatId, (messages) => {
    if (state.chatId !== chatId) return;
    state.messages = messages;
    state.loadingChat = false;
    if (state.stream?.done && messages.some((m) => m.id === state.stream.savedId)) state.stream = null;
    renderThread();
    refreshSend();
  });
}

function renderAll() {
  renderHeader();
  renderChats();
  renderThread();
  refreshSend();
}

/* ---------- Header and model menu ---------- */

function renderHeader() {
  $("modelLabel").textContent = modelInfo(state.settings.model).label;
  $("tempBtn").hidden = state.temp || !!state.chatId;
  $("tempClose").hidden = !state.temp;
  $("avatarBtn").hidden = state.temp;
}

function openModelMenu(showAll = false) {
  const current = state.settings.model;
  const shown = showAll ? state.models : menuModels();
  const items = shown.map((m) => ({
    title: m.label + (m.preview ? " (preview)" : ""),
    sub: m.blurb,
    checked: m.id === current,
    onSelect: () => saveSettings({ model: m.id }),
  }));
  if (!showAll && state.models.length > shown.length) {
    items.push({ title: "More models", sub: `${state.models.length - shown.length} others`, onSelect: () => openModelMenu(true) });
  }
  items.push({ sep: true }, {
    title: "Extended thinking",
    sub: "Complex problem solving",
    checked: !!state.settings.extendedThinking,
    onSelect: () => saveSettings({ extendedThinking: !state.settings.extendedThinking }),
  });
  if (showAll) closeMenu();
  openMenu($("modelBtn"), items, { className: "model-menu", cover: isMobile() });
}

function openAccountMenu(anchor, align) {
  openMenu(anchor, [
    { head: state.user.name || "Account", sub: state.user.email },
    { icon: "settings", title: "Settings", onSelect: () => openSettings() },
    { icon: "logout", title: "Sign out", onSelect: () => backend.signOut() },
  ], { align });
}

/* ---------- Thread ---------- */

const isNearBottom = () => {
  const s = $("scroll");
  return s.scrollHeight - s.scrollTop - s.clientHeight < 120;
};
const scrollToBottom = () => { const s = $("scroll"); s.scrollTop = s.scrollHeight; };

function thoughtsNode(text, open = false) {
  const body = el("div", { class: "md" });
  const fill = () => { if (!body.childNodes.length) { body.innerHTML = renderMarkdown(text); enhance(body, false); } };
  const details = el("details", { class: "thoughts", ontoggle: fill }, el("summary", {}, "Show thinking", icon("chevron", "sm")), body);
  if (open) { details.open = true; fill(); }
  return details;
}

function messageNode(message, canRegenerate) {
  if (message.role === "user") {
    return el("div", { class: "msg user" },
      message.images?.length && el("div", { class: "msg-images" },
        message.images.map((img) => el("img", { src: `data:${img.mime};base64,${img.data}`, alt: "Attached image" }))),
      message.text && el("div", { class: "bubble", text: message.text }));
  }
  const body = el("div", { class: "md" });
  body.innerHTML = renderMarkdown(message.text);
  enhance(body, true);
  return el("div", { class: "msg model" },
    message.thoughts && thoughtsNode(message.thoughts),
    body,
    message.stopped && el("p", { class: "msg-note", text: "Stopped before the reply was finished." }),
    el("div", { class: "msg-actions" },
      el("button", { class: "icon-btn", "aria-label": "Copy reply", title: "Copy", onclick: () => copyText(message.text) }, icon("copy")),
      canRegenerate && el("button", { class: "icon-btn", "aria-label": "Regenerate reply", title: "Regenerate", onclick: () => regenerate(message) }, icon("refresh")),
      message.model && el("span", { class: "msg-model", text: describeModel(message.model).label })));
}

function noticeNode(message, action) {
  return el("div", { class: "msg-error" }, el("p", { text: message }), el("button", { class: "btn", text: action, onclick: retry }));
}

function buildStreamNode() {
  const stream = state.stream;
  stream.label = el("span", { text: "Thinking…" });
  stream.status = el("div", { class: "stream-status" }, el("span", { class: "dots" }), stream.label);
  stream.body = el("div", { class: "md" });
  stream.node = el("div", { class: "msg model" }, stream.status, stream.body);
  paintStream();
  return stream.node;
}

function paintStream() {
  const stream = state.stream;
  if (!stream?.node) return;
  const pinned = isNearBottom();
  if (stream.text) {
    stream.status.hidden = true;
    stream.body.innerHTML = renderMarkdown(stream.text);
    enhance(stream.body, stream.done);
  } else if (stream.thoughts) {
    // Thought summaries open with a bold heading — show the latest one as live status.
    const headings = [...stream.thoughts.matchAll(/\*\*(.+?)\*\*/g)];
    if (headings.length) stream.label.textContent = headings[headings.length - 1][1];
  }
  if (pinned) scrollToBottom();
}

let paintQueued = false;
function schedulePaint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => { paintQueued = false; paintStream(); });
}

function renderThread() {
  const pinned = isNearBottom();
  const messages = currentMessages();
  const streamHere = state.stream && state.stream.key === chatKey();
  const nodes = messages.map((m, i) => {
    const canRegenerate = m.role === "model" && i === messages.length - 1 && !state.stream;
    const sig = `${m.text?.length || 0}|${m.thoughts?.length || 0}|${canRegenerate}`;
    let entry = nodeCache.get(m.id);
    if (!entry || entry.sig !== sig) {
      entry = { sig, node: messageNode(m, canRegenerate) };
      nodeCache.set(m.id, entry);
    }
    return entry.node;
  });
  if (streamHere) nodes.push(state.stream.node || buildStreamNode());
  else if (!state.stream && !state.loadingChat) {
    if (state.lastError?.key === chatKey()) nodes.push(noticeNode(state.lastError.message, "Try again"));
    else if (messages[messages.length - 1]?.role === "user") nodes.push(noticeNode("This message doesn't have a reply yet.", "Get reply"));
  }
  $("thread").replaceChildren(...nodes);
  renderEmpty();
  if (state.jump || pinned) scrollToBottom();
  if (messages.length) state.jump = false;
}

function renderEmpty() {
  const empty = $("empty");
  const isEmpty = !currentMessages().length && !(state.stream && state.stream.key === chatKey()) && !state.loadingChat && state.lastError?.key !== chatKey();
  $("main").classList.toggle("is-empty", isEmpty);
  empty.hidden = !isEmpty;
  if (!isEmpty) { empty.dataset.sig = ""; return; }
  const kind = !state.profileLoaded ? "loading" : !apiKey() ? "key" : state.temp ? "temp" : "hello";
  const sig = `${kind}|${firstName()}`;
  if (empty.dataset.sig === sig) return; // don't rebuild under someone typing their key
  empty.dataset.sig = sig;
  empty.className = kind === "temp" ? "empty centered" : "empty";

  if (kind === "loading") { empty.replaceChildren(); return; }
  if (kind === "temp") {
    empty.replaceChildren(icon("temp"), el("h2", { text: "Just stopping by?" }),
      el("p", { text: "Temporary chats aren't saved to your account and won't appear in your recent chats. They're gone when you leave." }));
    return;
  }
  const greeting = [el("h1", { class: "greeting", text: `Hello, ${firstName()}` })];
  if (kind === "hello") {
    empty.replaceChildren(...greeting, el("p", { class: "greeting-sub", text: "What's on your mind?" }));
    return;
  }
  const status = el("p", { class: "status", role: "status" });
  const field = el("input", { class: "input", type: "password", placeholder: "Gemini API key", "aria-label": "Gemini API key", autocomplete: "off", spellcheck: "false" });
  const button = el("button", { class: "btn primary", type: "submit", text: "Save key" });
  const form = el("form", { class: "key-row", onsubmit: async (e) => {
    e.preventDefault();
    button.disabled = true;
    await saveKey(field.value, status);
    button.disabled = false;
  } }, field, button);
  empty.replaceChildren(...greeting, el("div", { class: "key-card" },
    el("h2", { text: "Add your Gemini API key" }),
    el("p", { text: "Paste it once. It's saved to your account, so it's ready on every device you sign in on." }),
    form, status,
    el("a", { class: "link-btn", href: KEY_HELP_URL, target: "_blank", rel: "noopener", text: "Get a key from Google AI Studio" })));
}

async function saveKey(raw, status) {
  const key = raw.trim();
  const say = (text, cls = "") => { status.textContent = text; status.className = `status ${cls}`.trim(); };
  if (!key) { say("Paste your key first.", "bad"); return false; }
  say("Checking the key…");
  try {
    const models = await listModels(key);
    state.models = models.length ? models : FALLBACK_MODELS;
    state.modelsKey = key;
  } catch (err) {
    say(err instanceof GeminiError && err.kind === "auth"
      ? "Gemini didn't accept that key. Check that you copied all of it."
      : "Couldn't check the key. Check your connection and try again.", "bad");
    return false;
  }
  state.profile = { ...state.profile, geminiKey: key };
  backend.saveProfile({ geminiKey: key });
  say(`A key ending in ${key.slice(-4)} is saved.`, "ok");
  toast("API key saved to your account");
  renderHeader();
  renderEmpty();
  return true;
}

/* ---------- Sending ---------- */

function explain(err, model) {
  if (!(err instanceof GeminiError)) return navigator.onLine ? "Couldn't reach Gemini. Try again." : "You're offline. Reconnect and try again.";
  const name = describeModel(model).label;
  switch (err.kind) {
    case "auth": return "Gemini rejected your API key. Check it in Settings.";
    case "quota": return `You've hit the rate limit or quota for ${name}. Wait a moment, or switch models.`;
    case "busy": return `${name} is overloaded right now. Try again, or switch models.`;
    case "model": return `${name} isn't available with this key. Pick another model.`;
    default: return err.message;
  }
}

async function submit() {
  const input = $("input");
  const text = input.value.trim();
  const images = state.pendingImages.map(({ mime, data }) => ({ mime, data }));
  if ((!text && !images.length) || state.stream) return;
  if (!apiKey()) { toast("Add your Gemini API key first."); if (currentMessages().length) openSettings("key"); return; }

  input.value = "";
  state.pendingImages = [];
  renderAttachments();
  autosize();

  const message = clean({ role: "user", text, images: images.length ? images : undefined });
  const history = [...currentMessages(), message];
  if (state.temp) {
    state.tempMessages.push({ ...message, id: localId() });
  } else {
    if (!state.chatId) {
      state.chatId = backend.createChat({ title: provisionalTitle(text), model: state.settings.model });
      subscribeMessages(state.chatId);
    }
    backend.addMessage(state.chatId, message);
  }
  state.jump = true;
  await reply(history);
}

// A new chat is listed under its first message until a proper title is generated.
const provisionalTitle = (text) => text.slice(0, 60) || "Image";

async function reply(history) {
  const key = chatKey();
  const { chatId, temp } = state;
  const model = state.settings.model;
  const controller = new AbortController();
  const stream = { key, text: "", thoughts: "", controller, done: false, node: null };
  state.stream = stream;
  state.lastError = null;
  renderAll();
  scrollToBottom();

  let result = null;
  let failure = null;
  try {
    result = await streamInteraction({
      apiKey: apiKey(),
      model,
      steps: buildSteps(history),
      thinkingLevel: state.settings.extendedThinking ? "high" : undefined,
      signal: controller.signal,
      onUpdate: (out) => { stream.text = out.text; stream.thoughts = out.thoughts; schedulePaint(); },
    });
  } catch (err) {
    failure = err;
  }
  if (state.stream !== stream) return; // signed out or left a temporary chat mid-reply

  const stopped = controller.signal.aborted;
  const text = result?.text ?? stream.text;
  if (result?.usage) backend.recordUsage(model, result.usage);

  if (!text) {
    state.stream = null;
    if (!stopped) {
      state.lastError = { key, message: failure ? explain(failure, model) : "The model sent back an empty reply. Try rephrasing, or switch models." };
    }
    renderAll();
    return;
  }

  const message = clean({
    role: "model",
    text,
    thoughts: (result?.thoughts ?? stream.thoughts) || undefined,
    model,
    usage: result?.usage || undefined,
    stopped: stopped || failure ? true : undefined,
  });
  if (temp) {
    state.tempMessages.push({ ...message, id: localId() });
    state.stream = null;
  } else {
    // Keep showing the streamed reply until the saved copy arrives from the store.
    stream.savedId = backend.addMessage(chatId, message);
    stream.done = true;
    stream.text = text;
    paintStream();
    if (state.chatId !== chatId) state.stream = null;
    else setTimeout(() => { if (state.stream === stream) { state.stream = null; renderAll(); } }, 1500);
  }
  if (failure && !stopped) toast(explain(failure, model));
  renderAll();

  // First reply in a chat that still carries its provisional title: name it properly.
  if (!temp && !history.some((m) => m.role === "model")) {
    const firstText = history.find((m) => m.role === "user")?.text || "";
    const chat = state.chats.find((c) => c.id === chatId);
    if (!chat || chat.title === provisionalTitle(firstText)) nameChat(chatId, firstText, text);
  }
}

function retry() {
  if (busy()) return;
  const messages = currentMessages();
  if (messages[messages.length - 1]?.role !== "user") return;
  reply(messages.slice());
}

function regenerate(message) {
  if (state.stream) return;
  const messages = currentMessages();
  const index = messages.findIndex((m) => m.id === message.id);
  if (index < 0) return;
  const history = messages.slice(0, index);
  nodeCache.delete(message.id);
  if (state.temp) state.tempMessages = history.slice();
  else backend.deleteMessage(state.chatId, message.id);
  reply(history);
}

// Replaces the provisional title (the first message) with a short generated one.
async function nameChat(chatId, userText, replyText) {
  const model = featuredModels(state.models)[0]?.id || state.settings.model;
  const input = "Write a short title (3 to 6 words) for a chat that opens like this. Reply with the title only: no quotes, no trailing punctuation.\n\n"
    + `User: ${userText.slice(0, 600) || "(sent an image)"}\n\nAssistant: ${replyText.slice(0, 600)}`;
  try {
    const { text, usage } = await generateOnce({ apiKey: apiKey(), model, input });
    if (usage) backend.recordUsage(model, usage);
    const title = text.trim().split("\n")[0].replace(/^["'“”*#\s]+|["'“”*.\s]+$/g, "").slice(0, 80);
    if (title) backend.updateChat(chatId, { title });
  } catch {
    /* the provisional title stays */
  }
}

/* ---------- Composer ---------- */

function autosize() {
  const input = $("input");
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
}

function refreshSend() {
  const streaming = busy();
  $("sendIcon").setAttribute("href", streaming ? "#i-stop" : "#i-send");
  $("sendBtn").setAttribute("aria-label", streaming ? "Stop" : "Send");
  $("sendBtn").disabled = !streaming && !$("input").value.trim() && !state.pendingImages.length;
}

function renderAttachments() {
  const row = $("attachRow");
  row.hidden = !state.pendingImages.length;
  row.replaceChildren(...state.pendingImages.map((img, i) => el("div", { class: "attach" },
    el("img", { src: img.url, alt: `Attachment ${i + 1}` }),
    el("button", { type: "button", "aria-label": `Remove attachment ${i + 1}`, onclick: () => {
      state.pendingImages.splice(i, 1);
      renderAttachments();
      refreshSend();
    } }, icon("close")))));
}

async function compressImage(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => createImageBitmap(file));
  const attempts = [[1280, 0.82], [1024, 0.76], [768, 0.7], [512, 0.6]];
  for (const [maxSide, quality] of attempts) {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = el("canvas", { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/jpeg", quality);
    const data = url.slice(url.indexOf(",") + 1);
    if (data.length <= IMAGE_BUDGET || maxSide === 512) return { mime: "image/jpeg", data, url };
  }
}

async function addImages(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith("image/"));
  const room = MAX_IMAGES - state.pendingImages.length;
  if (files.length > room) toast(`You can attach up to ${MAX_IMAGES} images per message.`);
  for (const file of files.slice(0, Math.max(0, room))) {
    try { state.pendingImages.push(await compressImage(file)); } catch { toast("That image couldn't be read."); }
  }
  renderAttachments();
  refreshSend();
}

function wireDictation() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const button = $("micBtn");
  if (!Recognition) { button.hidden = true; return; }
  let recognition = null;
  button.onclick = () => {
    if (recognition) { recognition.stop(); return; }
    const input = $("input");
    const base = input.value ? `${input.value.replace(/\s+$/, "")} ` : "";
    recognition = new Recognition();
    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = true;
    recognition.onresult = (e) => {
      input.value = base + [...e.results].map((r) => r[0].transcript).join("");
      autosize();
      refreshSend();
    };
    recognition.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") toast("Microphone access is blocked for this site.");
    };
    recognition.onend = () => { recognition = null; button.setAttribute("aria-pressed", "false"); };
    button.setAttribute("aria-pressed", "true");
    try { recognition.start(); } catch { recognition = null; button.setAttribute("aria-pressed", "false"); }
  };
}

/* ---------- Settings ---------- */

const settingsOpen = () => !$("settings").hidden;

function openSettings(focus) {
  closeMenu();
  $("settings").hidden = false;
  $("settingsBody").replaceChildren(accountSection(), modelsSection(), keySection(), usageSection(), appearanceSection(), dataSection());
  if (focus) $(`set-${focus}`)?.scrollIntoView();
  else $("settingsBody").scrollTop = 0;
  loadUsage();
}

function closeSettings() {
  $("settings").hidden = true;
  $("settingsBody").replaceChildren();
}

// Re-renders the sections that mirror synced state, unless someone is typing in one.
function syncSettings() {
  if (!settingsOpen()) return;
  for (const [id, build] of [["models", modelsSection], ["key", keySection], ["appearance", appearanceSection]]) {
    const current = $(`set-${id}`);
    if (current && !current.contains(document.activeElement)) current.replaceWith(build());
  }
}

function section(id, title, ...kids) {
  return el("section", { class: "set-section", id: `set-${id}` }, title && el("h3", { text: title }), ...kids);
}

function row(title, sub, control) {
  return el("div", { class: "row" },
    el("div", { class: "row-text" }, el("div", { class: "row-title", text: title }), sub && el("div", { class: "row-sub", text: sub })),
    control);
}

function segmented(options, value, onPick) {
  const group = el("div", { class: "seg", role: "group" }, options.map(([v, label]) =>
    el("button", { type: "button", text: label, "aria-pressed": String(v === value), onclick: (e) => {
      for (const b of group.children) b.setAttribute("aria-pressed", String(b === e.currentTarget));
      onPick(v);
    } })));
  return group;
}

function accountSection() {
  const field = el("input", { class: "input", type: "text", value: state.user.name || "", maxlength: "60", "aria-label": "Name", autocomplete: "name" });
  const form = el("form", { class: "inline-form", onsubmit: async (e) => {
    e.preventDefault();
    const name = field.value.trim();
    if (!name) return;
    await backend.updateName(name);
    toast("Name updated");
  } }, field, el("button", { class: "btn", type: "submit", text: "Save" }));
  return section("account", "Account",
    el("div", { class: "card" },
      el("div", { class: "row stack" }, el("div", { class: "row-title", text: "Name" }), form),
      row(state.user.email, "Signed in on this device", el("button", { class: "btn", text: "Sign out", onclick: () => backend.signOut() })),
      row("Password", "Get an email with a link to set a new one.", el("button", { class: "btn", text: "Send link", onclick: async () => {
        try { await backend.resetPassword(state.user.email); toast(`Reset link sent to ${state.user.email}`); } catch (err) { toast(err.message); }
      } }))));
}

function modelsSection() {
  const current = state.settings.model;
  const all = state.models.some((m) => m.id === current) ? state.models : [...state.models, modelInfo(current)];
  const select = el("select", { class: "input", "aria-label": "Default model", onchange: () => saveSettings({ model: select.value }) },
    all.map((m) => el("option", { value: m.id, selected: m.id === current, text: `${m.label}${m.preview ? " (preview)" : ""}${m.blurb ? ` — ${m.blurb}` : ""}` })));
  const thinking = el("input", { class: "switch", type: "checkbox", role: "switch", "aria-label": "Extended thinking", checked: !!state.settings.extendedThinking,
    onchange: () => saveSettings({ extendedThinking: thinking.checked }) });

  const isCustom = () => !!state.settings.menuModels?.length;
  const shown = new Set(isCustom() ? state.settings.menuModels : featuredModels(state.models).map((m) => m.id));
  const note = el("div", { class: "row-sub" });
  const reset = el("button", { class: "link-btn", type: "button", text: "Go back to automatic", onclick: () => {
    saveSettings({ menuModels: null });
    $("set-models").replaceWith(modelsSection());
  } });
  const refreshNote = () => {
    note.textContent = isCustom() ? "Showing your picks." : "Automatic: the newest Flash-Lite, Flash and Pro.";
    reset.hidden = !isCustom();
  };
  const list = el("div", { class: "check-list" }, state.models.map((m) => {
    const box = el("input", { type: "checkbox", value: m.id, checked: shown.has(m.id), onchange: () => {
      const picked = [...list.querySelectorAll("input:checked")].map((b) => b.value);
      saveSettings({ menuModels: picked.length ? picked : null });
      refreshNote();
    } });
    return el("label", { class: "check" }, box, el("span", {}, m.label, m.preview && el("small", { text: " preview" })));
  }));
  refreshNote();

  return section("models", "Models",
    el("div", { class: "card" },
      el("div", { class: "row stack" }, el("div", { class: "row-title", text: "Model" }), select),
      row("Extended thinking", "Reasons for longer on every reply. Uses more tokens.", thinking),
      el("div", { class: "row stack" },
        el("div", { class: "row-text" }, el("div", { class: "row-title", text: "Models in the menu" }), note),
        list, reset)));
}

function keySection() {
  const key = apiKey();
  const status = el("p", { class: "status", role: "status", text: key ? `A key ending in ${key.slice(-4)} is saved. ${state.models.length} chat models available.` : "No key saved yet." });
  const field = el("input", { class: "input", type: "password", value: key, placeholder: "Gemini API key", "aria-label": "Gemini API key", autocomplete: "off", spellcheck: "false" });
  const reveal = el("button", { class: "btn", type: "button", text: "Show", onclick: () => {
    const show = field.type === "password";
    field.type = show ? "text" : "password";
    reveal.textContent = show ? "Hide" : "Show";
  } });
  const save = el("button", { class: "btn primary", type: "submit", text: "Save" });
  const form = el("form", { class: "inline-form", onsubmit: async (e) => {
    e.preventDefault();
    save.disabled = true;
    const saved = await saveKey(field.value, status);
    save.disabled = false;
    if (saved && !key) $("set-key").replaceWith(keySection());
  } }, field, reveal, save);
  return section("key", "Gemini API key",
    el("div", { class: "card" },
      el("div", { class: "row stack" },
        el("div", { class: "row-sub", text: "Saved to your account and used on every device you sign in on. Messages go straight from your browser to Google." }),
        form, status,
        el("a", { class: "link-btn", href: KEY_HELP_URL, target: "_blank", rel: "noopener", text: "Get a key from Google AI Studio" })),
      key && row("Remove key", "You won't be able to send messages until you add one again.", el("button", { class: "btn danger", text: "Remove", onclick: async () => {
        const ok = await askDialog({ title: "Remove your API key?", body: "It will be removed from your account on every device.", ok: "Remove", danger: true });
        if (!ok) return;
        state.profile = { ...state.profile, geminiKey: "" };
        backend.saveProfile({ geminiKey: "" });
        $("set-key").replaceWith(keySection());
        renderEmpty();
        toast("API key removed");
      } }))));
}

function appearanceSection() {
  return section("appearance", "Appearance",
    el("div", { class: "card" },
      row("Theme", null, segmented([["dark", "Dark"], ["light", "Light"], ["system", "System"]], state.settings.theme, (theme) => saveSettings({ theme })))));
}

function dataSection() {
  return section("data", "Your data",
    el("div", { class: "card" },
      row("Delete all chats", "Removes every chat from your account on all devices.", el("button", { class: "btn danger", text: "Delete all", onclick: async () => {
        const ok = await askDialog({ title: "Delete all chats?", body: `All ${state.chats.length} of your chats will be permanently removed from your account. This can't be undone.`, ok: "Delete all", danger: true });
        if (!ok) return;
        newChat();
        try { await backend.deleteAllChats(); toast("All chats deleted"); } catch { toast("Couldn't delete everything. Try again."); }
      } }))));
}

/* ---------- Usage ---------- */

function usageSection() {
  const ranges = [[7, "7 days"], [30, "30 days"], [90, "90 days"]];
  const head = el("div", { class: "usage-head" }, el("h3", { text: "Usage" }),
    segmented(ranges, state.usageRange, (days) => { state.usageRange = days; loadUsage(); }));
  return el("section", { class: "set-section", id: "set-usage" }, head,
    el("div", { class: "usage", id: "usageBody" }, el("p", { class: "usage-note", text: "Loading usage…" })));
}

async function loadUsage() {
  const days = state.usageRange;
  let rows;
  try {
    rows = await backend.loadUsage(days);
  } catch {
    $("usageBody")?.replaceChildren(el("p", { class: "usage-note", text: "Usage couldn't be loaded. Check your connection and reopen Settings." }));
    return;
  }
  const host = $("usageBody");
  if (!host || days !== state.usageRange) return;

  const byDate = new Map(rows.map((r) => [r.date, r]));
  const series = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const r = byDate.get(dayKey(date)) || {};
    series.push({ date, requests: r.requests || 0, input: r.input || 0, output: r.output || 0, thoughts: r.thoughts || 0, total: r.total || 0 });
  }
  const sum = (key) => series.reduce((n, d) => n + d[key], 0);
  const today = series[series.length - 1];
  const models = new Map();
  for (const r of rows) {
    for (const [id, u] of Object.entries(r.byModel || {})) {
      const m = models.get(id) || { requests: 0, input: 0, output: 0, thoughts: 0, total: 0 };
      for (const k of Object.keys(m)) m[k] += u[k] || 0;
      models.set(id, m);
    }
  }

  const tile = (label, value, sub) => el("div", { class: "tile" },
    el("div", { class: "tile-label", text: label }), el("div", { class: "tile-value", text: value }), el("div", { class: "tile-sub", text: sub }));
  const columns = [["requests", "Requests"], ["input", "Input"], ["output", "Output"], ["thoughts", "Thinking"], ["total", "Total"]];
  const table = (first, body) => el("div", { class: "table-card" }, el("table", { class: "usage-table" },
    el("thead", {}, el("tr", {}, [first, ...columns.map(([, label]) => label)].map((h) => el("th", { scope: "col", text: h })))),
    el("tbody", {}, body.map(([name, u]) => el("tr", {}, el("td", { text: name }),
      columns.map(([k, label]) => el("td", { "data-label": label, text: num.format(u[k]) })))))));

  const allTime = state.profile.usageTotal;
  const nodes = [
    el("div", { class: "tiles" },
      tile("Total tokens", compact.format(sum("total")), `${num.format(today.total)} today`),
      tile("Requests", num.format(sum("requests")), `${num.format(today.requests)} today`),
      tile("Input tokens", compact.format(sum("input")), "Sent to the model"),
      tile("Output tokens", compact.format(sum("output")), `+ ${compact.format(sum("thoughts"))} thinking`)),
    usageChart(series),
  ];
  if (models.size) {
    const sorted = [...models].sort((a, b) => b[1].total - a[1].total).map(([id, u]) => [describeModel(id).label, u]);
    nodes.push(table("Model", sorted));
    const daily = series.filter((d) => d.requests).reverse().map((d) => [shortDate.format(d.date), d]);
    nodes.push(el("details", {}, el("summary", { text: "Day-by-day table" }), table("Day", daily)));
  }
  nodes.push(el("p", { class: "usage-note" },
    allTime?.requests ? `All time: ${num.format(allTime.total || 0)} tokens across ${num.format(allTime.requests)} requests. ` : "",
    `Counted from what this account sends through ${APP_NAME}. Google AI Studio has the official numbers for the key itself.`));
  host.replaceChildren(...nodes);
}

function niceCeil(value) {
  const power = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 5, 10].map((m) => m * power).find((v) => v >= value);
}

// Column chart of total tokens per day. One series, so no legend: the title names it.
function usageChart(series) {
  const wrap = el("div", { class: "viz" }, el("p", { class: "viz-title", text: "Tokens per day" }));
  if (!series.some((d) => d.total)) {
    wrap.append(el("p", { class: "viz-empty", text: "No usage in this range yet." }));
    return wrap;
  }
  const holder = el("div");
  const tip = el("div", { class: "viz-tip", hidden: true });
  wrap.append(holder, tip);

  const draw = (width) => {
    const height = 190;
    const pad = { left: 44, right: 6, top: 10, bottom: 24 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const max = niceCeil(Math.max(...series.map((d) => d.total)));
    const band = plotW / series.length;
    const barW = Math.max(1, Math.min(24, band - 2));
    const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width, height, role: "group", "aria-label": "Tokens per day" });

    for (const f of [0, 0.5, 1]) {
      const y = pad.top + plotH * (1 - f);
      svg.append(svgEl("line", { class: "grid", x1: pad.left, x2: width - pad.right, y1: y, y2: y }));
      const label = svgEl("text", { class: "axis-label", x: pad.left - 8, y, dy: "0.32em", "text-anchor": "end" });
      label.textContent = compact.format(max * f);
      svg.append(label);
    }

    const labelEvery = Math.max(1, Math.ceil(series.length / Math.max(2, Math.floor(plotW / 58))));
    const bars = [];
    series.forEach((d, i) => {
      const cx = pad.left + band * (i + 0.5);
      const h = d.total ? Math.max(2, (d.total / max) * plotH) : 0;
      const x = cx - barW / 2;
      const top = pad.top + plotH - h;
      const base = pad.top + plotH;
      const r = Math.min(4, barW / 2, h);
      const bar = svgEl("path", { class: "bar", d: `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + barW - r}Q${x + barW},${top} ${x + barW},${top + r}V${base}Z` });
      bars.push(bar);
      if (h) svg.append(bar);
      if ((series.length - 1 - i) % labelEvery === 0) {
        const label = svgEl("text", { class: "axis-label", x: cx, y: height - 6, "text-anchor": "middle" });
        label.textContent = shortDate.format(d.date);
        svg.append(label);
      }
      const requests = `${num.format(d.requests)} ${d.requests === 1 ? "request" : "requests"}`;
      const hit = svgEl("rect", { class: "hit", x: pad.left + band * i, y: pad.top, width: band, height: plotH, tabindex: 0, role: "img",
        "aria-label": `${shortDate.format(d.date)}: ${num.format(d.total)} tokens, ${requests}` });
      const show = () => {
        bars.forEach((b) => b.classList.toggle("is-active", b === bar));
        tip.replaceChildren(el("strong", { text: `${num.format(d.total)} tokens` }), `${shortDate.format(d.date)} · ${requests}`);
        tip.hidden = false;
        const half = tip.offsetWidth / 2;
        tip.style.left = `${Math.max(half + 4, Math.min(holder.offsetLeft + cx, wrap.clientWidth - half - 4))}px`;
        tip.style.top = `${holder.offsetTop + top}px`;
      };
      const hide = () => { bar.classList.remove("is-active"); tip.hidden = true; };
      hit.addEventListener("pointerenter", show);
      hit.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hide(); });
      hit.addEventListener("focus", show);
      hit.addEventListener("blur", hide);
      svg.append(hit);
    });
    holder.replaceChildren(svg);
  };

  let lastWidth = 0;
  new ResizeObserver(() => {
    const width = Math.floor(holder.clientWidth);
    if (width > 0 && width !== lastWidth) { lastWidth = width; draw(width); }
  }).observe(holder);
  return wrap;
}

/* ---------- Wiring ---------- */

function wireApp() {
  const input = $("input");
  $("menuBtn").onclick = () => setSidebar(!document.body.classList.contains("sb-open"));
  $("sbClose").onclick = () => setSidebar(false);
  $("scrim").onclick = () => setSidebar(false);
  $("newChat").onclick = newChat;
  $("tempBtn").onclick = () => setTemp(true);
  $("tempClose").onclick = () => setTemp(false);
  $("modelBtn").onclick = () => openModelMenu();
  $("avatarBtn").onclick = () => openAccountMenu($("avatarBtn"), "right");
  $("accountBtn").onclick = () => openAccountMenu($("accountBtn"), "left");
  $("settingsBtn").onclick = () => openSettings();
  $("settingsClose").onclick = closeSettings;
  $("settings").addEventListener("pointerdown", (e) => { if (e.target === $("settings")) closeSettings(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && settingsOpen() && !$("dialog").open) closeSettings();
  });

  const closeSearch = () => {
    state.search = "";
    $("searchInput").value = "";
    $("searchBox").hidden = true;
    $("searchBtn").hidden = false;
    renderChats();
  };
  $("searchBtn").onclick = () => {
    $("searchBtn").hidden = true;
    $("searchBox").hidden = false;
    $("searchInput").focus();
  };
  $("searchClose").onclick = closeSearch;
  $("searchInput").oninput = (e) => { state.search = e.target.value; renderChats(); };
  $("searchInput").onkeydown = (e) => { if (e.key === "Escape") closeSearch(); };

  input.addEventListener("input", () => { autosize(); refreshSend(); });
  input.addEventListener("keydown", (e) => {
    // On phones Return adds a line; the send button sends.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !isTouch()) { e.preventDefault(); submit(); }
  });
  input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) { e.preventDefault(); addImages(files); }
  });
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    if (busy()) state.stream.controller.abort();
    else submit();
  });
  $("attachBtn").onclick = () => $("fileInput").click();
  $("fileInput").onchange = (e) => { addImages(e.target.files); e.target.value = ""; };
  wireDictation();
}

let lastSyncToast = 0;
function onBackendError(err) {
  console.error(err);
  if (!state.user || Date.now() - lastSyncToast < 8000) return;
  lastSyncToast = Date.now();
  toast(err?.code === "permission-denied" ? "The cloud refused that request. Try signing out and back in." : "Couldn't sync with the cloud. Changes will retry when you're back online.");
}

// The Firebase config with its web API key filled in, or null if the key isn't available yet.
async function loadFirebaseConfig() {
  if (!firebaseConfig) return null;
  if (firebaseConfig.apiKey) return firebaseConfig;
  try {
    const res = await fetch(FIREBASE_KEY_FILE, { cache: "no-store" });
    if (!res.ok) return null;
    const text = await res.text();
    const match = text.match(/apiKey["']?\s*[:=]\s*["']([^"']+)["']/) || text.match(/([A-Za-z0-9_-]{30,})/);
    return match ? { ...firebaseConfig, apiKey: match[1] } : null;
  } catch {
    return null;
  }
}

async function pickBackend() {
  const local = ["localhost", "127.0.0.1"].includes(location.hostname) && new URLSearchParams(location.search).has("local");
  if (local) return (await import("./backend-local.js")).createBackend();
  const config = await loadFirebaseConfig();
  if (config) return (await import("./backend-firebase.js")).createBackend(config, { onError: onBackendError });
  return null;
}

document.title = APP_NAME;
document.querySelectorAll("[data-app-name]").forEach((node) => { node.textContent = APP_NAME; });
backend = await pickBackend();
if (!backend) {
  $("boot").hidden = true;
  $("setup").hidden = false;
  $("setupFirebase").href = SETUP_LINKS.firebase;
  $("setupGithub").href = SETUP_LINKS.github;
} else {
  wireAuth();
  wireApp();
  backend.onAuth(onAuthChange);
}
