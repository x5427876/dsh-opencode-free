import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  createInitialSystemMessage,
  createProvider,
  getCurrentSystemPrompt,
  getCurrentTools,
  normalizeContext,
  type Api,
  type Context,
  type FetchFunction,
  type Model,
  type Provider,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { getApiProvider, registerApiProvider } from "@earendil-works/pi-ai/compat";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { Catalog } from "./catalog.js";

export const PROVIDER_ID = "opencode-zen-free";
export const BASE_URL = "https://opencode.ai/zen/v1";
const SUPPORTED_APIS = new Set(["openai-responses", "openai-completions"]);

/**
 * The pi-ai builtin free set, identity-mapped. Since the catalogue moved to
 * `catalog.ts` (models.dev owns WHICH models are free; Zen `/models` gates
 * availability), this is no longer the source of truth: it is the D8 offline
 * floor and the identity `template` the derived records inherit from.
 */
export function builtinFreeModels(): Model<Api>[] {
  return getBuiltinModels("opencode")
    .filter((m) => SUPPORTED_APIS.has(m.api) && Object.values(m.cost).every((cost) => cost === 0))
    .map((m) => ({
      ...m,
      provider: PROVIDER_ID,
      baseUrl: BASE_URL,
      // Static gate headers so side-channels that bypass zenProvider().stream()
      // (e.g. direct compat `completeSimple`, which resolves auth +
      // model.headers but never calls our requestOptions wrapper) still look
      // like OpenCode. Dynamic per-request headers (x-opencode-session /
      // x-opencode-request / Authorization) are added in requestOptions() for
      // the main path; compat createClient merges model.headers then options
      // headers, so these survive both paths.
      headers: {
        ...m.headers,
        ...STATIC_ZEN_HEADERS,
      },
    }));
}

/**
 * The identity/field template `catalog.ts` clones onto every derived record.
 * It carries the Zen identity (provider/baseUrl/headers) so catalog.ts needs no
 * import from this module and no import cycle exists.
 *
 * The pin was `mimo-v2.5-free`, described as the most completely populated
 * builtin free record. pi-ai 0.87 renamed that record to
 * `mimo-v2.6-flash-free`, so from the 0.87 port onward the `find` matched
 * nothing and every caller fell through to its own fallback — on 2026-09-30
 * that was `builtinFreeModels()[0]`, i.e. `big-pickle`, a model Zen does not
 * serve at all. Nothing broke, and the reason is worth keeping in view: the
 * template only supplies IDENTITY, the channel comes from `knownApis`
 * inference, and capability fields are read from models.dev rather than
 * inherited. But a silently-unmatched pin is a trap for the next reader, so the
 * fallback lives here now — deterministic, and preferring a record the free
 * tier actually serves.
 */
const TEMPLATE_IDS = ["mimo-v2.6-flash-free", "mimo-v2.5-free"] as const;

export function catalogTemplate(): Model<Api> | undefined {
  const models = builtinFreeModels();
  for (const id of TEMPLATE_IDS) {
    const found = models.find((model) => model.id === id);
    if (found !== undefined) return found;
  }
  return models.find((model) => model.id.includes("-free"));
}

/**
 * pi-ai's builtin `id -> api` table: tier 1 of D6's channel inference, and the
 * only tier that knows a channel the published metadata cannot express.
 */
export function builtinKnownApis(): Map<string, Api> {
  const known = new Map<string, Api>();
  for (const model of getBuiltinModels("opencode")) known.set(model.id, model.api);
  return known;
}

/**
 * Back-compat pointer to the catalogue a live provider is using, so the
 * exported `freeModels()` keeps reporting what the picker actually offers.
 * It holds no state of its own — `catalog.ts` stays the single owner — and is
 * only ever set by `zenProvider({ catalog })` at plugin startup.
 */
let activeCatalog: Catalog | null = null;

/**
 * The catalogue the picker offers. Post-Zen-gate when a catalogue is attached
 * (so `listModels`, this export, and the panel's `visible` are one list), and
 * the pi-ai builtin free set before that — the D8 offline floor.
 */
export function freeModels(): Model<Api>[] {
  return activeCatalog === null ? builtinFreeModels() : activeCatalog.effectiveModels();
}

/**
 * The version the plugin calls itself on the wire. Kept in step with
 * `package.json` by hand (the repo has no build-time import), so
 * `tests/compatibility.test.mjs` asserts the two agree.
 *
 * It lives here, not in `catalog.ts`, because it is an identity constant and
 * this module is its declared single owner — `catalog.ts` used to hold a
 * second copy precisely to avoid importing from here, and that is how the
 * `User-Agent` drifted to 0.2.0 on a branch whose `package.json` said 0.3.0.
 * `zen-provider` does not import `catalog` at runtime (only its type), so
 * reading it the other way round introduces no cycle.
 */
export const PLUGIN_VERSION = "0.3.0";

/** Derived, not written out: a second hardcoded copy is a second thing to forget. */
export const OPENCODE_USER_AGENT = `opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14 dsh-opencode-free/${PLUGIN_VERSION}`;
export const OPENCODE_CLIENT = "cli";
export const OPENCODE_PROJECT = "global";
/** The literal credential the free tier runs on; there is no other. */
const ANONYMOUS_KEY = "public";

/**
 * Static free-tier gate headers. Must stay in sync with requestOptions().
 * Exposed on provider.headers, model.headers, and auth.resolve() so
 * out-of-band completions still send the OpenCode identity Zen gates on.
 * Per-request values (session/request/auth) stay dynamic in requestOptions().
 */
export const STATIC_ZEN_HEADERS: Record<string, string> = {
  "User-Agent": OPENCODE_USER_AGENT,
  "x-opencode-client": OPENCODE_CLIENT,
  "x-opencode-project": OPENCODE_PROJECT,
};

/**
 * The complete OpenCode identity, as one owned list.
 *
 * This set used to be written out four times — `STATIC_ZEN_HEADERS`,
 * `compatRequestOptions()`, the fetch guard, and
 * `applyZenHeadersToNodeHeaders()` — with a comment ("must stay in sync with
 * requestOptions()") as the only thing holding them together. Upstream gates
 * admission on exactly these headers, so one missed edit is a silent, total
 * 403 on the path that was missed, reported to the user as "the anonymous tier
 * refused" and therefore diagnosed in the wrong direction.
 *
 * Exported so `tests/compatibility.test.mjs` can assert that every call site
 * produces the same header NAMES, which is the check that was missing.
 */
export const ZEN_IDENTITY_HEADERS: readonly string[] = Object.freeze([
  "Authorization",
  "User-Agent",
  "x-client-request-id",
  "x-opencode-client",
  "x-opencode-project",
  "x-opencode-request",
  "x-opencode-session",
]);

/**
 * Stamp the whole identity onto a `Headers`. Idempotent by construction: a
 * value already present and non-empty is kept, so a caller who genuinely set an
 * Authorization (a real Zen key) is never downgraded to the anonymous tier.
 *
 * `session` is the already-computed `ses_` value, so all three ids that must
 * agree — x-opencode-session, x-client-request-id — come from one place.
 */
