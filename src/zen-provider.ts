/**
 * OpenCode Zen free-tier provider, ported from `pi-opencode-direct` to the
 * pi-ai `0.87.1` API that DSH `0.2.0-rc.2` uses.
 *
 * Same idea as the Pi extension: native HTTP through pi-ai's own
 * `openai-responses` / `openai-completions` transports, anonymous `public`
 * bearer by default, optional `OPENCODE_API_KEY`, OpenCode gate headers,
 * per-session routing affinity, encrypted-content retry, and the
 * byte-identical OpenCode compaction prompt for anonymous summarization.
 *
 * pi-ai 0.87 providers receive a `TranscriptContext`: `Models.streamSimple()`
 * (what DSH's `PiAiAdapter` calls) folds `systemPrompt` and `tools` into a
 * leading system message. Direct callers may still pass a legacy `Context`,
 * so every entry point normalizes first and rewrites the transcript only.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  createInitialSystemMessage,
  createProvider,
  getCurrentSystemPrompt,
  getCurrentTools,
  normalizeContext,
  type Context,
  type Api,
  type FetchFunction,
  type Model,
  type Provider,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { getApiProvider, registerApiProvider } from "@earendil-works/pi-ai/compat";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

export const PROVIDER_ID = "opencode-zen-free";
export const BASE_URL = "https://opencode.ai/zen/v1";
const SUPPORTED_APIS = new Set(["openai-responses", "openai-completions"]);

export function freeModels(): Model<Api>[] {
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

export const OPENCODE_USER_AGENT =
  "opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14 dsh-opencode-free/0.2.1";
export const OPENCODE_CLIENT = "cli";
export const OPENCODE_PROJECT = "global";

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
export function sessionHeader(sessionId: string): string {
  const hash = createHash("sha256").update(`${PROVIDER_ID}:${sessionId}`).digest();
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
export function withEncryptedContentFallback(inner?: FetchFunction): FetchFunction {
  const base: FetchFunction = inner ?? globalThis.fetch;
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

/** Fold a legacy `Context` into the transcript pi-ai 0.87 providers read; transcripts pass through. */
export function toTranscript<T>(context: T): T {
  if (!context || typeof context !== "object") return context;
  const legacy = context as { systemPrompt?: unknown; tools?: unknown };
  if (legacy.systemPrompt === undefined && legacy.tools === undefined) return context;
  return normalizeContext(context as unknown as Context) as unknown as T;
}

/**
 * Swap Pi's compaction system prompt for OpenCode's byte-identical one when
 * sending anonymously to Zen. Handles the legacy `{ systemPrompt }` shape and
 * the transcript shape (prompt in system messages). Only short standalone
 * prompts containing the marker are rewritten — never conversation content,
 * requests with tools, or keyed requests.
 */
export function swapCompactionPrompt<T>(context: T, apiKey: unknown): T {
  const key = typeof apiKey === "string" && apiKey.trim() ? apiKey : "public";
  if (key !== "public") return context;
  if (!context || typeof context !== "object") return context;
  const sys = (context as { systemPrompt?: unknown }).systemPrompt;
  if (typeof sys === "string") {
    if (sys.length > 2000 || !sys.toLowerCase().includes(PI_SUMMARIZATION_MARKER)) return context;
    return { ...(context as Record<string, unknown>), systemPrompt: OPENCODE_SUMMARIZATION_PROMPT } as T;
  }
  const msgs = (context as { messages?: unknown }).messages as TranscriptMessage[] | undefined;
  if (!Array.isArray(msgs)) return context;
  const transcript = msgs as Parameters<typeof getCurrentSystemPrompt>[0];
  const prompt = getCurrentSystemPrompt(transcript);
  if (!prompt || prompt.length > 2000 || !prompt.toLowerCase().includes(PI_SUMMARIZATION_MARKER)) return context;
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
 * back; tool-less requests (titles, compaction) get inert stubs. Operates on
 * the transcript: tools live in system messages' `toolsAdded`/`toolsRemoved`.
 */
const GATE_TOOLS = ["read", "bash"];
const SHELL_ALIAS = "pwsh";
const STUB_DESCRIPTION = "Unavailable in this request. Do not call.";

export function applyAnonymousToolGate<T>(context: T, apiKey: unknown): { context: T; restoreShell: boolean } {
  const key = typeof apiKey === "string" && apiKey.trim() ? apiKey : "public";
  const msgs = (context as { messages?: unknown } | null)?.messages as TranscriptMessage[] | undefined;
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
        ? [{ ...first, toolsAdded: [...((first.toolsAdded as unknown[]) ?? []), ...stubs] }, ...messages.slice(1)]
        : [createInitialSystemMessage(undefined, stubs as never) as unknown as TranscriptMessage, ...messages];
  }
  return { context: { ...(context as Record<string, unknown>), messages } as T, restoreShell };
}

