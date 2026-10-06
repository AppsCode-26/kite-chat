// Browser client for the Gemini Interactions API (no SDK, no build step).
// Conversations are sent statelessly: the full history goes up with every
// request and nothing is stored on Google's side (store: false).

const BASE = "https://generativelanguage.googleapis.com/v1beta";

export const DEFAULT_MODEL = "gemini-3.6-flash";

const TIERS = {
  "flash-lite": { name: "Flash-Lite", blurb: "Fastest answers", rank: 0 },
  flash: { name: "Flash", blurb: "All-around help", rank: 1 },
  pro: { name: "Pro", blurb: "Advanced reasoning", rank: 2 },
};

export class GeminiError extends Error {
  constructor(message, { status = 0, code = "", kind = "unknown" } = {}) {
    super(message);
    this.name = "GeminiError";
    this.status = status;
    this.code = code;
    this.kind = kind; // auth | quota | busy | model | invalid | unknown
    this.partial = false;
  }
}

/** Turns a model id into what the UI shows: "gemini-3.6-flash" → "3.6 Flash". */
export function describeModel(id = "", displayName = "") {
  let m = /^gemini-(\d+(?:\.\d+)?)-(flash-lite|flash|pro)(-preview)?$/.exec(id);
  if (m) {
    const tier = TIERS[m[2]];
    return { id, version: parseFloat(m[1]), tier: m[2], label: `${m[1]} ${tier.name}`, blurb: tier.blurb, preview: !!m[3], alias: false };
  }
  m = /^gemini-(flash-lite|flash|pro)-latest$/.exec(id);
  if (m) {
    const tier = TIERS[m[1]];
    return { id, version: 0, tier: m[1], label: `${tier.name} (latest)`, blurb: `Always the newest ${tier.name}`, preview: false, alias: true };
  }
  const label = (displayName || id).replace(/^gemini[\s-]+/i, "") || id;
  return { id, version: 0, tier: "other", label, blurb: "", preview: /preview/.test(id), alias: false };
}

export const FALLBACK_MODELS = ["gemini-3.1-pro-preview", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"].map((id) => describeModel(id));

function sortModels(models) {
  return models.sort((a, b) => a.alias - b.alias || b.version - a.version || (TIERS[b.tier]?.rank ?? -1) - (TIERS[a.tier]?.rank ?? -1) || a.id.localeCompare(b.id));
}

/** The newest model of each tier, in menu order: Flash-Lite, Flash, Pro. */
export function featuredModels(models) {
  return ["flash-lite", "flash", "pro"]
    .map((tier) => models.filter((m) => m.tier === tier && !m.alias).sort((a, b) => b.version - a.version || a.preview - b.preview)[0])
    .filter(Boolean);
}

/** Text chat models this key can use, newest first. */
export async function listModels(apiKey, signal) {
  const res = await fetch(`${BASE}/models?pageSize=1000`, { headers: { "x-goog-api-key": apiKey }, signal });
  if (!res.ok) throw await errorFrom(res);
  const data = await res.json();
  const notChat = /(tts|image|embedding|live|audio|transcribe|robotics|computer-use|customtools|omni)/;
  const ids = new Set();
  const out = [];
  for (const m of data.models || []) {
    const id = String(m.name || "").replace(/^models\//, "");
    if (!id.startsWith("gemini-") || notChat.test(id)) continue;
    if (!(m.supportedGenerationMethods || []).includes("generateContent")) continue;
    ids.add(id);
    out.push({ ...describeModel(id, m.displayName), description: m.description || "" });
  }
  // A preview with a stable twin is just noise in the list.
  return sortModels(out.filter((m) => !(m.id.endsWith("-preview") && ids.has(m.id.slice(0, -"-preview".length)))));
}

/** Stored chat messages → the step array the API expects. */
export function buildSteps(messages) {
  const steps = [];
  for (const m of messages) {
    if (m.role === "user") {
      const content = [];
      for (const img of m.images || []) content.push({ type: "image", mime_type: img.mime, data: img.data });
      if (m.text) content.push({ type: "text", text: m.text });
      if (!content.length) continue;
      const prev = steps[steps.length - 1];
      if (prev?.type === "user_input") prev.content.push(...content);
      else steps.push({ type: "user_input", content });
    } else if (m.text) {
      steps.push({ type: "model_output", content: [{ type: "text", text: m.text }] });
    }
  }
  return steps;
}

function normalizeUsage(u) {
  if (!u) return null;
  return {
    input: u.total_input_tokens || 0,
    output: u.total_output_tokens || 0,
    thoughts: u.total_thought_tokens || 0,
    total: u.total_tokens || 0,
  };
}

function toError(message, status, code) {
  const c = String(code || "").toLowerCase();
  const text = `${c} ${String(message || "").toLowerCase()}`;
  let kind = "unknown";
  if (status === 401 || status === 403 || /unauthenticated|permission_denied|api key|api_key/.test(text)) kind = "auth";
  else if (status === 429 || /resource_exhausted|rate limit|quota/.test(text)) kind = "quota";
  else if (status === 503 || status === 500 || /unavailable|overloaded|high demand|internal/.test(text)) kind = "busy";
  else if (status === 404 || /not_found/.test(c)) kind = "model";
  else if (status === 400 || /invalid/.test(c)) kind = "invalid";
  return new GeminiError(message || "The request failed.", { status, code: c, kind });
}

async function errorFrom(res) {
  let message = `The request failed (${res.status}).`;
  let code = "";
  try {
    const body = await res.json();
    message = body?.error?.message || message;
    code = body?.error?.status || body?.error?.code || "";
  } catch {
    /* non-JSON error body */
  }
  return toError(message, res.status, code);
}

function textOf(interaction) {
  return (interaction.steps || [])
    .filter((s) => s.type === "model_output")
    .flatMap((s) => s.content || [])
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text)
    .join("");
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
  });
}