export function applyZenIdentity(
  headers: Headers,
  options: { readonly session: string; readonly apiKey: string },
): Headers {
  if (!headers.get("authorization")) headers.set("Authorization", `Bearer ${options.apiKey}`);
  headers.set("User-Agent", OPENCODE_USER_AGENT);
  headers.set("x-opencode-client", OPENCODE_CLIENT);
  headers.set("x-opencode-project", OPENCODE_PROJECT);
  headers.set("x-opencode-session", options.session);
  if (!headers.get("x-opencode-request")) headers.set("x-opencode-request", requestHeader());
  if (!headers.get("x-client-request-id")) headers.set("x-client-request-id", options.session);
  return headers;
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function base62FromBytes(bytes: Uint8Array, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += BASE62[bytes[i % bytes.length] % 62];
  return out;
}

/**
 * Map a DSH session id to a valid OpenCode session id.
 * Format from packages/opencode/src/id/id.ts: `ses_` + 12 hex chars
 * (6 timestamp bytes) + 14 random base62 chars. The upstream free-tier gate
 * rejects structurally invalid ids, while freshly generated valid ids pass.
 * Hashing keeps affinity stable per DSH session and distinct between sessions.
 */
/**
 * Per-process salt, generated at module load and never written down.
 *
 * The hash used to be unsalted and therefore deterministic: anyone who could
 * guess or enumerate a DSH session id could recompute the same header and
 * confirm that two requests belonged to the same session. Because upstream also
 * routes on this header for sticky backends (see docs/reverse-engineering.md),
 * that linkability extends to a session's boundaries and active hours, on
 * top of the per-IP bucket the design already accepts.
 *
 * A restart changing every id is the intended behaviour, not a regression:
 * upstream affinity is only useful WITHIN one DSH session, and the plugin
 * already treats a restart as a cold start (the Zen gate is re-asked every boot
 * and probe verdicts are keyed on model id, never on the session).
 */
const SESSION_SALT = randomBytes(32);

export function sessionHeader(sessionId: string): string {
  const hash = createHash("sha256").update(SESSION_SALT).update(`${PROVIDER_ID}:${sessionId}`).digest();
  const hex = hash.subarray(0, 6).toString("hex");
  return `ses_${hex}${base62FromBytes(hash.subarray(6), 14)}`;
}

/** Random valid OpenCode request id (`msg_` + 12 hex + 14 base62). */
export function requestHeader(): string {
  return `msg_${randomBytes(6).toString("hex")}${base62FromBytes(randomBytes(14), 14)}`;
}

/**
 * Zen routes `x-opencode-session` to a sticky backend so
 * `reasoning.encrypted_content` replays normally. After idle expiry or long
 * tasks Zen can move the session to a different instance that no longer holds
 * the encryption key, and the upstream rejects the replay with 400.
 */
export function isEncryptedContentError(status: number, bodyText: string): boolean {
  if (status !== 400) return false;
  return /encrypted[_ ]content/i.test(bodyText);
}

/**
 * Drop stale Responses `reasoning` items so a retried request looks like a
 * fresh session (which Zen always accepts). Function-call item ids are also
 * dropped while `call_id` is kept. Returns null when there is nothing to strip.
 */
export function stripStaleReasoning(payload: unknown): unknown | null {
  if (!payload || typeof payload !== "object") return null;
  const input = (payload as { input?: unknown }).input;
  if (!Array.isArray(input)) return null;
  if (!input.some((item) => (item as { type?: unknown })?.type === "reasoning")) return null;
  const nextInput = input
    .filter((item) => (item as { type?: unknown })?.type !== "reasoning")
    .map((item) => {
      const typed = item as { type?: unknown; id?: unknown } | null;
      if (
        (typed?.type === "function_call" || typed?.type === "custom_tool_call") &&
        typeof typed.id === "string"
      ) {
        const { id: _dropped, ...rest } = typed as Record<string, unknown>;
        return rest;
      }
      return item;
    });
  return { ...(payload as Record<string, unknown>), input: nextInput };
}

/** Wrap fetch with a single retry that drops stale reasoning on Zen rotation. */
export function withEncryptedContentFallback(
  inner?: FetchFunction,
  recorder?: TransportRecorder,
): FetchFunction {
  // The recorder wraps whatever fetch is really used, so it observes the same
  // rejection the transport sees. With one, it is the base and `inner` is
  // already folded into it — wrapping twice would only cost a hop.
  const base: FetchFunction = recorder === undefined ? (inner ?? globalThis.fetch) : recorder.fetch;
  return (async (url: unknown, init?: unknown) => {
    const first = await (base as (u: never, i: never) => Promise<Response>)(url as never, init as never);
    if (first.status !== 400) return first;
    let text = "";
    try {
      text = await first.clone().text();
    } catch {
      return first;
    }
    if (!isEncryptedContentError(first.status, text)) return first;
    let parsed: unknown;
    try {
      const raw = (init as { body?: unknown } | undefined)?.body;
      if (typeof raw !== "string") return first;
      parsed = JSON.parse(raw);
    } catch {
      return first;
    }
    const stripped = stripStaleReasoning(parsed);
    if (!stripped) return first;
    const nextInit = { ...((init as Record<string, unknown>) ?? {}), body: JSON.stringify(stripped) };
    return (base as (u: never, i: never) => Promise<Response>)(url as never, nextInit as never);
  }) as FetchFunction;
}

type CompatApiEntry = ReturnType<typeof getApiProvider>;
type SessionGetter = () => string | undefined;

// ── transport-failure diagnosis ─────────────────────────────────────────────
//
// A socket-level failure reaches the user as a bare `Connection error.` — that
// is the OpenAI SDK's `APIConnectionError` default message, and the SDK keeps
// the real reason in `cause`. pi-ai then reads only `error.message`, so the
// cause is gone by the time DSH classifies the failure. Observed live
// 2026-09-29: a 45-minute outage rendered as nothing but "Connection error.",
// with no way to tell a reset socket from DNS, TLS, or a proxy.
//
// This plugin's fetch wrapper is the last place on the request path that can
// still see the cause, so it records it there and re-attaches it to the
// terminal error. Nothing else about the failure is changed: the class the host
// derives must stay exactly as it was.

/**
 * DSH classifies a failure by scanning its message for 4xx/5xx literals
 * (`/\b5\d\d\b/`, `/\b400\b/`, `/\b429\b/`, …) BEFORE it reaches the transport
 * rule. This detail is appended to a message whose class is already decided, so
 * a cause carrying digits of its own — a port, a byte count — must not be able
 * to re-file a socket kill as an upstream status error. Masking every bare
 * three-digit run keeps the original wording authoritative.
 *
 * A cause that says "timeout" is the one deliberate exception: naming a
 * connect timeout is the whole point, and DSH classes it TIMEOUT rather than
 * TRANSPORT — the truer of the two, and retried identically (both codes sit in
 * the same default retryable set).
 */
function maskStatusLikeNumbers(text: string): string {
  return text.replace(/\b\d{3}\b/g, "###");
}

/**
 * Flatten an error's `cause` chain into one short line: name, `code`, message.
 * Sizes and shapes only — a transport failure carries no request body, and the
 * Authorization value is never read from an error.
 */
export function describeTransportCause(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current !== undefined && current !== null; depth++) {
    const value = current as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
    const name = typeof value.name === "string" && value.name !== "" ? value.name : undefined;
    const code = typeof value.code === "string" && value.code !== "" ? value.code : undefined;
    const message = typeof value.message === "string" ? value.message : "";
    // A bare `TypeError: fetch failed` names no cause at all; the next link
    // (SocketError, ECONNRESET, ENOTFOUND, …) is the actionable half.
    const head =
      [name, code].filter((part) => part !== undefined).join("/") ||
      (current instanceof Error ? "Error" : typeof current);
    const text = message === "" || message === head ? head : `${head}: ${message}`;
    if (!parts.includes(text)) parts.push(text);
    current = value.cause;
  }
  if (parts.length === 0) return "";
  return maskStatusLikeNumbers(parts.join(" <- "));
}

/** A fetch that remembers why it failed, for the terminal error to report. */
export interface TransportRecorder {
  /** The fetch to hand pi-ai: the original one, plus cause capture. */
  readonly fetch: FetchFunction;
  /** The recorded cause chain; undefined when no transport failure happened. */
  detail(): string | undefined;
}

export function createTransportRecorder(inner?: FetchFunction): TransportRecorder {
  const base: FetchFunction = inner ?? globalThis.fetch;
  let detail: string | undefined;
  return {
    fetch: (async (url: unknown, init?: unknown) => {
      try {
        return await (base as (u: never, i: never) => Promise<Response>)(url as never, init as never);
      } catch (error) {
        // First cause wins: a retry that fails the same way must not replace the
        // original diagnosis with a downstream symptom of it.
        if (detail === undefined) {
          const described = describeTransportCause(error);
          if (described !== "") detail = described;
        }
        throw error;
      }
    }) as FetchFunction,
    detail: () => detail,
  };
}

/** Pristine compat entries, stashed on globalThis so reloads re-wrap the original. */
const COMPAT_ORIGINALS_KEY = "__dshOpenCodeFreeCompatOriginals";
function compatOriginals(): Map<string, NonNullable<CompatApiEntry>> {
  const g = globalThis as Record<string, unknown>;
  const existing = g[COMPAT_ORIGINALS_KEY];
  if (existing instanceof Map) return existing as Map<string, NonNullable<CompatApiEntry>>;
  const created = new Map<string, NonNullable<CompatApiEntry>>();
  g[COMPAT_ORIGINALS_KEY] = created;
  return created;
}

/**
 * OpenCode's own compaction system prompt, byte-identical as shipped in the
 * CLI binary. Zen's anonymous free tier gates on it: Pi's own summarization
 * prompt gets 403 FreeTierError while this text passes with otherwise
 * identical requests.
 */
export const OPENCODE_SUMMARIZATION_PROMPT =
  "You are a context summarization agent. You are given a conversation between a user and an agent. Your goal is to produce a structured summary matching the format specified so another coding agent can continue the work.\n" +
  "Always follow the exact output structure requested by the user prompt. Keep every section, preserve exact file paths and identifiers when known, and prefer terse bullets over paragraphs.\n" +
  "Do not continue the conversation. Do not respond to any questions in the conversation. Only output the structured summary in the exact format requested by the user prompt. Respond in the same language as the conversation.\n";

/** Marker identifying Pi's own compaction system prompt wording. */
const PI_SUMMARIZATION_MARKER = "context summarization";

type TranscriptMessage = Record<string, unknown> & { role?: unknown };
/**
 * The shape pi-ai 0.87 providers actually read. `toTranscript` used to declare
 * it as the caller's own `T`, so a caller that passed a legacy `Context` and
 * then read `.systemPrompt` off the result type-checked perfectly and got
 * `undefined` at run time — a type lie on the request path's front door
 *.
 */
export type TranscriptContext = ReturnType<typeof normalizeContext>;

/**
 * Fold a legacy `Context` into the transcript pi-ai 0.87 providers read;
 * a transcript passes through unchanged.
 *
 * The `T` return type is a deliberate fiction: the result is a
 * `TranscriptContext`, not the caller's type. It compiles because
 * `normalizeContext` returns one, and a caller that passes a `Context` and
 * then reads `.systemPrompt` off the result gets `undefined` — which is the
 * point. Only `normalizeContext()` output can reach a provider, so this is the
 * one function every entry point must go through.
 */
export function toTranscript<T>(context: T): T | TranscriptContext {
  if (!context || typeof context !== "object") return context;
  const legacy = context as { systemPrompt?: unknown; tools?: unknown };
  if (legacy.systemPrompt === undefined && legacy.tools === undefined) return context;
  return normalizeContext(context as unknown as Context) as unknown as TranscriptContext;
}

/**
 * Swap Pi's compaction system prompt for OpenCode's byte-identical one when
 * sending anonymously to Zen. Handles the legacy `{ systemPrompt }` shape and
 * the transcript shape (the prompt lives in system messages). Only short
 * standalone prompts containing the marker are rewritten — never conversation
 * content, requests with tools, or keyed requests.
 */
export function swapCompactionPrompt<T>(context: T, apiKey: unknown): T {
  const key = typeof apiKey === "string" && apiKey.trim() ? apiKey : "public";
  if (key !== "public") return context;
  if (!context || typeof context !== "object") return context;
  const sys = (context as { systemPrompt?: unknown }).systemPrompt;
  if (typeof sys === "string") {
    // Anchored, not substring. "Contains the phrase" also matched a user
    // prompt that merely MENTIONED context summarization, and the whole prompt
    // was then replaced — no log, no warning, and only on the anonymous path,
    // so attaching a key silently "fixed" it. Verified 2026-09-30: a
    // 93-character custom prompt containing the phrase came back as OpenCode
    // compression-agent instructions.
    if (sys.length > 2000 || !/^you are a context summarization/i.test(sys.trim())) return context;
    // And never when the caller has real tools — the guard the transcript
    // branch below already applies.
    const msgs = (context as { messages?: unknown }).messages;
    if (Array.isArray(msgs) && getCurrentTools(msgs as Parameters<typeof getCurrentTools>[0]).length > 0)
      return context;
    return { ...(context as Record<string, unknown>), systemPrompt: OPENCODE_SUMMARIZATION_PROMPT } as T;
  }
  const msgs = (context as { messages?: unknown }).messages as TranscriptMessage[] | undefined;
  if (!Array.isArray(msgs)) return context;
  const transcript = msgs as Parameters<typeof getCurrentSystemPrompt>[0];
  const prompt = getCurrentSystemPrompt(transcript);
  // Two bail-outs the legacy branch never had, and they narrow behaviour on the
  // LIVE path (this branch is the one that runs, since `toTranscript` clears
  // `systemPrompt` before we get here). A decline that looks identical to a
  // swap is the failure mode worth being able to see, so it says so.
  if (prompt && prompt.length <= 2000 && prompt.toLowerCase().includes(PI_SUMMARIZATION_MARKER)) {
    const skipped =
      getCurrentTools(transcript).length > 0 ||
      msgs.filter((m) => m?.role !== "system").length !== 1 ||
      msgs.filter((m) => m?.role !== "system")[0]?.role !== "user";
    if (skipped)
      debugLog("compaction prompt seen but NOT swapped (tools present, or not a single user turn)");
  }
  if (!prompt || prompt.length > 2000 || !prompt.toLowerCase().includes(PI_SUMMARIZATION_MARKER))
    return context;
  if (getCurrentTools(transcript).length > 0) return context;
  const nonSystem = msgs.filter((m) => m?.role !== "system");
  if (nonSystem.length !== 1 || nonSystem[0]?.role !== "user") return context;
  const messages = msgs.map((m) => {
    if (m?.role !== "system") return m;
    const { sections: _dropped, ...rest } = m;
    return { ...rest, content: OPENCODE_SUMMARIZATION_PROMPT };
  });
  return { ...(context as Record<string, unknown>), messages } as T;
}