/** Rename returned `bash` calls back to DSH's `pwsh` in place (events share `partial`). */
function restoreShellCalls(value: unknown): void {
  const v = value as { partial?: unknown; message?: unknown; error?: unknown; toolCall?: { name?: unknown } } | null;
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
const QUOTA_PATTERN = /FreeUsageLimitError|usage[\s\S]{0,40}(exceeded|limit)|rate[\s-]?limit|quota/i;
const BAD_KEY_PATTERN = /invalid[\s\S]{0,60}key|unauthorized|authentication_error/i;

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
    fetch: withEncryptedContentFallback(options?.fetch as FetchFunction | undefined) as T["fetch"],
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
          const processed = compatRequestOptions(options, getSessionId, fallbackSession);
          debugLog(`${identitySummary(new Headers(processed.headers as HeadersInit | undefined), "compat")} ${shapeSummary(ctx, options)}`);
          const out = origStream(model as never, ctx as never, processed as never);
          return gate.restoreShell ? withGuidance(out as object, true) : out;
        }) as never,
        streamSimple: ((model: Model<Api>, context: never, options: StreamOptions) => {
          if ((model as Model<Api>).provider !== PROVIDER_ID)
            return origStreamSimple(model as never, context as never, options as never);
          // No reasoning default here: compat omission means off.
          const key = (options as { apiKey?: unknown } | undefined)?.apiKey;
          const gate = applyAnonymousToolGate(swapCompactionPrompt(toTranscript(context), key), key);
          const ctx = gate.context;
          const processed = compatRequestOptions(options, getSessionId, fallbackSession);
          debugLog(`${identitySummary(new Headers(processed.headers as HeadersInit | undefined), "compat")} ${shapeSummary(ctx, options)}`);
          const out = origStreamSimple(model as never, ctx as never, processed as never);
          return gate.restoreShell ? withGuidance(out as object, true) : out;
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
    const tools = Array.isArray(ctx.tools) ? ctx.tools.length : Array.isArray(ctx.messages) ? getCurrentTools(ctx.messages as Parameters<typeof getCurrentTools>[0]).length : 0;
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

export function patchGlobalFetchForZen(getSessionId: SessionGetter = () => undefined): void {
  const g = globalThis as Record<string, unknown>;
  if (!g[FETCH_GUARD_ORIGINAL_KEY]) g[FETCH_GUARD_ORIGINAL_KEY] = globalThis.fetch;
  const original = g[FETCH_GUARD_ORIGINAL_KEY] as typeof fetch;
  const callOriginal = (input: unknown, init: unknown): Promise<Response> =>
    (original as (u: never, i: never) => Promise<Response>)(input as never, init as never);
  const guarded = (async (input: unknown, init?: unknown) => {
    try {
      if (!isZenRequest(input)) return callOriginal(input, init);
      const rawInit = (init ?? {}) as Record<string, unknown>;
      const headers = new Headers(rawInit.headers as HeadersInit | undefined);
      const existingSession = headers.get("x-opencode-session");
      headers.set(
        "x-opencode-session",
        existingSession && ZEN_SESSION_PATTERN.test(existingSession)
          ? existingSession
          : sessionHeader(getSessionId() ?? randomUUID()),
      );
      if (!headers.get("authorization")) headers.set("Authorization", "Bearer public");
      headers.set("User-Agent", OPENCODE_USER_AGENT);
      headers.set("x-opencode-client", OPENCODE_CLIENT);
      headers.set("x-opencode-project", OPENCODE_PROJECT);
      if (!headers.get("x-opencode-request")) headers.set("x-opencode-request", requestHeader());
      if (!headers.get("x-client-request-id"))
        headers.set("x-client-request-id", headers.get("x-opencode-session") ?? sessionHeader(getSessionId() ?? randomUUID()));
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
    } catch {
      return callOriginal(input, init);
    }
  }) as typeof fetch;
  globalThis.fetch = guarded;
}

/**
 * Same identity as the fetch guard, for callers that speak node:http/https
 * directly (axios / node-fetch style code in any extension or in-process MCP
 * tool). Other hosts pass through untouched.
 */
export type NodeHeadersInit =
  | Record<string, string | string[] | number | undefined>
  | [string, string][]
  | Headers
  | undefined;

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
  const session = readNodeHeader(out, "x-opencode-session");
  set("x-opencode-session", session && ZEN_SESSION_PATTERN.test(session) ? session : sessionHeader(getSessionId() ?? randomUUID()));
  if (!readNodeHeader(out, "authorization")) set("Authorization", "Bearer public");
  set("User-Agent", OPENCODE_USER_AGENT);
  set("x-opencode-client", OPENCODE_CLIENT);
  set("x-opencode-project", OPENCODE_PROJECT);
  if (!readNodeHeader(out, "x-opencode-request")) set("x-opencode-request", requestHeader());
  if (!readNodeHeader(out, "x-client-request-id")) {
    set("x-client-request-id", readNodeHeader(out, "x-opencode-session") ?? sessionHeader(getSessionId() ?? randomUUID()));
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
  const host = String(options.hostname ?? options.host ?? "").split(":")[0]?.toLowerCase();
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

export function patchNodeHttpForZen(getSessionId: SessionGetter = () => undefined): void {
  const require = createRequire(import.meta.url);
  const targets: [string, NodeHttpModule][] = [
    ["http", require("node:http")],
    ["https", require("node:https")],
  ];
  const stash = nodeHttpStash();
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
          options.headers = applyZenHeadersToNodeHeaders(options.headers as NodeHeadersInit, getSessionId) as unknown as Record<string, unknown>;
          return callOriginal(this, [options, callback]);
        } catch {
          return callOriginal(this, args);
        }
      };
      mod[fnName] = wrapped as (...args: never[]) => unknown;
    }
  }
}