async function streamOnce({ apiKey, model, steps, system, thinkingLevel, signal, onUpdate }, withThinking) {
  const body = { model, input: steps, stream: true, store: false };
  if (system) body.system_instruction = system;
  if (withThinking) {
    body.generation_config = { thinking_summaries: "auto" };
    if (thinkingLevel) body.generation_config.thinking_level = thinkingLevel;
  }
  const res = await fetch(`${BASE}/interactions?alt=sse`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await errorFrom(res);

  const out = { text: "", thoughts: "", usage: null };
  if (!(res.headers.get("content-type") || "").includes("text/event-stream")) {
    const data = await res.json().catch(() => ({}));
    if (data.error) throw toError(data.error.message, res.status, data.error.status || data.error.code);
    out.text = textOf(data);
    out.usage = normalizeUsage(data.usage);
    onUpdate?.(out);
    return out;
  }

  const apply = (ev) => {
    switch (ev.event_type) {
      case "step.start": {
        const step = ev.step || {};
        if (step.type === "model_output") for (const c of step.content || []) if (c.type === "text" && c.text) out.text += c.text;
        if (step.type === "thought") for (const s of step.summary || []) if (s.text) out.thoughts += s.text;
        break;
      }
      case "step.delta": {
        const d = ev.delta || {};
        if (d.type === "text") out.text += d.text || "";
        else if (d.type === "thought_summary") out.thoughts += d.content?.text || "";
        else return;
        break;
      }
      case "interaction.completed":
        out.usage = normalizeUsage(ev.interaction?.usage) || out.usage;
        return;
      case "error": {
        const err = toError(ev.error?.message, 0, ev.error?.code);
        err.partial = !!out.text;
        throw err;
      }
      default:
        if (ev.metadata?.total_usage) out.usage = normalizeUsage(ev.metadata.total_usage);
        return;
    }
    onUpdate?.(out);
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (signal?.aborted) {
      reader.cancel().catch(() => {});
      throw new DOMException("Aborted", "AbortError");
    }
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop();
    for (const block of blocks) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (!data || data === "[DONE]") continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      apply(ev);
    }
  }
  return out;
}

/**
 * Streams one model reply. onUpdate receives the running { text, thoughts }.
 * Resolves with { text, thoughts, usage }.
 */
export async function streamInteraction(opts) {
  let busyRetries = 0;
  let withThinking = true;
  for (;;) {
    try {
      return await streamOnce(opts, withThinking);
    } catch (err) {
      if (opts.signal?.aborted || !(err instanceof GeminiError) || err.partial) throw err;
      // A model that doesn't take thinking options still answers without them.
      if (err.kind === "invalid" && withThinking && /think/i.test(err.message)) { withThinking = false; continue; }
      if (err.kind === "busy" && busyRetries < 2) { busyRetries += 1; await sleep(1200 * busyRetries, opts.signal); continue; }
      throw err;
    }
  }
}

/** One-shot, non-streaming call (used for chat titles). */
export async function generateOnce({ apiKey, model, input, signal }) {
  const res = await fetch(`${BASE}/interactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({ model, input, store: false }),
    signal,
  });
  if (!res.ok) throw await errorFrom(res);
  const data = await res.json();
  return { text: textOf(data), usage: normalizeUsage(data.usage) };
}