/**
 * Zen's anonymous free tier 403s (`FreeTierError`) unless the request declares
 * tools named exactly `read` and `bash`; descriptions and schemas are ignored
 * (live replay 2026-09-27). DSH on Windows ships `pwsh` instead of `bash`, so
 * anonymous requests send `pwsh` as `bash` (history included) and map calls
 * back; tool-less requests (titles, compaction) get inert stubs.
 */
const GATE_TOOLS = ["read", "bash"];
const SHELL_ALIAS = "pwsh";
const STUB_DESCRIPTION = "Unavailable in this request. Do not call.";

export function applyAnonymousToolGate<T>(
  context: T,
  apiKey: unknown,
): { context: T; restoreShell: boolean } {
  const key = typeof apiKey === "string" && apiKey.trim() ? apiKey : "public";
  const msgs = (context as { messages?: unknown } | null)?.messages as TranscriptMessage[] | undefined;
  // The gate operates on the transcript, because that is all a 0.87 provider
  // reads: `context.tools` is not merely ignored, it is unreachable. On rc.1
  // (pi-ai 0.85) the old shape was correct, and the two are not compatible —
  // which is why the peer pin is exact rather than a union.
  if (key !== "public" || !Array.isArray(msgs)) return { context, restoreShell: false };
  const current = getCurrentTools(msgs as Parameters<typeof getCurrentTools>[0]);
  const has = (name: string) => current.some((t) => t.name === name);
  const restoreShell = !has("bash") && has(SHELL_ALIAS);
  const rename = (name: unknown) => (name === SHELL_ALIAS ? "bash" : name);
  const renameAll = (list: unknown) =>
    Array.isArray(list) ? list.map((t: { name?: unknown }) => ({ ...t, name: rename(t.name) })) : list;
  let messages = !restoreShell
    ? msgs
    : msgs.map((m) => {
        if (m?.role === "system") {
          const out: TranscriptMessage = { ...m };
          if (m.toolsAdded) out.toolsAdded = renameAll(m.toolsAdded);
          if (m.toolsRemoved) out.toolsRemoved = renameAll(m.toolsRemoved);
          return out;
        }
        if (m?.role === "toolResult") return { ...m, toolName: rename(m.toolName) };
        if (m?.role !== "assistant" || !Array.isArray(m.content)) return m;
        return {
          ...m,
          content: m.content.map((c: { type?: unknown; name?: unknown }) =>
            c?.type === "toolCall" ? { ...c, name: rename(c.name) } : c,
          ),
        };
      });
  const stubs = GATE_TOOLS.filter((name) => !has(name) && !(restoreShell && name === "bash")).map((name) => ({
    name,
    description: STUB_DESCRIPTION,
    parameters: { type: "object", properties: {} },
  }));
  if (stubs.length) {
    const first = messages[0];
    messages =
      first?.role === "system"
        ? [
            { ...first, toolsAdded: [...((first.toolsAdded as unknown[]) ?? []), ...stubs] },
            ...messages.slice(1),
          ]
        : [
            createInitialSystemMessage(undefined, stubs as never) as unknown as TranscriptMessage,
            ...messages,
          ];
  }
  return { context: { ...(context as Record<string, unknown>), messages } as T, restoreShell };
}

/** Rename returned `bash` calls back to DSH's `pwsh` in place (events share `partial`). */
function restoreShellCalls(value: unknown): void {
  const v = value as {
    partial?: unknown;
    message?: unknown;
    error?: unknown;
    toolCall?: { name?: unknown };
  } | null;
  if (!v || typeof v !== "object") return;
  for (const msg of [v, v.partial, v.message, v.error] as { content?: unknown }[]) {
    if (!Array.isArray(msg?.content)) continue;
    for (const c of msg.content as { type?: unknown; name?: unknown }[]) {
      if (c?.type === "toolCall" && c.name === "bash") c.name = SHELL_ALIAS;
    }
  }
  if (v.toolCall?.name === "bash") v.toolCall.name = SHELL_ALIAS;
}

/** Env var for an optional Zen API key (account quota instead of anonymous). */
export const ZEN_API_KEY_ENV = "OPENCODE_API_KEY";

/** Upstream failure classes with actionable guidance (see spec v0.2). */
export type ZenFailureKind = "anon-gated" | "quota-exhausted" | "bad-key" | "unknown";

export const ZEN_FAILURE_GUIDANCE: Record<ZenFailureKind, string> = {
  "anon-gated":
    "上游拒絕免費層請求。此錯誤不足以判定匿名額度耗盡或排除插件相容性問題。若有 Zen key，可透過插件 config.apiKey 或環境變數 " +
    ZEN_API_KEY_ENV +
    " 設定後重測；不保證能解除拒絕。",
  "quota-exhausted":
    "免費額度用完。等視窗重置，或掛 Zen key（插件 config.apiKey 或 " + ZEN_API_KEY_ENV + "）繼續用。",
  "bad-key": "Zen key 無效。檢查 key 是否正確、過期或被撤銷；匿名用量不受影響。",
  unknown: "未知的上游錯誤。跑 scripts/reverify.sh 看當下閘門狀態，仍異常則回報狀態碼與報文。",
};

const ANON_GATED_PATTERN = /FreeTierError|MissingSessionID|only be used .*OpenCode/i;
/**
 * Re-assert the anonymous admission tools on the FINAL payload.
 *
 * `applyAnonymousToolGate` puts `read` + `bash` on the context, which is the
 * documented requirement for this tier — a tool-less request is refused with
 * `403 FreeTierError` on every model (docs/reverse-engineering.md §8), and that
 * is exactly what the host answers (measured 2026-09-30: the probe's outgoing
 * body carried no `tools` at all, while the same code run outside the host sent
 * them and was admitted).
 *
 * Everything above this point can drop them — a transport that reads tools from
 * somewhere else, a context rebuilt downstream, a provider variant. The payload
 * hook is the last place before the bytes leave, so the probe guarantees its own
 * admission here instead of assuming four layers upstream did it. Idempotent: if
 * the tools are already present nothing is written.
 */
function enforceAnonymousTools(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object") return payload;
  const body = payload as Record<string, unknown>;
  const existing = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
  // The two channels name a tool differently: responses puts the name beside
  // `type`, completions nests it under `function`. Check both so an
  // already-gated payload is never touched.
  const named = (tool: unknown): string => {
    if (tool === null || typeof tool !== "object") return "";
    const t = tool as { name?: unknown; function?: { name?: unknown } };
    return String(t.name ?? t.function?.name ?? "");
  };
  const has = (name: string): boolean => existing.some((tool) => named(tool) === name);
  const missing = GATE_TOOLS.filter((name) => !has(name));
  if (missing.length === 0) return payload;
  // This branch is DEAD once the transcript gate works, and that silence is the
  // only evidence the gate did. Say so, loudly, because the failure it would
  // otherwise mask is silent and total: the upstream answers 403 to every
  // model and the round reports nothing measurable, with no error anywhere.
  debugLog(`ADMISSION BACKSTOP FIRED: re-adding ${missing.join(",")} at the payload boundary`);
  // Responses channel is detected by its own body field, not guessed.
  const responses = "input" in body && !("messages" in body);
  const stub = (name: string): unknown =>
    responses
      ? {
          type: "function",
          name,
          description: STUB_DESCRIPTION,
          parameters: { type: "object", properties: {} },
        }
      : {
          type: "function",
          function: { name, description: STUB_DESCRIPTION, parameters: { type: "object", properties: {} } },
        };
  return { ...body, tools: [...existing, ...missing.map(stub)] };
}

const QUOTA_PATTERN = /FreeUsageLimitError|usage[\s\S]{0,40}(exceeded|limit)|rate[\s-]?limit|quota/i;
const BAD_KEY_PATTERN = /invalid[\s\S]{0,60}key|unauthorized|authentication_error/i;

/**
 * Advice for a socket-level failure, kept out of {@link ZenFailureKind} on
 * purpose: no status was ever received, so this is not one of the HTTP classes
 * `classifyZenFailure` decides between, and it says nothing about the request
 * Zen would have accepted.
 */
export const ZEN_TRANSPORT_GUIDANCE =
  "請求未送出或連線被中斷，沒有收到任何 HTTP 回應。這是本機到 Zen 的網路層問題，與模型、額度、key 無關；" +
  "請檢查代理、VPN、防火牆與 DNS 後重試。";

/**
 * Map an upstream failure to its actionable class. Body markers win over
 * status: a 403 carrying key text is still key trouble only when no
 * anonymity-gate marker is present, and an unrecognized 403 stays unknown
 * rather than guessed.
 */
export function classifyZenFailure(status: number, bodyText: string): ZenFailureKind {
  const body = typeof bodyText === "string" ? bodyText : "";
  if (ANON_GATED_PATTERN.test(body)) return "anon-gated";
  if (status === 429 || QUOTA_PATTERN.test(body)) return "quota-exhausted";
  if (status === 401 || BAD_KEY_PATTERN.test(body)) return "bad-key";
  return "unknown";
}

/**
 * Which of the three markers {@link ANON_GATED_PATTERN} actually matched.
 *
 * `anon-gated` folds three upstream conditions into one code, and they call for
 * three different repairs: a `FreeTierError` is a tier refusal, a
 * `MissingSessionID` is a header the request failed to carry, and
 * "only be used … OpenCode" is an identity the route did not recognise. The
 * folded code is right for the reader (none of them is a verdict about the
 * model) and useless for the person who has to fix it — so the round records
 * which one fired.
 *
 * This exists because the body is the only place that fact ever exists, and an
 * `inconclusive` is never persisted: without this, a refusal is unanswerable
 * the moment the round ends. Tested in the same order as the pattern, so the
 * marker always names the branch that actually decided the classification.
 */
export type AnonGateMarker = "FreeTierError" | "MissingSessionID" | "opencode-only" | null;

export function anonGateMarker(bodyText: string): AnonGateMarker {
  const body = typeof bodyText === "string" ? bodyText : "";
  if (/FreeTierError/i.test(body)) return "FreeTierError";
  if (/MissingSessionID/i.test(body)) return "MissingSessionID";
  if (/only be used .*OpenCode/i.test(body)) return "opencode-only";
  return null;
}