/**
 * Rewrite a resolved transport failure into actionable guidance. pi-ai
 * resolves HTTP failures as `{ stopReason: "error", errorMessage }` (live
 * probe: `"OpenAI API error (403): {full body}"`), so status and body are
 * both recoverable here with full fidelity. Unknown shapes pass through
 * untouched; iteration behavior is never altered, only `result()`.
 */
const TRANSPORT_ERROR_PATTERN = /(?:\((\d{3})\):|^(\d{3}):? )([\s\S]*)$/;

export function mapTransportErrorToGuidance<T>(result: T): T {
  if (!result || typeof result !== "object") return result;
  const rec = result as Record<string, unknown>;
  if (rec.stopReason !== "error" || typeof rec.errorMessage !== "string") return result;
  const m = TRANSPORT_ERROR_PATTERN.exec(rec.errorMessage);
  if (!m) return result;
  const kind = classifyZenFailure(Number(m[1] ?? m[2]), m[3] ?? "");
  if (kind === "unknown") return result;
  const status = m[1] ?? m[2];
  return {
    ...rec,
    errorMessage: `${ZEN_FAILURE_GUIDANCE[kind]}（上游 HTTP ${status}）`,
  } as T;
}

function mapEventErrorToGuidance<T>(event: T): T {
  if (!event || typeof event !== "object") return event;
  const rec = event as Record<string, unknown>;
  if (rec.type !== "error") return event;
  const inner = rec.error as Record<string, unknown> | undefined;
  if (!inner || typeof inner !== "object" || typeof inner.errorMessage !== "string") return event;
  const m = TRANSPORT_ERROR_PATTERN.exec(inner.errorMessage);
  if (!m) return event;
  const kind = classifyZenFailure(Number(m[1] ?? m[2]), m[3] ?? "");
  if (kind === "unknown") return event;
  const status = m[1] ?? m[2];
  return {
    ...rec,
    error: {
      ...inner,
      errorMessage: `${ZEN_FAILURE_GUIDANCE[kind]}（上游 HTTP ${status}）`,
    },
  } as T;
}