// ── availability probe (spec model-probe D3/D4/D5) ──────────────────────────
//
// The probe answers one question per model: can it still answer at all? That
// is the only ground truth for "the free tier ended" — `status: "deprecated"`
// on models.dev means both "gone" and "stale record" (muse-spark-1.2 and
// mimo-v2.5 are deprecated and still working; deepseek-v4-flash-free is
// deprecated and dead), so no static field can decide it.
//
// Everything here runs through `provider.streamSimple`, never a hand-built
// request: that path already applies the OpenCode CLI identity
// (requestOptions), injects the `read` + `bash` tool names the anonymous gate
// requires (applyAnonymousToolGate — a tool-less probe 403s on every model,
// see docs/reverse-engineering.md §8), and maps upstream failures to guidance.

/**
 * The shortest thing a model will answer. A bare greeting, not an instruction:
 * asking for a specific token ("Reply with OK only") spends reasoning budget
 * satisfying a format the probe does not care about, and a model that reasons
 * before it answers can run the budget out before emitting anything at all.
 * 9router's per-model test uses `"hi"` for the same reason.
 */
const PROBE_PROMPT = "hi";
/**
 * The probe's output ceiling.
 *
 * 1024, chosen by a live A/B on output tokens (1024 vs 16, 33 models, two runs in
 * agreement). The full data and the two superseded arguments live in
 * `docs/adr/0002-catalogue-source-of-truth.md`; the A/B is reproducible with
 * `scripts/probe-ab.mjs`. The short version: a smaller ceiling does not make the
 * expensive models cheaper — it makes the two most expensive ones stop answering
 * altogether, and the token median looks like a win precisely BECAUSE those two
 * fall out of the sample. A budget that trades answers for tokens has not saved
 * anything.
 *
 * `tests/compatibility.test.mjs` pins this value exactly, and pins that
 * `ProbeDeps.maxTokens` still reaches the wire: an untested override made the A/B
 * compare 1024 against 1024 and report "no difference".
 *
 * Exported so `scripts/test-live.mjs` and the test suite pin THIS number rather
 * than each carrying a literal of their own.
 */
export const PROBE_MAX_TOKENS = 1024;
/**
 * Same per-model ceiling as scripts/test-live.mjs, and the same 15s 9router's
 * per-model test uses. The round is sequential over the whole catalogue, so the
 * per-model ceiling is the round's worst case multiplied: 30s here was up to
 * twice the wait for an answer that is either immediate or never coming.
 */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Upstream wording that means *this model* is gone, as opposed to a gate, an
 * exhausted quota, or a bad credential. Deliberately narrow: an unrecognized
 * failure must never read as "dead" (see {@link isModelUnavailableFailure}).
 *
 * Calibrated against real Zen bodies on 2026-09-29 rather than written from
 * imagination — the P6 acceptance target was `deepseek-v4-flash-free` dying,
 * and it did not, because the wording is "Model is unavailable." with a
 * filler between the subject and the predicate.
 */
const MODEL_GONE_PATTERNS: readonly RegExp[] = [
  // "Upstream request failed: Model is unavailable." — deepseek-v4-flash-free,
  // whose free tier is over. HTTP 400, credential-independent.
  //
  // The gaps are bounded but NOT dot-excluded: model ids contain dots
  // (`kimi-k2.5-free`, `gpt-5.5-free`), so a `[^.]` class silently failed to
  // match every real body that names the model before the predicate.
  /\bmodel\b.{0,40}?\b(?:is|was)\s+(?:unavailable|unsupported|disabled|retired)\b/i,
  // "Model kimi-k2.5-free is not supported" — the route declining to serve a
  // model models.dev still lists at zero cost. Observed 2026-09-29 on 25 of 34
  // catalogue models, HTTP 401. Counted as gone: on this provider a Zen key
  // changes the quota, NOT the model list, so these models are unavailable to a
  // keyed caller too. `ModelError` is a model-routing error, not an auth one.
  /\bmodels?\b.{0,60}?\bnot\s+supported\b/i,
  // "model not found" / "does not exist" / "unrecognized model"
  /\bmodels?\b.{0,24}?\b(?:not\s+found|does\s+not\s+exist|unrecognized)\b/i,
  /\bno\s+longer\s+(?:available|served|supported|provided|offered)\b/i,
  /\b(?:retired|sunset|discontinued|decommissioned)\b/i,
];

/**
 * The same sentence about the REQUEST rather than the model. Zen answers
 * `Model space-bunny-free is not supported for format openai` (HTTP 401) when a
 * healthy model is sent down the wrong channel — the model is fine, the
 * request shape is not. Counting that as death would empty the picker the
 * moment channel inference ever picks wrong, so the format-scoped reading is
 * excluded explicitly. Observed 2026-09-29.
 */
const FORMAT_SCOPED_PATTERN = /\bfor\s+format\b|\bunsupported\s+format\b|\bformat\s+is\s+not\b/i;

/**
 * A failure about the ENDPOINT is not a failure about the model, and the two
 * are one word apart on this provider: `ling-3.0-flash-fin-free` answers
 * "Upstream request failed: Endpoint is unavailable." while the genuinely dead
 * `deepseek-v4-flash-free` answers the same sentence with "Model". Matching
 * "is unavailable" without this guard would empty the picker of working
 * models, so the endpoint reading is excluded by name.
 */
const ENDPOINT_FAILURE_PATTERN =
  /\bendpoint\b.{0,40}?\b(?:is|was)\s+(?:unavailable|unsupported|not\s+found|unreachable)\b/i;

/** Statuses that mean the addressed model itself is gone. */
const MODEL_GONE_STATUSES = new Set([404, 410]);

/**
 * Whether an upstream failure *positively* identifies this model as gone.
 *
 * `dead` is the only probe verdict that removes a model from the picker, so
 * this predicate is the whole safety boundary: it must not fire by default.
 * A single gated IP makes every model answer 403 `FreeTierError` at once —
 * if that reached `dead` the whole catalogue would empty itself. Every
 * specific marker the request path already understands is therefore excluded
 * *before* the model-gone check, so a body carrying both a quota marker and
 * model wording resolves to `inconclusive` (the safe side).
 */
export function isModelUnavailableFailure(status: number, bodyText: string): boolean {
  const body = typeof bodyText === "string" ? bodyText : "";
  // A gate, an exhausted quota, or a credential problem is never evidence
  // about the model itself. These run first and are stronger than any status:
  // a body carrying both a quota marker and model wording resolves to
  // `inconclusive`, the safe side.
  if (ANON_GATED_PATTERN.test(body)) return false;
  if (QUOTA_PATTERN.test(body)) return false;
  if (BAD_KEY_PATTERN.test(body)) return false;
  // Nor is an unreachable endpoint.
  if (ENDPOINT_FAILURE_PATTERN.test(body)) return false;
  if (MODEL_GONE_STATUSES.has(status)) return true;
  if (!MODEL_GONE_PATTERNS.some((pattern) => pattern.test(body))) return false;
  // "not supported for format openai" is the channel being wrong, not the
  // model being gone.
  if (FORMAT_SCOPED_PATTERN.test(body)) return false;
  // 429 is always the quota bucket, never the model.
  if (status === 429) return false;
  // 401 is usually the credential, but a body that NAMES the model as
  // unsupported is the route declining to serve it, which is the exact question
  // this probe was sent to answer — and a key would not change the answer,
  // since one changes the quota rather than the model list. A genuinely bad or
  // missing key never gets here: BAD_KEY_PATTERN above claims it first.
  return true;
}

/**
 * What one probe learned about a model.
 *
 * `inconclusive` is not a failure of the probe — it is the absence of a
 * conclusion, and the caller must leave visibility untouched for it (D5).
 *
 * `code` and `http` are the machine-readable half of the same fact, kept
 * beside the human `reason`: the panel localizes the wording itself, so it
 * never has to ship a Chinese diagnostic to an English reader, and `http: 0`
 * says "no status ever arrived" rather than repeating a zero.
 */
export type ProbeOutcome =
  | {
      kind: "ok";
      usage?: ProbeUsage;
      /** The channel that ANSWERED, when one did. */
      api?: Api;
    }
  | { kind: "dead"; reason: string; code: "dead"; http: number }
  | {
      kind: "inconclusive";
      reason: string;
      code: ProbeFailureCode;
      http: number;
      /** Which anonymous-gate marker the body carried, when it carried one. */
      marker?: AnonGateMarker;
    };

/**
 * What the upstream said it spent, when it said.
 *
 * Carried for measurement, not for judgement: nothing in the round reads it.
 * pi-ai already asks for `stream_options.include_usage` and attaches the parsed
 * usage to the result, so this is a field being passed along rather than a new
 * request — which matters, because the question it settles (does a 1024 ceiling
 * actually cost more than a 16 one?) could not be answered from wall clock, and
 * the number needed for the answer was being dropped on the floor.
 */
export interface ProbeUsage {
  readonly input?: number | undefined;
  readonly output?: number | undefined;
}

/** Why a probe did not get an answer the round could trust. */
export type ProbeFailureCode = "dead" | "timeout" | "transport" | ZenFailureKind | "error";

/**
 * The provider method a probe needs.
 *
 * `stream` is what it actually asks for, because that is the road production
 * travels; `streamSimple` stays accepted so a reduced provider still works, but
 * {@link probeOnce} explains why asking the cheap way measures something else.
 */
export interface ProbeStreamer {
  streamSimple(
    model: Model<Api>,
    context: unknown,
    options: Record<string, unknown>,
  ): { result(): Promise<Record<string, unknown>> };
}

export interface ProbeDeps {
  /** The provider to probe through (zenProvider()'s return value). */
  readonly provider: ProbeStreamer;
  /** Effective credential; "public" (the default) exercises the anonymous gate. */
  readonly apiKey?: string | undefined;
  /** Base fetch; defaults to the live global (already identity-guarded). */
  readonly fetchImpl?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
  /**
   * Output budget for the probe request. Defaults to {@link PROBE_MAX_TOKENS}.
   *
   * Exists so `scripts/probe-ab.mjs` can A/B the budget against the live tier
   * without editing the constant, and so a test can pin the shape. It is NOT a
   * tuning knob for production: the round must spend one fixed, disclosed amount
   * of the shared bucket, so nothing in `index.ts` passes this.
   */
  readonly maxTokens?: number | undefined;
  readonly now?: (() => number) | undefined;
}

/**
 * Wrap a fetch so the probe can read what the transport saw. The response is
 * cloned before it is handed on, so the provider still parses an untouched
 * body; a REJECTION is recorded too, because the provider resolves a socket
 * failure into a generic `stopReason: "error"` and the recorder is the only
 * place the cause is still intact.
 */
function createRecordingFetch(base: typeof fetch): {
  fetch: typeof fetch;
  read: () => { status: number; body: string; cause: string | undefined };
} {
  let status = 0;
  let body = "";
  let cause: string | undefined;
  const wrapped = (async (input: never, init?: never) => {
    try {
      const response = await (base as (u: never, i?: never) => Promise<Response>)(input, init);
      try {
        status = response.status;
        if (!response.ok) body = await response.clone().text();
      } catch {
        // An unreadable error body is not a conclusion; the status still stands.
      }
      return response;
    } catch (error) {
      // A dead socket never reaches a status, so without this the probe could
      // only say "unknown (HTTP 0)" — true, and useless to whoever has to
      // decide whether the panel's "untrustworthy" note is their network.
      if (cause === undefined) cause = describeTransportCause(error) || undefined;
      throw error;
    }
  }) as typeof fetch;
  return { fetch: wrapped, read: () => ({ status, body, cause }) };
}

/**
 * Whether a settled probe result proves the model answered.
 *
 * A `thinking` part counts. A reasoning model can spend the entire budget on
 * chain-of-thought and return `stopReason: "length"` with no text at all
 * (reproduced from 9router's issue #3010, which measured the same thing): the
 * model worked, it just never got to the answer. Requiring a text part reports
 * those models as failed, and the free tier is mostly reasoning models — so
 * that reading failed the models most likely to be good. `stopReason: "error"`
 * is still the one thing that settles it as no reply.
 */
function hasAnswer(result: Record<string, unknown> | undefined): boolean {
  if (!result || result.stopReason === "error") return false;
  const content = result.content;
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (part === null || typeof part !== "object") return false;
    const typed = part as { type?: unknown; text?: unknown; thinking?: unknown };
    if (typed.type === "text") return typeof typed.text === "string" && typed.text.trim() !== "";
    if (typed.type === "thinking") return typeof typed.thinking === "string" && typed.thinking.trim() !== "";
    return false;
  });
}

/**
 * Send one minimal request to `model` and classify the outcome.
 *
 * Never throws: a probe that cannot reach a conclusion returns
 * `inconclusive` rather than rejecting, so one bad model cannot abort a
 * catalogue-wide probe run.
 */
/**
 * The endpoints a probe may ask a model on. Exactly the two this provider
 * implements — `createProvider` below registers `openai-completions` and
 * `openai-responses` and nothing else, so a third entry would be a promise the
 * transport cannot keep: pi-ai throws `has no API implementation` client-side
 * before any fetch, and the sweep would count an unasked channel as asked.
 *
 * A model is only alive on ONE of them, and which one is not published:
 * 9router has to hard-code it (a set for the Muse Spark family, another for
 * `union-alpha`, plus a family regex), while this plugin infers a channel from
 * the models.dev record.
 *
 * That inference is the weak link, and it fails in the worst possible way. A
 * request down the wrong channel is refused with "model not supported" — which
 * reads exactly like a dead model. So a single wrong guess did not report a
 * routing mistake, it removed a working model from the picker permanently.
 * Asking the other channel before concluding anything is what makes the
 * verdict mean what it says: 9router's per-model test never hits this because
 * it always routes by its own hard-coded table, never by inference.
 */
const ZEN_CHANNELS: readonly Api[] = ["openai-completions", "openai-responses"];

/** The inferred channel first, then the rest. */
function probeChannels(model: Model<Api>): Api[] {
  return [model.api, ...ZEN_CHANNELS.filter((api) => api !== model.api)];
}

/**
 * Whether a failure could be this channel's fault rather than the model's.
 *
 * Only these are worth a second request. A gate (403) or a quota wall (429) is
 * channel-independent and retrying would spend the very quota being exhausted;
 * a timeout or a dead socket means the channel ACCEPTED the request, so the
 * model was reachable. Everything else — "not supported", "not found", a 4xx
 * the route rejected, or no conclusion at all — is exactly what the wrong
 * channel looks like.
 */
/**
 * Whether a conclusion is about the CALLER rather than the model, and so would
 * come back identical on every channel. A gate, an exhausted quota and a
 * rejected key are the same on both endpoints, and asking again would
 * spend the very quota that is already gone.
 */
function isCallerScoped(outcome: ProbeOutcome): boolean {
  // Only a failure carries a code; an `ok` never reaches here, but the type
  // says so and the check should not pretend otherwise.
  if (outcome.kind === "ok") return false;
  if (outcome.code === "anon-gated" || outcome.code === "quota-exhausted" || outcome.code === "bad-key")
    return true;
  // 403/429 only when it is NOT a "this model is gone" verdict: that sentence
  // is the wrong channel talking, and it must still be retried elsewhere.
  if (outcome.kind !== "dead" && (outcome.http === 403 || outcome.http === 429)) return true;
  return false;
}

/**
 * The token counts the upstream reported, if it reported any.
 *
 * Deliberately forgiving about shape: this rides on whatever pi-ai parsed out
 * of the stream, and a field that moves is a measurement problem, not a reason
 * to fail a probe that already has its answer. Anything unrecognised comes back
 * undefined rather than a guess.
 */
function usageOf(result: Record<string, unknown> | undefined): ProbeUsage | undefined {
  const raw = (result as { usage?: unknown } | undefined)?.usage;
  if (raw === null || typeof raw !== "object") return undefined;
  const count = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  const usage = {
    input: count((raw as { input?: unknown }).input),
    output: count((raw as { output?: unknown }).output),
  };
  return usage.input === undefined && usage.output === undefined ? undefined : usage;
}

/**
 * Send one minimal request to `model` on its current channel and classify it.
 *
 * Never throws: a probe that cannot reach a conclusion returns
 * `inconclusive` rather than rejecting, so one bad model cannot abort a
 * catalogue-wide probe run.
 */
async function probeOnce(model: Model<Api>, deps: ProbeDeps): Promise<ProbeOutcome> {
  const recorder = createRecordingFetch(deps.fetchImpl ?? globalThis.fetch);
  const context = {
    messages: [{ role: "user", content: PROBE_PROMPT, timestamp: deps.now?.() ?? Date.now() }],
  };
  const signal = AbortSignal.timeout(deps.timeoutMs ?? PROBE_TIMEOUT_MS);
  // Whether the request ran out of time is a property of the SIGNAL, not of
  // whichever error happens to surface: the provider flattens an abort into a
  // generic `stopReason: "error"` and the recorder's cause into a socket
  // failure, so the error object alone would report a timeout as a dead
  // socket — the one misreading the reader cannot act on.
  const expired = (error?: unknown): boolean =>
    signal.aborted ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
  let result: Record<string, unknown> | undefined;
  let thrown: unknown;
  try {
    // `streamSimple`, not `stream`. Measured 2026-09-30: `stream()` ignores
    // `model.api` and resolves its own transport, so a model the catalogue
    // pinned to `openai-completions` went out on the responses channel. The
    // probe must ask the channel the catalogue chose — that choice is what the
    // channel sweep is built around. Aligning the probe with the live agent
    // path (system prompt, real tool schemas, the profile's cacheRetention) was
    // tried and reverted: it changed nothing about the host's refusals, and the
    // only thing it did change was the channel.
    const stream = deps.provider.streamSimple(model, context, {
      apiKey: deps.apiKey ?? "public",
      maxTokens: deps.maxTokens ?? PROBE_MAX_TOKENS,
      // The default reasoning effort for muse-spark is xhigh; a probe only
      // needs any reply, so it asks for the cheapest one.
      reasoning: "low",
      // The last gate before the bytes leave. See enforceAnonymousTools.
      onPayload: (payload: unknown) => enforceAnonymousTools(payload),
      // A probe must not spend a second call confirming anything: without this
      // a 429 costs three requests instead of one, because the SDK's default
      // retry policy treats a rate limit as worth repeating. Production retries
      // on a policy keyed to specific stop reasons; a refusal is not one of
      // them, so matching production here would only spend the shared bucket.
      maxRetries: 0,
      signal,
      fetch: recorder.fetch,
    });
    result = await stream.result();
  } catch (error) {
    thrown = error;
  }
  if (thrown !== undefined) {
    const detail =
      thrown instanceof Error ? `${thrown.name}: ${thrown.message || "(empty)"}` : String(thrown);
    const timedOut = expired(thrown);
    return {
      kind: "inconclusive",
      reason: timedOut
        ? `probe timed out after ${deps.timeoutMs ?? PROBE_TIMEOUT_MS}ms`
        : `transport failure — ${detail.slice(0, 200)}`,
      code: timedOut ? "timeout" : "transport",
      http: 0,
    };
  }
  // A reply settles the question: the model answers, so it is not dead.
  // The usage is carried through rather than dropped: it decides nothing here,
  // but it is the only way to tell what a probe actually costs, and the
  // upstream already computed it.
  if (hasAnswer(result)) return { kind: "ok", usage: usageOf(result) };
  const { status, body, cause } = recorder.read();
  // The body is the only place the upstream's actual words exist, and an
  // `inconclusive` is never persisted — so without this a refusal is
  // unanswerable once the round ends. Three rounds of diagnosis failed on
  // exactly that: "which of FreeTierError / MissingSessionID / OpenCode-only
  // was it?" could not be asked of any artifact. Off unless the operator turns
  // it on, and truncated: this is an upstream error payload, never a request.
  if (body !== "") {
    debugLog(`probe <- ${status} marker=${String(anonGateMarker(body))} body=${body.slice(0, 300)}`);
  }
  if (expired()) {
    return {
      kind: "inconclusive",
      reason: `probe timed out after ${deps.timeoutMs ?? PROBE_TIMEOUT_MS}ms`,
      code: "timeout",
      http: status,
    };
  }
  // No response was ever received, so there is no status to report. Naming the
  // socket cause is the whole value of this branch: it is what separates "my
  // network is down" from "the anonymous tier is refusing", and the two need
  // completely different things from the reader.
  if (cause !== undefined) {
    // The recorder keeps the socket cause intact while the SDK flattens it, so
    // the abort shows up HERE rather than as a throw. Reading it is what keeps
    // a timeout from being reported as "your network broke".
    const abortedCause = /abort|timeout/i.test(cause);
    return {
      kind: "inconclusive",
      reason: abortedCause
        ? `probe timed out after ${deps.timeoutMs ?? PROBE_TIMEOUT_MS}ms`
        : `transport failure — ${cause}`,
      code: abortedCause ? "timeout" : "transport",
      http: 0,
    };
  }
  if (isModelUnavailableFailure(status, body)) {
    return {
      kind: "dead",
      reason: `上游回報此模型不可用（HTTP ${status}）`,
      code: "dead",
      http: status,
    };
  }
  if (status === 0) {
    const kind = classifyZenFailure(status, body);
    return { kind: "inconclusive", reason: kind, code: kind, http: 0, marker: anonGateMarker(body) };
  }
  const kind = classifyZenFailure(status, body);
  return {
    kind: "inconclusive",
    reason: `${kind}（HTTP ${status}）`,
    code: kind,
    http: status,
    marker: anonGateMarker(body),
  };
}