function withGuidance<T extends object>(stream: T, restoreShell = false): T {
  return new Proxy(stream, {
    get(target, prop, _receiver) {
      if (prop === "result") {
        const inner = (target as { result: () => Promise<unknown> }).result;
        return async () => {
          const result = await inner.call(target);
          if (restoreShell) restoreShellCalls(result);
          return mapTransportErrorToGuidance(result);
        };
      }
      if (prop === Symbol.asyncIterator) {
        const inner = (target as AsyncIterableIterator<unknown>)[Symbol.asyncIterator].bind(target);
        return async function* () {
          for await (const event of inner()) {
            if (restoreShell) restoreShellCalls(event);
            yield mapEventErrorToGuidance(event);
          }
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Reuse pi-ai's native serializers, streaming parsers, reasoning, and tool handling. */
export function zenProvider(
  getSessionId: () => string | undefined = () => undefined,
  getConfigKey: () => string | undefined = () => undefined,
): Provider {
  const fallbackSession = randomUUID();
  const baseline = freeModels();
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

  function requestOptions<T extends StreamOptions>(options: T = {} as T, context?: unknown): T {
    const processed = compatRequestOptions(options, getSessionId, fallbackSession);
    debugLog(
      `${identitySummary(new Headers(processed.headers as HeadersInit | undefined), "provider")} ${shapeSummary(context, options)}`,
    );
    return processed;
  }

  return {
    ...provider,
    getModels: () => catalogue,
    async refreshModels(ctx) {
      const select = (ids: Set<unknown>) => baseline.filter((m) => ids.has(m.id));
      if (ctx.stored) {
        const restored = select(new Set(ctx.stored.models.map((m) => m.id)));
        if (!(await ctx.publish({ update: () => { catalogue = restored; } }))) return;
      }
      if (!ctx.allowNetwork || ctx.signal.aborted) return;
      const signal = ctx.signal;
      const response = await fetch(`${BASE_URL}/models`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        headers: { "User-Agent": "dsh-opencode-free/0.2.1" },
      });
      if (!response.ok) throw new Error(`Zen model catalogue: HTTP ${response.status}`);
      const body = (await response.json()) as { data?: { id?: unknown }[] };
      if (!Array.isArray(body.data)) throw new Error("Invalid Zen model catalogue");
      const available = new Set(body.data.map((m) => m.id));
      const next = select(available);
      await ctx.publish({
        persist: { models: next, checkedAt: Date.now() },
        update: () => { catalogue = next; },
      });
    },
    stream(model, context, options) {
      const key = (options as { apiKey?: unknown } | undefined)?.apiKey;
      const gate = applyAnonymousToolGate(swapCompactionPrompt(toTranscript(context), key), key);
      return withGuidance(provider.stream(model, gate.context, requestOptions(options, gate.context)), gate.restoreShell);
    },
    streamSimple(model, context, options) {
      const key = (options as { apiKey?: unknown } | undefined)?.apiKey;
      const gate = applyAnonymousToolGate(swapCompactionPrompt(toTranscript(context), key), key);
      return withGuidance(provider.streamSimple(model, gate.context, {
        ...requestOptions(options, gate.context),
        reasoning: options?.reasoning ?? (model.id.startsWith("muse-spark-") ? "xhigh" : undefined),
      }), gate.restoreShell);
    },
  };
}