/**
 * Ask a model on each channel Zen might serve it on, and conclude only once all
 * of them have been asked.
 *
 * The inferred channel goes first, so the common case still costs one request;
 * the extra requests are spent only on a model that has already failed. A
 * positive "this model is gone" is held, not returned, until the other channels
 * have had their chance — because that sentence is also exactly what the wrong
 * channel answers with, and `dead` is permanent.
 *
 * `dead` additionally requires that every channel that was asked FINISHED. A
 * channel that never answered — a dropped socket, a timeout, an unrecognised
 * body — has not said anything about the model, and "this request did not
 * complete" is not "this model is gone". Ranking a `dead` above such silence
 * (which is what a strength comparison does) let one transport failure on the
 * second channel turn a wrong-channel 404 into a permanent removal: the 404 was
 * the wrong channel talking, and the channel that might have contradicted it was
 * never reached. Silence vetoes; it does not merely lose an argument.
 */
export async function probeModel(model: Model<Api>, deps: ProbeDeps): Promise<ProbeOutcome> {
  // Null, not a placeholder conclusion: a placeholder would tie with a real
  // inconclusive on strength and then win the "first seen wins" tie-break,
  // replacing a transport failure with "no channel answered".
  let last: ProbeOutcome | null = null;
  // The first channel that failed to answer, kept for its reason and status —
  // the row has to say WHY it could not tell, not just that it could not.
  let silent: ProbeOutcome | null = null;
  for (const api of probeChannels(model)) {
    // A channel swap is a different transport, so it must not inherit the
    // previous channel's `compat` overrides — the same rule the catalogue's
    // own builder follows when it derives a model onto a different api.
    const variant: Model<Api> = api === model.api ? model : { ...model, api, compat: undefined };
    const outcome = await probeOnce(variant, deps);
    // An answer ends the question. So does anything about the caller, which
    // every channel would report identically.
    if (outcome.kind === "ok") return { ...outcome, api: variant.api };
    if (isCallerScoped(outcome)) return outcome;
    if (outcome.kind === "dead") {
      last = outcome;
      continue;
    }
    if (silent === null) silent = outcome;
  }
  if (silent !== null) return silent;
  return (
    last ?? {
      kind: "inconclusive",
      reason: "no channel answered",
      code: "unknown",
      http: 0,
    }
  );
}

/**
 * Key priority: plugin `apiKey` config first, then `OPENCODE_API_KEY`, then
 * anonymous "public".
 */
export async function resolveZenApiKey(input: {
  env: (name: string) => Promise<string | undefined>;
  configKey?: string | undefined;
}): Promise<{ apiKey: string; source: string }> {
  const configured = input.configKey?.trim();
  if (configured) return { apiKey: configured, source: "plugin apiKey config" };
  let envKey: string | undefined;
  try {
    envKey = (await input.env(ZEN_API_KEY_ENV))?.trim() || undefined;
  } catch {
    envKey = undefined;
  }
  if (envKey) return { apiKey: envKey, source: ZEN_API_KEY_ENV };
  return { apiKey: "public", source: "Anonymous free tier" };
}

function compatRequestOptions<T extends StreamOptions>(
  options: T,
  getSessionId: SessionGetter,
  fallbackSession: string,
  recorder?: TransportRecorder,
): T {
  const headers = Object.fromEntries(
    Object.entries(options?.headers ?? {}).filter(
      ([name]) =>
        ![
          "authorization",
          "user-agent",
          "x-opencode-session",
          "x-opencode-client",
          "x-opencode-project",
          "x-opencode-request",
        ].includes(name.toLowerCase()),
    ),
  );
  const opencodeSession = sessionHeader(options?.sessionId ?? getSessionId() ?? fallbackSession);
  // An explicitly resolved key (config, env, or override) is honored;
  // otherwise anonymous. Authorization is rebuilt from the effective key so a
  // stale incoming header can never mismatch it.
  const rawKey = (options as { apiKey?: unknown } | undefined)?.apiKey;
  const effectiveApiKey = typeof rawKey === "string" && rawKey.trim() ? rawKey : "public";
  const incomingPayload = (options as { onPayload?: unknown } | undefined)?.onPayload;
  return {
    ...options,
    apiKey: effectiveApiKey,
    // Pi core compaction forces cacheRetention "none", for which pi-ai drops
    // its own session-affinity headers downstream — yet Zen 403s requests
    // missing it while identical ones carrying it pass. Set it explicitly here
    // so the drop cannot remove it. Same affinity value as x-opencode-session.
    sessionId: opencodeSession,
    timeoutMs: options?.timeoutMs ?? 180_000,
    maxRetries: options?.maxRetries ?? 2,
    fetch: withEncryptedContentFallback(options?.fetch as FetchFunction | undefined, recorder) as T["fetch"],
    // "off" is offered as an explicit level (the user asked to keep it), but
    // pi-ai renders it as `reasoning: { effort: "none" }` by default and as
    // `effort: "off"` when explicitly chosen on the responses channel — two
    // values neither pi-ai's own records nor OpenCode ever send. This strips
    // exactly those placeholders back to "no reasoning object", which is what
    // OpenCode's "Default" sends. Real levels pass through untouched, and a
    // caller-provided onPayload runs first so its edits are what get checked.
    onPayload: (async (payload: unknown, model: never) => {
      let next = payload as Record<string, unknown>;
      if (typeof incomingPayload === "function") {
        const out = await (incomingPayload as (p: never, m: never) => unknown)(payload as never, model);
        if (out !== undefined) next = out as Record<string, unknown>;
      }
      const reasoning = next?.reasoning;
      if (reasoning !== null && typeof reasoning === "object") {
        const effort = (reasoning as { effort?: unknown }).effort;
        if (effort === "none" || effort === "off") {
          const { reasoning: _dropped, ...rest } = next;
          return rest;
        }
      }
      return next === payload ? undefined : next;
    }) as T["onPayload"],
    headers: {
      ...headers,
      Authorization: `Bearer ${effectiveApiKey}`,
      "x-client-request-id": opencodeSession,
      "x-opencode-session": opencodeSession,
      "x-opencode-client": OPENCODE_CLIENT,
      "x-opencode-project": OPENCODE_PROJECT,
      "x-opencode-request": requestHeader(),
      "User-Agent": OPENCODE_USER_AGENT,
    },
  };
}

/**
 * The ids Zen currently serves, from one `GET /zen/v1/models`.
 *
 * This is the free tier's availability check, and it is deliberately the cheap
 * one: a catalogue GET costs no inference quota, so it can be asked far more
 * often than a completion can be spent. 9router reaches the same conclusion
 * about its OpenCode Free provider — its connection test is exactly this
 * request, `valid = res.ok` — which is why asking it per model id is affordable
 * here in a way asking a completion per model id is not.
 *
 * The headers are 9router's, and they are load-bearing rather than
 * decorative: the same request without `Bearer public` and a versioned
 * `opencode/x.y.z` User-Agent is the shape the free tier answers with 403
 * `FreeTierError`. One function so the host refresh and the probe round cannot
 * drift into asking upstream two different questions.
 *
 * Resolves null on any failure or malformed body: a null must never narrow the
 * catalogue, only a successful answer may.
 */
export async function fetchZenModelIds(
  fetchImpl: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<readonly string[] | null> {
  try {
    const response = await fetchImpl(`${BASE_URL}/models`, {
      signal: signal ?? AbortSignal.timeout(5000),
      headers: {
        Authorization: `Bearer ${ANONYMOUS_KEY}`,
        "User-Agent": OPENCODE_USER_AGENT,
        "x-opencode-client": OPENCODE_CLIENT,
      },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: { id?: unknown }[] } | null;
    if (body === null || typeof body !== "object" || !Array.isArray(body.data)) return null;
    const ids = body.data
      .map((entry) => (entry === null || typeof entry !== "object" ? "" : (entry as { id?: unknown }).id))
      // Upstream ids are strings; anything else is not a model id we can gate on.
      .filter((id): id is string => typeof id === "string" && id !== "");
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}

export function patchCompatDirectTransport(getSessionId: SessionGetter = () => undefined): void {
  const stash = compatOriginals();
  for (const api of SUPPORTED_APIS) {
    if (!stash.has(api)) {
      const current = getApiProvider(api);
      if (!current) continue;
      stash.set(api, current);
    }
    const original = stash.get(api)!;
    const fallbackSession = randomUUID();
    const origStream = (original.stream as (...args: never[]) => unknown).bind(original);
    const origStreamSimple = (original.streamSimple as (...args: never[]) => unknown).bind(original);
    registerApiProvider(
      {
        api: api as Parameters<typeof registerApiProvider>[0]["api"],
        stream: ((model: Model<Api>, context: never, options: StreamOptions) => {
          if ((model as Model<Api>).provider !== PROVIDER_ID)
            return origStream(model as never, context as never, options as never);
          const key = (options as { apiKey?: unknown } | undefined)?.apiKey;
          const gate = applyAnonymousToolGate(swapCompactionPrompt(toTranscript(context), key), key);
          const ctx = gate.context;
          const recorder = createTransportRecorder(options?.fetch as FetchFunction | undefined);
          const processed = compatRequestOptions(options, getSessionId, fallbackSession, recorder);
          debugLog(
            `${identitySummary(new Headers(processed.headers as HeadersInit | undefined), "compat")} ${shapeSummary(ctx, options)}`,
          );
          const out = origStream(model as never, ctx as never, processed as never);
          return withGuidance(out as object, gate.restoreShell, recorder);
        }) as never,
        streamSimple: ((model: Model<Api>, context: never, options: StreamOptions) => {
          if ((model as Model<Api>).provider !== PROVIDER_ID)
            return origStreamSimple(model as never, context as never, options as never);
          // No reasoning default here: compat omission means off.
          const key = (options as { apiKey?: unknown } | undefined)?.apiKey;
          const gate = applyAnonymousToolGate(swapCompactionPrompt(toTranscript(context), key), key);
          const ctx = gate.context;
          const recorder = createTransportRecorder(options?.fetch as FetchFunction | undefined);
          const processed = compatRequestOptions(options, getSessionId, fallbackSession, recorder);
          debugLog(
            `${identitySummary(new Headers(processed.headers as HeadersInit | undefined), "compat")} ${shapeSummary(ctx, options)}`,
          );
          const out = origStreamSimple(model as never, ctx as never, processed as never);
          return withGuidance(out as object, gate.restoreShell, recorder);
        }) as never,
      },
      "dsh-opencode-free",
    );
  }
}

/**
 * Last-resort guard: wrap global fetch so ANY in-process request to the Zen
 * base URL carries the free-tier identity, even paths that bypass both the
 * Models wrapper and the compat patch. Scoped strictly to BASE_URL; all other
 * hosts pass through untouched.
 */
const FETCH_GUARD_ORIGINAL_KEY = "__dshOpenCodeFreeFetchOriginal";
const ZEN_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

/** Set DSH_OPENCODE_FREE_DEBUG=1 to log Zen-bound request identity to stderr. */
function debugLog(message: string): void {
  try {
    if (typeof process !== "undefined" && process.env?.DSH_OPENCODE_FREE_DEBUG === "1") {
      console.error(`[dsh-opencode-free] ${message}`);
    }
  } catch {
    // Logging must never break requests.
  }
}

function identitySummary(headers: Headers, via: string): string {
  const ua = headers.get("User-Agent") ?? "(missing)";
  const session = headers.get("x-opencode-session") ?? "(missing)";
  const auth = headers.get("authorization") ?? "(missing)";
  const arid = headers.get("x-client-request-id") ?? "(missing)";
  return `${via} ua=${ua.slice(0, 28)}... session=${session.slice(0, 12)}... auth=${auth.slice(0, 14)}... arid=${arid.slice(0, 12)}...`;
}

/** Sizes and shape only — never content. */
function shapeSummary(context: unknown, options: unknown): string {
  try {
    const ctx = (context ?? {}) as { messages?: unknown[]; tools?: unknown[] };
    const opt = (options ?? {}) as { reasoning?: unknown; maxTokens?: unknown };
    let chars = 0;
    if (Array.isArray(ctx.messages)) {
      for (const m of ctx.messages) {
        const s = JSON.stringify(m) ?? "";
        chars += s.length;
        if (chars > 10_000_000) break;
      }
    }
    const tools = Array.isArray(ctx.messages)
      ? getCurrentTools(ctx.messages as Parameters<typeof getCurrentTools>[0]).length
      : 0;
    return `msgs=${Array.isArray(ctx.messages) ? ctx.messages.length : "?"} chars~${chars} tools=${tools} reasoning=${String(opt.reasoning ?? "(default)")}`;
  } catch {
    return "shape=(unavailable)";
  }
}

function zenPath(input: unknown): string {
  try {
    if (typeof input === "string") return new URL(input).pathname;
    if (input instanceof URL) return input.pathname;
    const url = (input as { url?: unknown })?.url;
    if (typeof url === "string") return new URL(url).pathname;
    return String(input).slice(0, 80);
  } catch {
    return "(unparseable)";
  }
}

function isZenRequest(input: unknown): boolean {
  try {
    if (typeof input === "string") return input.startsWith(BASE_URL);
    if (input instanceof URL) return input.href.startsWith(BASE_URL);
    if (input && typeof input === "object") {
      const maybe = (input as { url?: unknown }).url;
      if (typeof maybe === "string") return maybe.startsWith(BASE_URL);
    }
    return String(input).startsWith(BASE_URL);
  } catch {
    return false;
  }
}

export function patchGlobalFetchForZen(getSessionId: SessionGetter = () => undefined): () => void {
  const g = globalThis as Record<string, unknown>;
  if (!g[FETCH_GUARD_ORIGINAL_KEY]) g[FETCH_GUARD_ORIGINAL_KEY] = globalThis.fetch;
  const original = g[FETCH_GUARD_ORIGINAL_KEY] as typeof fetch;
  const callOriginal = (input: unknown, init: unknown): Promise<Response> =>
    (original as (u: never, i: never) => Promise<Response>)(input as never, init as never);
  const guarded = (async (input: unknown, init?: unknown) => {
    if (!isZenRequest(input)) return callOriginal(input, init);
    const rawInit = (init ?? {}) as Record<string, unknown>;
    // The fallback below is scoped to the identity rewrite and NOTHING else.
    // It used to wrap the whole body, so the inner `catch` that rethrows a
    // network failure landed here too and the request went out a SECOND time
    // with the un-rewritten `init` — no Authorization, no session — which the
    // upstream answers 403 FreeTierError. A Wi-Fi blip then surfaced as "the
    // anonymous tier refused us", destroying exactly the diagnosis
    // createTransportRecorder/describeTransportCause exist to provide
    //.
    let headers: Headers;
    try {
      headers = new Headers(rawInit.headers as HeadersInit | undefined);
      const existing = headers.get("x-opencode-session");
      const session =
        existing && ZEN_SESSION_PATTERN.test(existing)
          ? existing
          : sessionHeader(getSessionId() ?? randomUUID());
      applyZenIdentity(headers, { session, apiKey: ANONYMOUS_KEY });
    } catch {
      // The identity could not be built. Send the request unchanged rather than
      // crash the caller — but this is the ONLY case that falls back.
      return callOriginal(input, init);
    }
    debugLog(identitySummary(headers, "fetch"));
    const startedAt = Date.now();
    try {
      const response = await callOriginal(input, { ...rawInit, headers });
      debugLog(`fetch <- ${response.status} ${zenPath(input)} after ${Date.now() - startedAt}ms`);
      return response;
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message || "(empty)"}` : String(error);
      debugLog(`fetch FAILED ${zenPath(input)} after ${Date.now() - startedAt}ms: ${detail.slice(0, 200)}`);
      throw error;
    }
  }) as typeof fetch;
  globalThis.fetch = guarded;
  // Restore, so unloading the plugin does not leave the process permanently
  // wrapped — including for other plugins and the host itself, which share this
  // global. Idempotent: calling it twice is a no-op.
  return () => {
    if (globalThis.fetch === guarded) globalThis.fetch = original;
  };
}

/**
 * Same identity as the fetch guard, for callers that speak node:http/https
 * directly (axios / node-fetch style code in any extension or in-process MCP
 * tool). Other hosts pass through untouched.
 */
export type NodeHeadersInit =
  Record<string, string | string[] | number | undefined> | [string, string][] | Headers | undefined;

function readNodeHeader(headers: NodeHeadersInit, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    for (let i = headers.length - 1; i >= 0; i--) {
      const pair = headers[i];
      if (pair && pair[0]?.toLowerCase() === lower) return String(pair[1]);
    }
    return undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue;
    if (value === undefined) return undefined;
    return Array.isArray(value) ? String(value[0]) : String(value);
  }
  return undefined;
}

export function applyZenHeadersToNodeHeaders(
  headers: NodeHeadersInit,
  getSessionId: SessionGetter = () => undefined,
): NodeHeadersInit {
  let out = headers;
  const set = (name: string, value: string): void => {
    if (!out) {
      out = { [name]: value };
      return;
    }
    if (out instanceof Headers) {
      out.set(name, value);
      return;
    }
    if (Array.isArray(out)) {
      const lower = name.toLowerCase();
      out = [...out.filter((pair) => pair?.[0]?.toLowerCase() !== lower), [name, value] as [string, string]];
      return;
    }
    const lower = name.toLowerCase();
    for (const key of Object.keys(out)) {
      if (key.toLowerCase() === lower) delete (out as Record<string, unknown>)[key];
    }
    (out as Record<string, string>)[name] = value;
  };
  const existing = readNodeHeader(out, "x-opencode-session");
  const session =
    existing && ZEN_SESSION_PATTERN.test(existing) ? existing : sessionHeader(getSessionId() ?? randomUUID());
  // The SAME owner the fetch guard uses, driven through the node:http shape's
  // set() helper — one list, one session id, three ids that must agree.
  for (const name of ZEN_IDENTITY_HEADERS) {
    const want =
      name === "Authorization"
        ? `Bearer ${readNodeHeader(out, "authorization") ? String(readNodeHeader(out, "authorization")).replace(/^Bearers+/i, "") : ANONYMOUS_KEY}`
        : name === "User-Agent"
          ? OPENCODE_USER_AGENT
          : name === "x-opencode-client"
            ? OPENCODE_CLIENT
            : name === "x-opencode-project"
              ? OPENCODE_PROJECT
              : name === "x-opencode-session" || name === "x-client-request-id"
                ? session
                : requestHeader();
    if (name === "Authorization" && readNodeHeader(out, "authorization")) continue;
    if (name === "x-opencode-request" && readNodeHeader(out, "x-opencode-request")) continue;
    set(name, want);
  }
  return out;
}

function splitHttpArgs(args: unknown[]): { options: Record<string, unknown>; callback: unknown } {
  const [first, second, third] = args;
  if (typeof first === "string" || first instanceof URL) {
    const url = typeof first === "string" ? new URL(first) : first;
    const opts = (typeof second === "object" && second !== null ? second : {}) as Record<string, unknown>;
    return {
      options: {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        ...opts,
      },
      callback: typeof second === "function" ? second : third,
    };
  }
  return { options: { ...((first as Record<string, unknown> | undefined) ?? {}) }, callback: second };
}

export function isZenNodeRequestOptions(options: Record<string, unknown>): boolean {
  const host = String(options.hostname ?? options.host ?? "")
    .split(":")[0]
    ?.toLowerCase();
  return host === "opencode.ai" && String(options.path ?? "/").startsWith("/zen/v1");
}

const NODE_HTTP_ORIGINALS_KEY = "__dshOpenCodeFreeNodeHttpOriginals";

type NodeHttpModule = Record<string, (...args: never[]) => unknown>;

function nodeHttpStash(): Map<string, (...args: never[]) => unknown> {
  const g = globalThis as Record<string, unknown>;
  const existing = g[NODE_HTTP_ORIGINALS_KEY];
  if (existing instanceof Map) return existing as Map<string, (...args: never[]) => unknown>;
  const created = new Map<string, (...args: never[]) => unknown>();
  g[NODE_HTTP_ORIGINALS_KEY] = created;
  return created;
}

export function patchNodeHttpForZen(getSessionId: SessionGetter = () => undefined): () => void {
  const require = createRequire(import.meta.url);
  const targets: [string, NodeHttpModule][] = [
    ["http", require("node:http")],
    ["https", require("node:https")],
  ];
  const stash = nodeHttpStash();
  // The pristine function behind each replacement, so unloading can put them
  // back. `stash` alone is not enough: it keeps the originals for idempotence
  // across reloads, but nothing ever wrote them back onto the module objects,
  // so a disabled plugin left every node:http request in the process wrapped
  //.
  const replaced: Array<[NodeHttpModule, string, unknown, unknown]> = [];
  for (const [modName, mod] of targets) {
    for (const fnName of ["request", "get"]) {
      const key = `${modName}.${fnName}`;
      if (!stash.has(key) && typeof mod[fnName] === "function") stash.set(key, mod[fnName]);
      const original = stash.get(key);
      if (!original) continue;
      const callOriginal = (self: unknown, args: unknown[]): unknown =>
        (original as (...a: unknown[]) => unknown).apply(self, args);
      const wrapped = function (this: unknown, ...args: unknown[]) {
        try {
          const { options, callback } = splitHttpArgs(args);
          if (!isZenNodeRequestOptions(options)) return callOriginal(this, args);
          options.headers = applyZenHeadersToNodeHeaders(
            options.headers as NodeHeadersInit,
            getSessionId,
          ) as unknown as Record<string, unknown>;
          return callOriginal(this, [options, callback]);
        } catch {
          return callOriginal(this, args);
        }
      };
      mod[fnName] = wrapped as (...args: never[]) => unknown;
      replaced.push([mod, fnName, original, wrapped]);
    }
  }
  // Restore, but only what is still OURS. This is the ownership check the
  // fetch guard already makes one function above: a plugin that wrapped
  // `http.request` after us is not ours to remove, and restoring over its head
  // silently disabled it. It also makes repeated disposal a true no-op, and it
  // fixes the reload order — an older patch's disposer used to strip the newer
  // patch's wrapper and leave the process unwrapped.
  return () => {
    for (const [mod, fnName, original, wrapped] of replaced) {
      if (typeof original === "function" && mod[fnName] === wrapped) {
        mod[fnName] = original as (...args: never[]) => unknown;
      }
    }
  };
}

/**
 * Rewrite a resolved transport failure into actionable guidance. pi-ai
 * resolves HTTP failures as `{ stopReason: "error", errorMessage }` (live
 * probe: `"OpenAI API error (403): {full body}"`), so status and body are
 * both recoverable here with full fidelity. Unknown shapes pass through
 * untouched; iteration behavior is never altered, only `result()`.
 */
const TRANSPORT_ERROR_PATTERN = /(?:\((\d{3})\):|^(\d{3}):? )([\s\S]*)$/;

/**
 * Append the recorded socket reason to a failure the HTTP classifier could not
 * place. APPENDED, never substituted: the host derives the failure class from
 * this very message, and the upstream wording that got here ("Connection
 * error.", "terminated") is what carries it.
 */
function appendTransportDetail<T extends Record<string, unknown>>(
  record: T,
  message: string,
  recorder?: TransportRecorder,
): T {
  const detail = recorder?.detail();
  if (detail === undefined || message.includes(detail)) return record;
  return { ...record, errorMessage: `${message}｜${ZEN_TRANSPORT_GUIDANCE}（${detail}）` } as T;
}

export function mapTransportErrorToGuidance<T>(result: T, recorder?: TransportRecorder): T {
  if (!result || typeof result !== "object") return result;
  const rec = result as Record<string, unknown>;
  if (rec.stopReason !== "error" || typeof rec.errorMessage !== "string") return result;
  const m = TRANSPORT_ERROR_PATTERN.exec(rec.errorMessage);
  if (!m) return appendTransportDetail(rec, rec.errorMessage, recorder) as T;
  const kind = classifyZenFailure(Number(m[1] ?? m[2]), m[3] ?? "");
  if (kind === "unknown") return appendTransportDetail(rec, rec.errorMessage, recorder) as T;
  const status = m[1] ?? m[2];
  return {
    ...rec,
    errorMessage: `${ZEN_FAILURE_GUIDANCE[kind]}（上游 HTTP ${status}）`,
  } as T;
}

function mapEventErrorToGuidance<T>(event: T, recorder?: TransportRecorder): T {
  if (!event || typeof event !== "object") return event;
  const rec = event as Record<string, unknown>;
  if (rec.type !== "error") return event;
  const inner = rec.error as Record<string, unknown> | undefined;
  if (!inner || typeof inner !== "object" || typeof inner.errorMessage !== "string") return event;
  const m = TRANSPORT_ERROR_PATTERN.exec(inner.errorMessage);
  if (!m) {
    return { ...rec, error: appendTransportDetail(inner, inner.errorMessage, recorder) } as T;
  }
  const kind = classifyZenFailure(Number(m[1] ?? m[2]), m[3] ?? "");
  if (kind === "unknown") {
    return { ...rec, error: appendTransportDetail(inner, inner.errorMessage, recorder) } as T;
  }
  const status = m[1] ?? m[2];
  return {
    ...rec,
    error: {
      ...inner,
      errorMessage: `${ZEN_FAILURE_GUIDANCE[kind]}（上游 HTTP ${status}）`,
    },
  } as T;
}

function withGuidance<T extends object>(stream: T, restoreShell = false, recorder?: TransportRecorder): T {
  return new Proxy(stream, {
    get(target, prop, _receiver) {
      if (prop === "result") {
        const inner = (target as { result: () => Promise<unknown> }).result;
        return async () => {
          const result = await inner.call(target);
          if (restoreShell) restoreShellCalls(result);
          return mapTransportErrorToGuidance(result, recorder);
        };
      }
      if (prop === Symbol.asyncIterator) {
        // Not every stream shape is async-iterable — this module's own
        // ProbeStreamer declares only `result()`. `undefined.bind` used to throw
        // a TypeError whose message named "bind" and nothing about the real
        // problem, from a property ACCESS rather than from the call
        //.
        const iter = (target as Record<symbol, unknown>)[Symbol.asyncIterator];
        if (typeof iter !== "function") return Reflect.get(target, prop, target);
        const inner = (iter as () => AsyncIterableIterator<unknown>).bind(target);
        return async function* () {
          for await (const event of inner()) {
            if (restoreShell) restoreShellCalls(event);
            yield mapEventErrorToGuidance(event, recorder);
          }
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Reuse pi-ai's native serializers, streaming parsers, reasoning, and tool handling. */
export interface ZenProviderOptions {
  /**
   * The models.dev-derived catalogue (see `catalog.ts`). When present it owns
   * which models are offered: `getModels()` reads its post-Zen-gate list, and
   * `refreshModels` intersects ITS pre-gate list against Zen. Omitted, the
   * provider falls back to the pi-ai builtin free set, which is what every
   * pre-catalogue caller and test expects.
   */
  readonly catalog?: Catalog | undefined;
}

export function zenProvider(
  getSessionId: () => string | undefined = () => undefined,
  getConfigKey: () => string | undefined = () => undefined,
  options: ZenProviderOptions = {},
): Provider {
  const fallbackSession = randomUUID();
  const catalog = options.catalog ?? null;
  // Unconditional: null is itself a valid value (the pre-catalogue path).
  // Leaving the previous instance's catalogue in place made freeModels()
  // report a provider that no longer existed.
  activeCatalog = catalog;
  // Pre-gate catalogue: the full derived set is what Zen's live list gets
  // intersected against, so a model Zen dropped can come back when it returns.
  const baseline = catalog === null ? builtinFreeModels() : catalog.current().models;
  // What the picker actually offers. With no gate applied yet (first boot,
  // or Zen never asked) this is the pre-gate list, so it is read live rather
  // than snapshotted: a later applyZenGate() must be visible immediately.
  const effective = (): Model<Api>[] => (catalog === null ? catalogue : catalog.effectiveModels());
  let catalogue = baseline;
  const provider = createProvider({
    id: PROVIDER_ID,
    name: "OpenCode Zen Free",
    baseUrl: BASE_URL,
    headers: { ...STATIC_ZEN_HEADERS },
    auth: {
      apiKey: {
        name: "OpenCode Zen API key (or anonymous free tier)",
        async resolve({ ctx }) {
          // Headers here feed modelRegistry.getApiKeyAndHeaders(), which is
          // what side-channels forward as options.headers into compat
          // createClient. Main path still sets full dynamic headers in
          // requestOptions().
          const resolved = await resolveZenApiKey({
            env: (name) => ctx.env(name),
            configKey: getConfigKey(),
          });
          return {
            auth: { apiKey: resolved.apiKey, headers: { ...STATIC_ZEN_HEADERS } },
            source: resolved.source,
          };
        },
      },
    },
    models: baseline,
    api: {
      "openai-responses": openAIResponsesApi(),
      "openai-completions": openAICompletionsApi(),
    },
  });

  function requestOptions<T extends StreamOptions>(
    options: T = {} as T,
    context?: unknown,
  ): { processed: T; recorder: TransportRecorder } {
    const recorder = createTransportRecorder(options?.fetch as FetchFunction | undefined);
    const processed = compatRequestOptions(options, getSessionId, fallbackSession, recorder);
    debugLog(
      `${identitySummary(new Headers(processed.headers as HeadersInit | undefined), "provider")} ${shapeSummary(context, options)}`,
    );
    return { processed, recorder };
  }

  return {
    ...provider,
    // With a catalogue attached this is its post-gate list, so the picker, the
    // exported freeModels(), and the panel endpoint all report one list.
    getModels: () => effective(),
    async refreshModels(ctx) {
      const select = (ids: Set<unknown>) => baseline.filter((m) => ids.has(m.id));
      if (ctx.stored) {
        const restored = select(new Set(ctx.stored.models.map((m) => m.id)));
        if (
          !(await ctx.publish({
            update: () => {
              catalogue = restored;
            },
          }))
        )
          return;
      }
      if (!ctx.allowNetwork || ctx.signal.aborted) return;
      const signal = ctx.signal;
      // The same fetch the probe round uses. One function, so the host refresh
      // and a probe round cannot end up asking upstream two different questions
      // and disagreeing about the same model.
      const availableIds = await fetchZenModelIds(globalThis.fetch, signal);
      if (availableIds === null) throw new Error("Zen model catalogue unavailable");
      const available = new Set<unknown>(availableIds);
      const next = select(available);
      // D3: Zen is the availability gate. Handing the live ids to the
      // catalogue (rather than intersecting a second time here) is what keeps
      // one computation behind both the picker and the panel's `visible`.
      if (catalog !== null) catalog.applyZenGate(availableIds);
      await ctx.publish({
        persist: { models: next, checkedAt: Date.now() },
        update: () => {
          catalogue = next;
        },
      });
    },
    stream(model, context, options) {
      const key = (options as { apiKey?: unknown } | undefined)?.apiKey;
      const gate = applyAnonymousToolGate(swapCompactionPrompt(toTranscript(context), key), key);
      const { processed, recorder } = requestOptions(options, gate.context);
      return withGuidance(provider.stream(model, gate.context, processed), gate.restoreShell, recorder);
    },
    streamSimple(model, context, options) {
      const key = (options as { apiKey?: unknown } | undefined)?.apiKey;
      const gate = applyAnonymousToolGate(swapCompactionPrompt(toTranscript(context), key), key);
      const { processed, recorder } = requestOptions(options, gate.context);
      return withGuidance(
        provider.streamSimple(model, gate.context, {
          ...processed,
          reasoning: options?.reasoning ?? (model.id.startsWith("muse-spark-") ? "xhigh" : undefined),
        }),
        gate.restoreShell,
        recorder,
      );
    },
  };
}
