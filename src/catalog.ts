/**
 * Model catalogue owner: the models.dev `opencode.models` dictionary is the
 * source of truth for WHICH free models exist, while Zen's `/models` stays the
 * availability gate (a model models.dev calls free can still be unserved).
 *
 * Three layers, deliberately separable so each failure mode is attributable:
 *   1. derivation (pure): free test, activity test, channel inference, metadata
 *      mapping — no I/O, fully fixture-testable;
 *   2. fetch + cache: one conditional GET of the 5.2MB `api.json` (models.dev
 *      publishes no per-provider endpoint), storing ONLY the models dictionary
 *      so a warm start never re-downloads it;
 *   3. the state container: TTL, single-flight, degradation, and the Zen gate.
 *
 * DSH never calls `provider.refreshModels` (no host caller exists), so this
 * module owns its own trigger. It is host-side only: no DSH `ctx` concepts live
 * here, lifecycle wiring stays in `index.ts`.
 *
 * Identity (`provider` / `baseUrl` / `headers`) is NOT defined here — it is
 * inherited from `template`, an already identity-mapped pi-ai record, so the
 * Zen identity constants keep exactly one owner in `zen-provider.ts` and no
 * import cycle is introduced.
 */
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { PLUGIN_VERSION } from "./zen-provider.js";

/** Whole-file endpoint: models.dev serves no per-provider JSON (verified). */
export const MODELS_DEV_URL = "https://models.dev/api.json";
/** Cache schema version; anything else is treated as no cache at all. */
export const CACHE_VERSION = 1;
/** D4: lazy revalidation window. */
export const DEFAULT_TTL_MS = 86_400_000;
/**
 * Active-catalogue TTL, reached only when the previous fetch answered `304`.
 *
 * 24h is the conservative default; 6h is earned. Measured 2026-09-30: models.dev
 * answers `If-None-Match` with `304` and 0 bytes, so a revalidation that HITS costs
 * a few hundred bytes rather than 5.2MB, and the worst-case lag on a newly free
 * model drops from a day to six hours. A provider that stopped honouring the header
 * would instead see 5.2MB four times a day per user, so a MISS resets the interval
 * and the cost falls back to one download a day. The shortened window is taken from
 * observed behaviour and withdrawn the moment that behaviour stops — the full
 * argument, including why a competitor's shorter window really is a re-download, is
 * in `docs/adr/0002-catalogue-source-of-truth.md`.
 */
/**
 * Floor between two MANUAL probe rounds. The automatic round is bounded by
 * `probedToday(lastProbeAt, now)` (one per local calendar day), but `forceProbes()` is reachable
 * from the POST route, which has no server-side rate limit, and each round is up
 * to 34 real inference requests against a bucket shared per egress IP. Five
 * minutes is far below anything a user would notice and far above a double click
 *.
 */
export const FORCED_PROBE_MIN_INTERVAL_MS = 5 * 60_000;

export const CATALOG_TTL_ACTIVE_MS = 6 * 60 * 60_000;
/**
 * How long a Zen availability answer is trusted before it is re-asked.
 *
 * This is a second, independent expiry axis, and it is not a guess about the
 * catalogue's cost. `GET /zen/v1/models` spends no inference quota at all, so it
 * can be asked far more often than a completion can be spent — which is the
 * whole reason the round asks it before probing anything
 * (see {@link refreshGate}). Thirty minutes keeps a withdrawn model out of the
 * picker at minutes' notice instead of the 24h a catalogue-only refresh costs.
 *
 * Not persisted: a boot treats the gate as unasked. One tiny GET per start is
 * cheaper than a schema change, and it self-heals after downtime for free.
 */
export const GATE_TTL_MS = 30 * 60_000;
/** D1: bounded so a hung endpoint cannot pin a plugin fiber. */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** R1: the real file is ~5.2MB; 20MB leaves headroom and rejects a runaway. */
export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
/** Re-exported so `catalog.ts` consumers do not need a second import. */
export { PLUGIN_VERSION } from "./zen-provider.js";
/**
 * models.dev is NOT Zen: it gets an honest agent string. Reusing the OpenCode
 * CLI identity here would be both pointless and misleading.
 */
export const DEFAULT_USER_AGENT = `dsh-opencode-free/${PLUGIN_VERSION}`;

/** Where the catalogue came from, as reported to the panel. */
export type CatalogSource = "models.dev" | "builtin-fallback";

/** A models.dev model record, before mapping. Deliberately loose. */
export type CatalogRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** D2: zero cost across every declared dimension. */
export function isFree(record: CatalogRecord): boolean {
  const cost = record.cost;
  if (!isPlainObject(cost)) return false;
  const values = Object.values(cost);
  return values.length > 0 && values.every((value) => value === 0);
}

/** D2: models.dev omits `status` for active models; only `deprecated` retires one. */
export function isActive(record: CatalogRecord): boolean {
  return record.status !== "deprecated";
}

/**
 * D1: what the catalogue keeps — `status` absent (how models.dev says active),
 * `active`, or `deprecated`. A `deprecated` model STAYS in the catalogue:
 * only a probe can tell a finished free tier from a stale upstream record, and
 * a model dropped here could never be probed or brought back (D6a). Any other
 * status value is discarded outright.
 */
export function isCatalogueStatus(record: CatalogRecord): boolean {
  const status = record.status;
  if (status === undefined) return true;
  return status === "active" || status === "deprecated";
}

function reasoningOptionTypes(record: CatalogRecord): string[] {
  const options = record.reasoning_options;
  if (!Array.isArray(options)) return [];
  return options
    .map((option) => (isPlainObject(option) && typeof option.type === "string" ? option.type : undefined))
    .filter((type): type is string => type !== undefined);
}

/** pi-ai's level vocabulary, in the order it filters them. */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * `getSupportedThinkingLevels` treats `xhigh` and `max` as opt-in — absent from
 * the map means NOT offered — but includes `off`/`minimal`/`low`/`medium`/`high`
 * unless they are explicitly mapped to `null`. A faithful map therefore has to
 * null out the ones models.dev does not publish; leaving them absent would
 * offer a level the model rejects.
 */
const OPT_IN_THINKING_LEVELS = new Set<string>(["xhigh", "max"]);

/**
 * D6: the thinking levels models.dev publishes for this model, as pi-ai's
 * `thinkingLevelMap`.
 *
 * The values are identity because OpenCode is OpenAI-compatible and the level
 * name is what goes on the wire (`reasoning_effort` on completions, `effort` on
 * responses); the map's job here is to say which levels EXIST.
 *
 * `off` is deliberately left absent (offered) rather than nulled: it means
 * "send no reasoning parameter", which is a real choice the user asked to keep
 * as an explicit row. The placeholder effort pi-ai would otherwise put on the
 * wire for it (`"none"` by default, `"off"` when explicitly chosen — neither of
 * which pi-ai's own builtin records nor OpenCode ever send) is stripped back
 * to "no reasoning object" by the plugin's onPayload guard in zen-provider.ts,
 * so offering it is safe.
 *
 * `undefined` means "models.dev published no level list, so make no claim" —
 * pi-ai then falls back to its own default set. That is the honest answer for
 * a `toggle` model (reasoning is on or off, and pi-ai has no name for bare
 * "on") and for a record with `reasoning_options: []`. Guessing there would
 * offer levels upstream rejects, which surfaces as an
 * `UNSUPPORTED_REASONING_EFFORT` failure rather than as a clamp.
 */
export function thinkingLevelMapFor(record: CatalogRecord): Record<string, string | null> | undefined {
  const options = record.reasoning_options;
  if (!Array.isArray(options)) return undefined;
  const published = new Set<string>();
  for (const option of options) {
    if (!isPlainObject(option) || option.type !== "effort") continue;
    const values = option.values;
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)) {
        published.add(value);
      }
    }
  }
  if (published.size === 0) return undefined;
  const map: Record<string, string | null> = {};
  for (const level of THINKING_LEVELS) {
    // `off` stays absent (offered) rather than nulled: the user asked to keep
    // it as an explicit choice. The placeholder effort this would otherwise
    // put on the wire is stripped back to "no reasoning object" by the
    // plugin's onPayload guard (see zen-provider.ts), so offering it is safe.
    if (level === "off") continue;
    if (published.has(level)) map[level] = level;
    else if (!OPT_IN_THINKING_LEVELS.has(level)) map[level] = null;
  }
  return map;
}

/**
 * D6, three tiers: the pi-ai builtin table when it knows the model, then
 * models.dev signals, then the provider's own default. Validated 7/7 against
 * the known opencode models (interleaved/toggle ⇒ completions, effort ⇒
 * responses).
 */
export function channelFor(record: CatalogRecord, knownApis?: ReadonlyMap<string, Api>): Api {
  const id = typeof record.id === "string" ? record.id : undefined;
  if (id !== undefined && knownApis !== undefined) {
    const known = knownApis.get(id);
    if (known !== undefined) return known;
  }
  if (record.interleaved !== undefined) return "openai-completions";
  const types = reasoningOptionTypes(record);
  if (types.includes("toggle")) return "openai-completions";
  if (types.includes("effort")) return "openai-responses";
  return "openai-completions";
}

export interface DeriveOptions {
  /** pi-ai builtin `id -> api`, tier 1 of D6. */
  readonly knownApis?: ReadonlyMap<string, Api>;
  /** An already identity-mapped record supplying the fallback field values. */
  readonly template: Model<Api>;
}

export interface DerivedCatalog {
  /** Free AND `status ∈ {active, deprecated}` — the pre-Zen-gate catalogue. */
  readonly candidates: Model<Api>[];
}

/**
 * One models.dev record → one pi-ai model. Everything the plugin can learn
 * about a model's CAPABILITIES is taken from the record rather than inherited:
 *
 *   - image input      ← `modalities.input` (pi-ai knows only text/image, so
 *                        audio/video/pdf are dropped, not silently kept)
 *   - context window   ← `limit.context`
 *   - max output       ← `limit.output`
 *   - thinking levels  ← `reasoning_options[].values`
 *
 * A field models.dev does not publish falls back to the template, and the
 * template is one fixed record — so `thinkingLevelMap` is set EXPLICITLY in
 * both branches. Inheriting another model's level list would offer levels this
 * model rejects, which the host reports as `UNSUPPORTED_REASONING_EFFORT`
 * rather than clamping.
 */
function buildModel(
  record: CatalogRecord,
  template: Model<Api>,
  knownApis?: ReadonlyMap<string, Api>,
): Model<Api> {
  const id = typeof record.id === "string" && record.id !== "" ? record.id : "";
  const api = channelFor(record, knownApis);
  const limit = isPlainObject(record.limit) ? record.limit : {};
  const modalities = isPlainObject(record.modalities) ? record.modalities : {};
  const declaredInput = Array.isArray(modalities.input)
    ? modalities.input.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image")
    : [];
  const levels = thinkingLevelMapFor(record);
  return {
    ...template,
    id,
    name: typeof record.name === "string" && record.name !== "" ? record.name : id,
    api,
    reasoning: typeof record.reasoning === "boolean" ? record.reasoning : template.reasoning,
    input: declaredInput.length > 0 ? declaredInput : template.input,
    // Free by construction here (isFree already proved it); stated explicitly
    // so a stray inherited tier cannot reintroduce a non-zero rate.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: finitePositive(limit.context) ?? template.contextWindow,
    maxTokens: finitePositive(limit.output) ?? template.maxTokens,
    thinkingLevelMap: (levels ?? undefined) as Model<Api>["thinkingLevelMap"],
    // `compat` is transport-specific. Carrying the template's completions
    // overrides onto a responses model would misconfigure it, so a channel
    // change drops them and lets pi-ai auto-detect from baseUrl.
    compat: (api === template.api ? template.compat : undefined) as Model<Api>["compat"],
  };
}

/**
 * Alphabetical by id, with a plain comparison rather than `localeCompare`: the
 * ids are lowercase ASCII, and ICU collation orders `kimi-k2.5-free` and
 * `kimi-k2-5-free` differently depending on the host's locale — a list whose
 * order depends on the machine is not an order anyone can rely on.
 */
export function byId<T extends { readonly id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Pure: models.dev models dictionary → pre-gate catalogue. */
export function derive(section: CatalogRecord, options: DeriveOptions): DerivedCatalog {
  const candidates: Model<Api>[] = [];
  for (const [key, value] of Object.entries(section)) {
    if (!isPlainObject(value)) continue;
    const id = typeof value.id === "string" && value.id !== "" ? value.id : key;
    if (id === "") continue;
    const record: CatalogRecord = { ...value, id };
    if (!isFree(record)) continue;
    // D1: `deprecated` is kept (a probe judges it); anything else is discarded.
    if (!isCatalogueStatus(record)) continue;
    candidates.push(buildModel(record, options.template, options.knownApis));
  }
  // Sorted HERE, at the one place the list is born, so the snapshot, the
  // visible set and the picker all inherit the same order instead of each
  // deciding for itself. models.dev's own order is grouped by vendor and
  // family, which reads as arbitrary to anyone scanning for one model.
  return { candidates: candidates.slice().sort(byId) };
}

export interface FetchLikeResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<FetchLikeResponse>;

export interface FetchSectionOptions {
  readonly fetchImpl: FetchLike;
  /** Sent as `if-none-match`; callers MUST omit it when no cache exists (R5). */
  readonly etag?: string | undefined;
  readonly url?: string;
  readonly userAgent?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export type FetchSectionResult =
  | { readonly kind: "not-modified" }
  | { readonly kind: "ok"; readonly etag: string | undefined; readonly section: CatalogRecord }
  | { readonly kind: "failed"; readonly reason: string };

/** D1: one conditional GET. Every failure mode is reported, never thrown. */
export async function fetchSection(options: FetchSectionOptions): Promise<FetchSectionResult> {
  const {
    fetchImpl,
    etag,
    url = MODELS_DEV_URL,
    userAgent = DEFAULT_USER_AGENT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
  } = options;
  const headers: Record<string, string> = { accept: "application/json", "user-agent": userAgent };
  if (typeof etag === "string" && etag !== "") headers["if-none-match"] = etag;
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 304) return { kind: "not-modified" };
    if (!response.ok) return { kind: "failed", reason: `http ${response.status}` };
    const text = await readBounded(response, maxBytes);
    if (text === null) return { kind: "failed", reason: "response too large" };
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // A stable reason, not the engine's SyntaxError text: callers and logs
      // compare on this vocabulary.
      return { kind: "failed", reason: "malformed response body" };
    }
    if (!isPlainObject(body)) return { kind: "failed", reason: "malformed response body" };
    // api.json is keyed by provider: `body.opencode` is the PROVIDER record
    // ({id,env,npm,api,name,doc,models}) and the model dictionary sits one
    // level deeper. Handing the provider record to `derive` yields an EMPTY
    // catalogue — none of those keys carries a zero cost — which is worse than
    // the offline floor. The unwrap therefore happens here, once, and `derive`
    // only ever sees a models dictionary.
    const provider = body.opencode;
    if (!isPlainObject(provider)) return { kind: "failed", reason: "missing opencode section" };
    const models = provider.models;
    if (!isPlainObject(models)) return { kind: "failed", reason: "missing opencode models section" };
    return { kind: "ok", etag: response.headers.get("etag") ?? undefined, section: models };
  } catch (error) {
    const name = isPlainObject(error) && typeof error.name === "string" ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "failed", reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : message };
  }
}

/**
 * Read a response body, refusing to grow past `maxBytes`.
 *
 * `await response.text()` first and check the length afterwards can only
 * REJECT an oversized body, never prevent it: by the time the check ran, the
 * whole thing was already resident in the DSH process. A 20MB ceiling that still
 * admits a 400MB error page buys nothing, and the symptom (a desktop host dying
 * with no visible cause) is three steps removed from the reason. Measured
 * 2026-09-30: a 40MB body against a 20MB cap buffered all 40MB.
 *
 * `content-length` is consulted first because it makes the common case free; the
 * streaming read is what makes the chunked case honest. Returns null when the
 * body is refused, which the caller reports as `response too large` — the same
 * reason string as before, so nothing downstream had to change.
 */
async function readBounded(response: FetchLikeResponse, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const body = (response as { body?: ReadableStream<Uint8Array> | null }).body;
  // No stream (a hand-rolled fetch double, or a Response subclass): fall back to
  // the buffered read and check afterwards. Slightly less safe, and the only way
  // to serve those inputs at all.
  if (!body || typeof body.getReader !== "function") {
    const text = await response.text();
    return Buffer.byteLength(text, "utf8") > maxBytes ? null : text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    // Stop the transfer rather than finishing it: the point of the cap is not
    // to spend the memory, and cancelling is what actually returns it.
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface CatalogCacheRecord {
  readonly version: number;
  readonly etag: string | undefined;
  readonly fetchedAt: number;
  /** The `opencode.models` dictionary — named for what it holds, not the slice it came from. */
  readonly models: CatalogRecord;
  /** Conclusive verdicts only; empty means "no history", i.e. all unprobed. */
  readonly probes: ProbeMap;
  /** When the last probe ROUND ran, whether or not it concluded anything. */
  readonly lastProbeAt: number;
  /**
   * The last round's report — the tally and the per-row outcomes the panel
   * draws. It lives here because the live reading is memory-only, and memory
   * does not survive a restart: without this the card adopts nothing on mount
   * after a restart and the progress area is simply blank, which reads as
   * "the probe display is gone" rather than "there is nothing to report yet".
   * Optional and version-stable; a cache without it restores as before.
   */
  readonly lastRound?: {
    readonly total: number;
    readonly done: number;
    readonly results: Record<string, ProbeProgressResult>;
    /** The round's scope, so a restored report still says what it covered. */
    readonly targets?: readonly string[];
  };
}

/** A conclusive verdict. `inconclusive` is deliberately NOT one of them. */
export type ProbeVerdict = "ok" | "dead";

export interface ProbeRecord {
  readonly verdict: ProbeVerdict;
  readonly at: number;
  readonly reason?: string;
  /**
   * Whether this `dead` was established by asking every channel the provider
   * implements, rather than by a single request.
   *
   * It is the whole difference between "this model is gone" and "this request
   * was refused", because a wrong channel is answered with the same "not
   * supported" sentence a dead model produces. A verdict recorded before the
   * sweep existed has no marker and is therefore re-checked once: those older
   * verdicts are exactly the ones that may have been a routing mistake, and
   * leaving them permanent is how a working model stays missing forever.
   */
  readonly swept?: boolean;
  /**
   * The channel this model actually ANSWERED on, when a probe found one.
   *
   * Everything else about a model's channel is inference: a pi-ai builtin table
   * entry, a models.dev signal, or a provider default. Inference is what sends a
   * request down the wrong channel and gets "model not supported" back — which
   * is indistinguishable from a dead model without asking the other channel. So
   * when the sweep DID get an answer, that answer outranks every inference above:
   * keeping it is the difference between a probe that says "ok" and a chat that
   * then fails on the same model.
   *
   * Persisted with the verdict, so the routing survives a restart. Only an `ok`
   * carries one — a refusal says nothing about which channel would have worked.
   */
  readonly api?: string;
}

export type ProbeMap = Record<string, ProbeRecord>;

/** The two channels this provider speaks, and so the only values worth keeping. */
const MEASURED_CHANNELS: readonly string[] = ["openai-completions", "openai-responses"];

export function isMeasuredChannel(value: unknown): value is Api {
  return typeof value === "string" && MEASURED_CHANNELS.includes(value);
}

/**
 * Point a model at the channel it was last MEASURED on.
 *
 * The single place that claim is applied. Two callers, one rule: the round when
 * it records the answer, and the warm read when it adopts a cache that already
 * holds one — which is the half that makes it survive a restart. Without both,
 * the probe knows and nothing else does.
 */
export function applyMeasuredChannel(models: readonly Model<Api>[], probes: ProbeMap): void {
  for (const model of models) {
    const measured = probes[model.id]?.api;
    if (measured === undefined || measured === model.api) continue;
    (model as { api: Api }).api = measured;
  }
}

/**
 * What the transport layer reports for one probe. Structurally compatible with
 * `zen-provider`'s `ProbeOutcome`; declared here so this module keeps no
 * dependency on the transport and no import cycle is introduced. A prober may
 * also reject, which is treated as "no conclusion" (D5).
 */
export interface ProbeResult {
  readonly kind: ProbeVerdict | "inconclusive";
  readonly reason?: string;
  /**
   * The channel that answered, on an `ok` only. The catalogue stores it and
   * routes the model by it, so a probe that succeeded on the second channel is
   * not followed by a chat that fails on the first.
   */
  readonly api?: Api;
  /** Machine-readable failure code; the panel localizes it rather than guessing. */
  readonly code?: string;
  /** HTTP status the transport saw; 0 means no response ever arrived. */
  readonly http?: number;
  /**
   * Which anonymous-gate marker the upstream body carried, when it carried
   * one. `code: "anon-gated"` deliberately folds three conditions together
   * because none of them is a verdict about the model — but they need three
   * different fixes, and the body is the only place that fact ever exists.
   * Carried into the round record so the panel can say which.
   */
  readonly marker?: string | null | undefined;
}

/** Read persisted verdicts defensively: a damaged entry is dropped, not fatal. */
function readProbes(value: unknown): ProbeMap {
  if (!isPlainObject(value)) return {};
  const probes: ProbeMap = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) continue;
    if (entry.verdict !== "ok" && entry.verdict !== "dead") continue;
    if (typeof entry.at !== "number" || !Number.isFinite(entry.at)) continue;
    probes[id] = {
      verdict: entry.verdict,
      at: entry.at,
      ...(typeof entry.reason === "string" && entry.reason !== "" ? { reason: entry.reason } : {}),
      ...(entry.swept === true ? { swept: true } : {}),
      ...(isMeasuredChannel(entry.api) ? { api: entry.api } : {}),
    };
  }
  return probes;
}

/** D5: `$DSH_HOME/dsh-opencode-free/catalog.json` (same convention as dsh-pocket). */
export function cachePath(env: Record<string, string | undefined> = process.env): string {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME !== "" ? env.DSH_HOME : join(homedir(), ".dsh");
  return join(home, "dsh-opencode-free", "catalog.json");
}

/** Any unreadable/foreign cache is simply "no cache" — never an error. */
export async function readCache(path: string): Promise<CatalogCacheRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isPlainObject(parsed)) return null;
    if (parsed.version !== CACHE_VERSION) return null;
    // The `models` guard is what makes the field rename safe: a file still
    // carrying the old `opencode` provider record is rejected outright rather
    // than adopted as a catalogue.
    if (!isPlainObject(parsed.models)) return null;
    return {
      version: CACHE_VERSION,
      etag: typeof parsed.etag === "string" ? parsed.etag : undefined,
      fetchedAt: typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : 0,
      models: parsed.models,
      probes: readProbes(parsed.probes),
      lastProbeAt:
        typeof parsed.lastProbeAt === "number" && Number.isFinite(parsed.lastProbeAt)
          ? parsed.lastProbeAt
          : 0,
      lastRound: readLastRound(parsed.lastRound),
    };
  } catch {
    return null;
  }
}

/**
 * The last round's report, read defensively. A damaged or absent field means
 * "no report to show", which is exactly what the panel showed before — the
 * report is a convenience, never a verdict.
 */
function readLastRound(value: unknown): CatalogCacheRecord["lastRound"] {
  if (!isPlainObject(value)) return undefined;
  const total = value.total;
  const done = value.done;
  if (typeof total !== "number" || !isFinite(total) || total <= 0) return undefined;
  if (typeof done !== "number" || !isFinite(done)) return undefined;
  const results: Record<string, ProbeProgressResult> = {};
  if (isPlainObject(value.results)) {
    for (const [id, entry] of Object.entries(value.results)) {
      if (!isPlainObject(entry)) continue;
      if (entry.status === "ok" && typeof entry.ms === "number") {
        results[id] = { status: "ok", ms: entry.ms };
        continue;
      }
      if (entry.status === "failed" && typeof entry.ms === "number") {
        results[id] = {
          status: "failed",
          ms: entry.ms,
          code: typeof entry.code === "string" ? entry.code : "unknown",
          http: typeof entry.http === "number" && isFinite(entry.http) ? entry.http : 0,
          // Both directions, or the report that comes back is not the report
          // that was written. Keeping only the `false` form meant a row that
          // really DID remove a model came back with no flag — and
          // `isFreshRemoval` reads a missing `removed` as a fresh removal, so
          // a restart re-announced a removal for a round that finished hours
          // ago.
          ...(typeof entry.removed === "boolean" ? { removed: entry.removed } : {}),
          ...(typeof entry.marker === "string" && entry.marker !== "" ? { marker: entry.marker } : {}),
        };
      }
    }
  }
  const targets = Array.isArray(value.targets)
    ? value.targets.filter((id): id is string => typeof id === "string")
    : [];
  return { total, done, results, targets };
}

/** Temp file + rename, so a crash mid-write can never leave a torn cache. */
export async function writeCacheAtomic(
  path: string,
  record: {
    etag: string | undefined;
    fetchedAt: number;
    models: CatalogRecord;
    probes?: ProbeMap;
    lastProbeAt?: number;
    lastRound?: CatalogCacheRecord["lastRound"];
  },
): Promise<boolean> {
  // Unpredictable on purpose. `${path}.${process.pid}.tmp` was both the path and
  // the pid: on a shared machine another local user could pre-create that exact
  // name as a symlink and have `writeFile` follow it.
  const temporary = join(dirname(path), `.catalog.${randomUUID()}.tmp`);
  try {
    // 0700/0600 rather than the umask default: the file records which models
    // this user hides and when each was last probed, which is nobody else's
    // business on a multi-user host.
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const payload: Record<string, unknown> = {
      version: CACHE_VERSION,
      etag: record.etag,
      fetchedAt: record.fetchedAt,
      models: record.models,
    };
    // Probe fields are omitted until a round has something to record, so a
    // never-probed cache keeps exactly the file shape it had before probing
    // existed (and a catalogue sync must carry the current verdicts forward
    // rather than silently dropping them).
    if (record.probes !== undefined && Object.keys(record.probes).length > 0) payload.probes = record.probes;
    if (record.lastProbeAt !== undefined && record.lastProbeAt > 0) payload.lastProbeAt = record.lastProbeAt;
    const round = record.lastRound;
    if (round !== undefined && round.total > 0) payload.lastRound = round;
    await writeFile(temporary, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
    return true;
  } catch {
    // A cache we cannot persist is a performance loss, never a failure.
    //
    // But the staged file is OURS: on Windows a rename onto a target that is
    // being written concurrently fails with EPERM/EBUSY, and leaving the staged
    // copy behind means a crash loop accumulates one partial per attempt in the
    // user's own cache directory
    // test rather than by inspection).
    await rm(temporary, { force: true }).catch(() => undefined);
    return false;
  }
}

export interface CatalogSnapshot {
  /** Pre-Zen-gate catalogue (what `refreshModels` intersects and probes). */
  readonly models: Model<Api>[];
  /**
   * Post-gate, post-probe ids: exactly what the picker offers. A model a probe
   * judged `dead` is simply absent — there is no companion list naming it.
   */
  readonly visible: readonly string[];
  /**
   * One capability card per `visible` id, same order: what the detail-page
   * panel renders next to each row. Names and booleans only, never the full
   * records (which carry request-shaping internals the browser has no use for).
   */
  readonly capabilities: readonly ModelCapability[];
  readonly source: CatalogSource;
  readonly updatedAt: number;
  /**
   * When Zen last answered "which ids do you serve", or 0 if never this boot.
   *
   * Separate from {@link updatedAt} on purpose: the two expire on different
   * clocks, and conflating them is how a withdrawn model stays in a picker for
   * a whole catalogue TTL. Not persisted — a boot re-asks.
   */
  readonly gateCheckedAt: number;
  /**
   * Ids Zen serves that look free but the catalogue has no record of. A
   * diagnostic, never a membership input — see {@link unknownFree}.
   */
  readonly unknownFree: readonly string[];
  readonly refreshing: boolean;
  /** When the last probe round ran; 0 means never. */
  readonly probedAt?: number;
  /** The last round reached no conclusion (gated, quota, bad key, network). */
  readonly probeInconclusive?: boolean;
}

/**
 * The three facts the detail-page panel renders per row. `thinking` is the
 * strongest published thinking level (`"Max"`, `"XHigh"`, …) or `null` when
 * the model publishes no level list — the panel shows no thinking badge then,
 * rather than guessing. The raw level id travels here; display capitalization
 * is the panel's business.
 */
export interface ModelCapability {
  readonly id: string;
  readonly image: boolean;
  readonly thinking: string | null;
}

/** Strongest-first thinking levels; `off` is never a badge. */
const THINKING_LEVEL_RANK = ["max", "xhigh", "high", "medium", "low", "minimal"] as const;

/**
 * The only signal available for a model the catalogue has never heard of.
 *
 * A known model is free because its `cost` is all zero. An unknown one has no
 * `cost` at all, so the id is the only thing left to read — and a "-free" in
 * the name is a weaker claim than a price of zero, not an equal one. It is
 * therefore used for a diagnostic line and for nothing else: never for
 * membership, never for a capability badge. The panel says so in as many words,
 * because a list that looks authoritative and is not is worse than no list.
 */
const FREE_ID_PATTERN = /(?:^|[-_])free(?:$|[-_.])/;

/**
 * The badge level for one derived record: the strongest level whose map value
 * is a real (string) entry. A string-valued map entry IS a published level —
 * `thinkingLevelMapFor` only writes identity entries for published names and
 * `null` for unpublished ones — so this reads the same fact back without
 * re-parsing models.dev. No map, or no string entry, means no badge.
 */
export function topThinkingLevel(model: Model<Api>): string | null {
  const map = model.thinkingLevelMap;
  if (!map || typeof map !== "object") return null;
  for (const level of THINKING_LEVEL_RANK) {
    if (typeof (map as Record<string, unknown>)[level] === "string") return level;
  }
  return null;
}

/** Project one effective record to the panel's capability card. */
export function modelCapability(model: Model<Api>): ModelCapability {
  return {
    id: model.id,
    image: Array.isArray(model.input) && model.input.includes("image"),
    thinking: topThinkingLevel(model),
  };
}

export interface CreateCatalogOptions {
  /** Identity + fallback field source; an already identity-mapped record. */
  readonly template: Model<Api>;
  /** D8 offline floor: the pi-ai builtin free set, used until a sync lands. */
  readonly builtinBaseline: Model<Api>[];
  readonly knownApis?: ReadonlyMap<string, Api>;
  readonly cachePath: string;
  readonly fetchImpl: FetchLike;
  /**
   * Sends one minimal request per model and classifies the answer. Injected so
   * this module keeps no transport dependency; when absent, probing is simply
   * unavailable and every probe entry point is a no-op.
   */
  readonly probe?: ((model: Model<Api>) => Promise<ProbeResult>) | undefined;
  /**
   * The ids Zen currently serves, from one `GET /zen/v1/models` — the same cheap
   * availability check 9router performs for its free provider, and the reason
   * that check is worth doing before anything expensive.
   *
   * A model missing from this list is not available, full stop, and saying so
   * costs one GET instead of one inference request per model. Resolves null when
   * the fetch failed, which must never narrow anything: the round then falls
   * back to probing everything it would otherwise have probed.
   */
  readonly listZenIds?: (() => Promise<readonly string[] | null>) | undefined;
  /**
   * Is this model switched OFF in the picker? A round asks only about the
   * models the user has on: a probe costs a request from a bucket shared by
   * everything behind this egress, so spending one on a model that is hidden
   * is an answer nobody will read, taken at the expense of the ones that will
   * be. Read live, so a toggle mid-round is honoured on the next round.
   */
  readonly hidden?: ((id: string) => boolean) | undefined;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly userAgent?: string;
}

/**
 * Everything a Catalogue owns, in one place.
 *
 * These were fourteen separate `let` bindings captured by the factory closure,
 * which made the round scheduler reachable only by building a whole Catalogue,
 * driving a round and reading the result. One owner object is what lets the
 * scheduler take (state, deps) instead of capturing a dozen variables.
 *
 * `probeRun` stays a mutable object replaced wholesale at the start of every
 * round: the panel polls a copy while the round mutates the original, and no
 * verdict logic ever reads it.
 */
export interface CatalogState {
  cache: CatalogCacheRecord | null;
  models: Model<Api>[];
  source: CatalogSource;
  updatedAt: number;
  zenIds: ReadonlySet<string> | null;
  inflight: Promise<void> | null;
  gateInflight: Promise<ReadonlySet<string> | null> | null;
  /** Set when the last catalogue fetch was a 304 rather than a body download. */
  lastFetchWasNotModified: boolean;
  /** When Zen last answered the availability question; 0 = never this boot. */
  gateCheckedAt: number;
  probes: ProbeMap;
  lastProbeAt: number;
  probeUntrusted: boolean;
  probeRun: {
    running: boolean;
    total: number;
    done: number;
    current: string | null;
    results: Record<string, ProbeProgressResult>;
    startedAt: number;
    targets: string[];
  };
  probeInflight: Promise<void> | null;
}

/** Everything a Catalogue needs from the outside world. */
export interface CatalogDeps {
  readonly path: string;
  readonly fetchImpl: FetchLike;
  readonly now: () => number;
  readonly userAgent: string | undefined;
  readonly ttlMs: number;
  readonly probe: CreateCatalogOptions["probe"];
  readonly listZenIds: CreateCatalogOptions["listZenIds"];
  readonly hidden: CreateCatalogOptions["hidden"];
  readonly template: Model<Api>;
  readonly knownApis: ReadonlyMap<string, Api> | undefined;
  /** Bounds how long a sync waits for the warm cache read to land. */
  readonly warmReadTimeoutMs: number;
  /** Resolves once the warm cache read has settled. */
  readonly warm: Promise<void>;
}

export function initialState(builtinBaseline: readonly Model<Api>[]): CatalogState {
  return {
    cache: null,
    models: builtinBaseline.slice().sort(byId),
    source: "builtin-fallback",
    updatedAt: 0,
    zenIds: null,
    inflight: null,
    gateInflight: null,
    lastFetchWasNotModified: false,
    gateCheckedAt: 0,
    probes: {},
    lastProbeAt: 0,
    probeUntrusted: false,
    probeRun: { running: false, total: 0, done: 0, current: null, results: {}, targets: [], startedAt: 0 },
    probeInflight: null,
  };
}
export interface Catalog {
  current(): CatalogSnapshot;
  /** Post-Zen-gate models — the single list the picker and the panel share. */
  effectiveModels(): Model<Api>[];
  /** Fire-and-forget revalidation; shared by concurrent callers. */
  ensureFresh(): Promise<void>;
  /** Ignores the TTL and waits for the sync to settle. */
  forceRefresh(): Promise<void>;
  /** One ordered probe round; at most one per local day (D2). */
  runProbes(): Promise<void>;
  /** Ignores the daily gate; used by the panel button (D8). */
  forceProbes(): Promise<void>;
  /** `null` means Zen failed: keep the current gate rather than narrowing. */
  applyZenGate(ids: readonly string[] | null): void;
  /**
   * The live progress of the current (or last) probe round, for the panel's
   * progress pill and per-row badges. In-memory only — it is a transient fuel
   * gauge, not a verdict, so it is never persisted and never narrows anything.
   */
  probeProgress(): ProbeProgress;
}

/**
 * What the panel polls while a round is running — and reads again after it
 * ends, so the last round's outcome is still on screen instead of vanishing.
 * `results` holds one entry per FINISHED model; the in-flight one is `current`;
 * everything else is waiting. `ms` is the wall time that model's probe took,
 * for the "✓ 142ms" badge.
 *
 * A failure carries `code` (a {@link ProbeFailureCode} the card localizes) and
 * `http` (0 when no status ever arrived). A red badge that only says "failed"
 * is the thing this type exists to prevent.
 */
export interface ProbeProgress {
  readonly running: boolean;
  readonly total: number;
  readonly done: number;
  readonly current: string | null;
  readonly results: Readonly<Record<string, ProbeProgressResult>>;
  /**
   * The ids this round accounts for — its whole scope, asked or not-yet-asked.
   *
   * A round now only asks about the models the user has switched ON, so "no
   * result yet" means two different things: queued, or not in this round at
   * all. The panel cannot tell them apart from `results` alone, and calling a
   * skipped model "waiting" is a claim about a round that will never reach it.
   */
  readonly targets: readonly string[];
  /** When the current (or last) round started; 0 means no round has ever run. */
  readonly startedAt: number;
}

/** One model's outcome in a round: answered (with latency) or not (with why). */
export type ProbeProgressResult =
  | { readonly status: "ok"; readonly ms: number }
  | {
      readonly status: "failed";
      readonly ms: number;
      readonly code: string;
      readonly http: number;
      /**
       * Present only on a `dead` verdict: did THIS round take the model out of
       * the list, or did it only re-confirm a death that had already removed
       * it? A re-confirmation is a real answer and worth showing, but calling it
       * a removal reports a change the round did not make. Omitted by older
       * backends, which the card reads as "removed" — its own behaviour.
       */
      readonly removed?: boolean | undefined;
      /** Which anonymous-gate marker the refusal carried, when it named one. */
      readonly marker?: string | undefined;
    };

/**
 * D2: at most one round per LOCAL calendar day — the plan's rule, compared
 * against the previous round's local day via the injected `now` so a test can
 * place both ends exactly.
 *
 * Calendar day, not a rolling 24h window: the bound is on how much of the
 * shared anonymous bucket one day's sweep may spend, and "same day" is what a
 * user reading the panel would expect. The known edge is a round at 23:50
 * followed by one at 00:10 — different days, so both run. That is deliberate,
 * not an oversight; `forceProbes` bypasses this gate entirely, so a manual
 * click is never blocked either way.
 */
export function probedToday(lastProbeAt: number, now: () => number): boolean {
  if (lastProbeAt <= 0) return false;
  const previous = new Date(lastProbeAt);
  const today = new Date(now());
  return (
    previous.getFullYear() === today.getFullYear() &&
    previous.getMonth() === today.getMonth() &&
    previous.getDate() === today.getDate()
  );
}

/**
 * The one list the picker and the panel share: the catalogue, narrowed by
 * Zen's gate, minus everything a probe judged dead. A dead model is dropped
 * from here and named nowhere — the user asked for it to simply not be in the
 * list, so there is deliberately no companion "unavailable" list to restore
 * or to go stale.
 *
 * `models` itself still carries dead entries, and that is load-bearing rather
 * than untidy: `adopt` prunes verdicts for models the catalogue no longer
 * has, so a dead model physically removed from `models` would lose its
 * verdict on the next sync, come back as a fresh candidate, and be re-probed
 * to the same answer. Keeping the record is what makes the verdict final.
 */
export function effectiveList(
  models: readonly Model<Api>[],
  zenIds: ReadonlySet<string> | null,
  probes: ProbeMap,
): Model<Api>[] {
  const gated = zenIds === null ? [...models] : models.filter((model) => zenIds.has(model.id));
  // Order comes from where the catalogue is born (derive / the offline
  // floor); this only filters, so it cannot drift from it.
  return gated.filter((model) => probes[model.id]?.verdict !== "dead");
}

function effectiveVisible(list: readonly Model<Api>[]): string[] {
  return list.map((model) => model.id);
}

/**
 * Models Zen serves, that the catalogue has never heard of, and whose id
 * claims to be on the free tier.
 *
 * This is the one blind spot the two-source design cannot see past: membership
 * comes from models.dev, so an id Zen has started serving before models.dev
 * publishes it is invisible here — not "judged dead", not "gated out", simply
 * never a candidate. On 2026-09-30 that was one live model
 * (`jev-1.13-free`), while 24 ids models.dev still called free were correctly
 * gated out, so the gate is demonstrably working and this is not a symptom of
 * a broken intersection.
 *
 * It is reported rather than fixed, deliberately. Making these models usable
 * needs an `api` channel and a `limit.context`/`limit.output`, and NEITHER is
 * obtainable from any source available here: Zen's listing carries only
 * `id`/`object`/`created`/`owned_by`, and matching a "-free"-suffixed id
 * against other providers' records is a guess. A wrong number is worse than a
 * conservative one, because a claimed context length is acted on. So the
 * honest move is to say the model exists and that we will not guess for it.
 */
export function unknownFree(models: readonly Model<Api>[], zenIds: ReadonlySet<string> | null): string[] {
  if (zenIds === null) return [];
  const known = new Set(models.map((model) => model.id));
  const out: string[] = [];
  for (const id of zenIds) {
    if (known.has(id) || !FREE_ID_PATTERN.test(id)) continue;
    out.push(id);
  }
  // Same order as everything else the panel shows, and the same comparison
  // that produces it: a locale-sensitive sort would make this list differ
  // from the catalogue's own on a machine with a different ICU default.
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Which freshness window applies: a caller-pinned `ttlMs` is honoured verbatim
 * (tests pin it), so only the default path shortens, and only after a 304 has
 * proved the upstream honours the conditional header.
 */
export function effectiveTtl(
  pinnedTtl: number | undefined,
  fallbackTtl: number,
  lastFetchWasNotModified: boolean,
): number {
  return pinnedTtl ?? (lastFetchWasNotModified ? CATALOG_TTL_ACTIVE_MS : fallbackTtl);
}

export function catalogueIsStale(updatedAt: number, now: () => number, ttl: number): boolean {
  return now() - updatedAt > ttl;
}

/**
 * "Never asked this boot" is stale by definition, not by arithmetic. Testing
 * it as an inequality would let a small or injected clock read 0 as fresh,
 * which is exactly the case where a real question is still outstanding.
 */
export function gateIsStale(gateCheckedAt: number, now: () => number): boolean {
  return gateCheckedAt === 0 || now() - gateCheckedAt > GATE_TTL_MS;
}

/**
 * How one probe outcome becomes the row the panel paints.
 *
 * This used to live inline in the round loop, where the interesting rule was
 * invisible between the transport plumbing: the card cannot say "failed" without
 * a `code`, and it must not call a re-confirmed death a removal. Both are
 * load-bearing — a row with no reason is the bug this field exists to prevent,
 * and reporting an old verdict as a fresh removal dates a change to this round
 * that happened in an earlier one.
 *
 * `priorVerdict` is read BEFORE the round writes the new one, which is the only
 * reason the `removed` flag can be answered at all.
 */
export function probeRowFor(
  outcome:
    | {
        readonly kind?: string;
        readonly code?: string;
        readonly http?: number;
        readonly marker?: string | null;
      }
    | null
    | undefined,
  elapsed: number,
  priorVerdict: string | undefined,
): ProbeProgressResult {
  if (outcome !== undefined && outcome !== null && outcome.kind === "ok") {
    return { status: "ok", ms: elapsed };
  }
  // A prober that predates the coded outcome still gets a reason: the verdict
  // itself is the coarse fallback, never a silent failure.
  const code =
    typeof outcome?.code === "string" && outcome.code !== ""
      ? outcome.code
      : outcome?.kind === "dead"
        ? "dead"
        : "unknown";
  return {
    status: "failed",
    ms: elapsed,
    code,
    http: typeof outcome?.http === "number" && isFinite(outcome.http) ? outcome.http : 0,
    ...(code === "dead" ? { removed: priorVerdict !== "dead" } : {}),
    // Which gate marker the body carried, so the refusal names itself instead of
    // arriving as one anonymous "未测到".
    ...(typeof outcome?.marker === "string" && outcome.marker !== "" ? { marker: outcome.marker } : {}),
  };
}

/**
 * A dead verdict is final ONLY once it has been earned by asking every channel.
 * A verdict without that marker predates the sweep, so it gets one re-check:
 * those are precisely the verdicts that may have been a wrong channel refused
 * rather than a model that is gone — and a permanent verdict on a wrong channel
 * is how a working model goes missing for good.
 */
function isSettled(id: string, probes: ProbeMap): boolean {
  const record = probes[id];
  if (record === undefined || record.verdict !== "dead") return false;
  return record.swept === true;
}

/**
 * What one round will ask, split into the two buckets the panel needs to tell
 * "queued" from "skipped".
 *
 * `targets` are the models the user has switched ON that no earned verdict has
 * settled — a probe costs a request from a bucket shared by everything behind
 * this egress, so asking about a hidden model is an answer nobody will read.
 *
 * `notListed` are models Zen has dropped: out of the picker without ever being
 * asked, zero requests spent. They still count toward the round's total,
 * because the panel's tally has to add up and a silent hole in the list is
 * exactly what a reader cannot explain.
 */
export function planRound(
  models: readonly Model<Api>[],
  live: readonly Model<Api>[],
  servedSet: ReadonlySet<string> | null,
  probes: ProbeMap,
  hidden: ((id: string) => boolean) | undefined,
): { targets: Model<Api>[]; notListed: Model<Api>[] } {
  const isShown = (id: string): boolean => hidden?.(id) !== true;
  return {
    targets: live.filter((model) => isShown(model.id) && !isSettled(model.id, probes)),
    notListed:
      servedSet === null
        ? []
        : models.filter((model) => !servedSet.has(model.id) && probes[model.id]?.verdict !== "dead"),
  };
}

// Warm start: a valid state.cache restores the catalogue without any network.
function adopt(
  state: CatalogState,
  deps: CatalogDeps,
  record: CatalogCacheRecord,
  // Restoring the finished-round report belongs to STARTUP. It is what makes a
  // restarted host show the last outcome instead of an empty progress area —
  // but it is a snapshot of a round that already ended, and an ordinary sync
  // re-adopting it mid-round replaced a live `probeRun` (running:true) with
  // the previous one (running:false, done:2). The round then carried on
  // incrementing `done` on that swapped-in object, so the panel reported 4/2 and
  // the wrong tally was persisted. A refresh updates the
  // catalogue and the verdicts; it has nothing to say about a round in flight.
  restoreRound = false,
): void {
  const derived = derive(record.models, { knownApis: deps.knownApis, template: deps.template });
  // An empty state.models dictionary is NOT a catalogue — it is a fetch that failed
  // and got persisted anyway (a round writes one when the catalogue fetch
  // never succeeded, see runProbeRound). Adopting it empties the picker on
  // the next start, which is strictly worse than the missing verdicts that
  // write was meant to preserve. Keep the offline floor and take only the
  // probe state; this is the same fail-safe direction every other "we could
  // not tell" path in this file already takes.
  if (derived.candidates.length > 0) {
    state.models = derived.candidates;
    state.source = "models.dev";
    state.updatedAt = record.fetchedAt;
  }
  if (Object.keys(record.probes).length > 0) state.probes = { ...record.probes };
  // A channel a previous process MEASURED, re-applied. Without this the
  // measurement is on disk and ignored, so a restart silently reverted every
  // model to its inferred channel and the very failure the probe ruled out
  // came back.
  applyMeasuredChannel(state.models, state.probes);
  if (record.lastProbeAt > state.lastProbeAt) state.lastProbeAt = record.lastProbeAt;
  // The report of a round that already finished, so a restart shows the
  // outcome instead of an empty progress area. `running` stays false: this is
  // a completed round, not one to follow.
  const restored = record.lastRound;
  if (restoreRound && restored !== undefined && restored.total > 0) {
    state.probeRun = {
      running: false,
      total: restored.total,
      done: restored.done,
      current: null,
      results: { ...restored.results },
      targets: Array.isArray(restored.targets) ? restored.targets.slice() : [],
      startedAt: record.lastProbeAt,
    };
  }
  // Verdicts for state.models the catalogue no longer carries are dropped: a
  // vanished model is not in any round's target list, so keeping its verdict
  // would only grow the state.cache file across upstream removals. This is also
  // why a DEAD model is not removed from `state.models` above — see effectiveList.
  const present = new Set(state.models.map((model) => model.id));
  for (const id of Object.keys(state.probes)) if (!present.has(id)) delete state.probes[id];
}

function refreshGate(state: CatalogState, deps: CatalogDeps): Promise<ReadonlySet<string> | null> {
  if (state.gateInflight !== null) return state.gateInflight;
  state.gateInflight = (async () => {
    const { listZenIds } = deps;
    if (listZenIds === undefined) return null;
    const raw: unknown = await listZenIds().catch(() => null);
    const served = admissibleGate(state, raw);
    if (served === null) return null;
    state.zenIds = served;
    state.gateCheckedAt = deps.now();
    return served;
  })().finally(() => {
    state.gateInflight = null;
  });
  return state.gateInflight;
}

/**
 * The ONE rule for "may this answer narrow the gate?".
 *
 * Three shapes are "could not tell", and all three must leave the gate alone:
 * a failure (null), a non-array (this seam is also filled by a host refresh and
 * by tests — iterating a bare string turns it into a set of single characters,
 * i.e. a well-typed, well-formed, entirely wrong gate), and an empty list
 * (`fetchZenModelIds` already collapses one to null, but the invariant belongs
 * here, not at the state.source).
 *
 * DISJOINT is the fourth, and the one a list-emptiness check misses. A response
 * that is perfectly well-formed and names NONE of the state.models we hold is far more
 * likely to be a changed shape, a wrong egress, or a different tenant than it is
 * to be a simultaneous withdrawal of every free model — and acting on it empties
 * the picker outright, which is the one outcome this decision exists to prevent.
 *after the `[]` guard shipped believing it was
 * sufficient.
 *
 * This was previously written TWICE — once in `refreshGate`, once in
 * `applyZenGate` — and only the first was ever executed, so "change one, forget
 * the other" would have accumulated silently until some future host actually
 * called `refreshModels`. One owner, both callers.
 */
function admissibleGate(state: CatalogState, raw: unknown): ReadonlySet<string> | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (state.models.length > 0) {
    const held = new Set(state.models.map((model) => model.id));
    let overlap = 0;
    for (const id of raw) if (typeof id === "string" && held.has(id)) overlap += 1;
    if (overlap === 0) return null;
  }
  const served = new Set<string>(raw.filter((id): id is string => typeof id === "string" && id !== ""));
  return served.size > 0 ? served : null;
}

async function sync(state: CatalogState, deps: CatalogDeps): Promise<void> {
  const { path, fetchImpl, userAgent, warmReadTimeoutMs } = deps;
  // Never fetch before the warm read settles: the response below is built
  // from `state.cache` (for the conditional etag) and adopted over whatever the
  // warm start installed, so letting the two interleave either resurrects a
  // removed model or drops the persisted probe history.
  await Promise.race([
    deps.warm,
    new Promise<void>((resolve) => setTimeout(resolve, warmReadTimeoutMs).unref?.()),
  ]);
  // R5: without a state.cache there is nothing a 304 could rebuild, so the
  // conditional header must not be sent at all.
  const result = await fetchSection({ fetchImpl, etag: state.cache?.etag, userAgent });
  if (result.kind === "failed") return; // failure preserves the current catalogue
  const stamp = deps.now();
  if (result.kind === "not-modified") {
    state.updatedAt = stamp;
    // The endpoint honoured the header, so the short window is now earned.
    state.lastFetchWasNotModified = true;
    // Carry the new freshness into the state.cache file too, otherwise every boot
    // would revalidate again despite the catalogue being current.
    if (state.cache !== null) {
      state.cache = { ...state.cache, fetchedAt: stamp };
      await writeCacheAtomic(path, {
        etag: state.cache.etag,
        fetchedAt: stamp,
        models: state.cache.models,
        probes: state.probes,
        lastProbeAt: state.lastProbeAt,
        // Carried, not re-derived: a catalogue revalidation is not a probe
        // round and has nothing new to report, but DROPPING it would delete
        // the last round's report from disk.—
        // the field predates the 6h window, which is what made the loss
        // frequent enough to notice (up to four syncs a day instead of one).
        lastRound: state.cache.lastRound,
      });
    }
    return;
  }
  // Retain the etag: without this every revalidation would be a full
  // 5.2MB download instead of a conditional request.
  // A real body means the short window is withdrawn until a 304 earns it back.
  state.lastFetchWasNotModified = false;
  // Carry `lastRound` across the rebuild, exactly as the 304 branch above does.
  // The 304 branch spreads the old record and so kept it; this branch built a
  // fresh object and silently dropped the field, so the very next write
  // deleted the last round's report from disk. The comment here used to claim
  // the opposite of what the code did. Reproduced 2026-09-30: a second full
  // sync after a round left `lastRound` absent.
  const previousRound = state.cache?.lastRound;
  state.cache = {
    version: CACHE_VERSION,
    etag: result.etag,
    fetchedAt: stamp,
    models: result.section,
    probes: state.probes,
    lastProbeAt: state.lastProbeAt,
    lastRound: previousRound,
  };
  adopt(state, deps, state.cache);
  // A sync is not a round and has nothing new to report, but its write replaces
  // the whole record — so omitting the field deletes the report. Carried, not
  // re-derived.
  await writeCacheAtomic(path, {
    etag: result.etag,
    fetchedAt: stamp,
    models: result.section,
    probes: state.probes,
    lastProbeAt: state.lastProbeAt,
    lastRound: previousRound,
  });
}

function runSingle(state: CatalogState, deps: CatalogDeps): Promise<void> {
  if (state.inflight !== null) return state.inflight;
  state.inflight = sync(state, deps).finally(() => {
    state.inflight = null;
  });
  return state.inflight;
}

function runProbeSingle(state: CatalogState, deps: CatalogDeps): Promise<void> {
  if (state.probeInflight !== null) return state.probeInflight;
  state.probeInflight = runProbeRound(state, deps).finally(() => {
    state.probeInflight = null;
  });
  return state.probeInflight;
}

/**
 * Exported for tests, and for that is the whole point of the extraction: a round
 * can now be driven with two plain objects, with no factory, no temp directory
 * and no network. Everything else in this file moved for the same reason.
 */
export async function runProbeRound(state: CatalogState, deps: CatalogDeps): Promise<void> {
  const { path, hidden, probe } = deps;
  // A round reads `state.probes` twice — to decide what is already settled, and
  // to answer `priorVerdict`, which is the only thing that lets it tell a fresh
  // removal from a re-confirmed old one — and `state.models` to decide what to
  // ask. All of it arrives with the warm cache read, which is fire-and-forget.
  //
  // A round that started before that read landed therefore computed every prior
  // verdict as "unknown": it re-asked models it already knew the answer for, and
  // reported old deaths as removals that had just happened. `sync()` already
  // waits on this same promise for this same reason; a round has to as well.
  await Promise.race([
    deps.warm,
    new Promise<void>((resolve) => setTimeout(resolve, deps.warmReadTimeoutMs).unref?.()),
  ]);
  const stamp = deps.now();
  // Cheap authoritative availability first. One `GET /zen/v1/state.models` answers
  // "does Zen serve this id at all" without spending inference quota, so a
  // withdrawn model costs one GET instead of one completion — and the answer
  // is Zen's own, not a reading of error prose. This is the same check 9router
  // makes for its free provider, and it is the reason its availability test
  // is fast.
  //
  // It is deliberately NOT recorded as a `dead` verdict. `dead` is permanent
  // and learned by asking the model; membership is recomputed from the
  // authority on every round, so a model Zen puts back simply reappears.
  // Conflating the two is how a model that came back stays suppressed forever.
  const servedSet = await refreshGate(state, deps);
  const live = servedSet === null ? state.models : state.models.filter((model) => servedSet.has(model.id));
  // A `dead` verdict is final ONLY once it has been earned by asking every
  // channel. A verdict without that marker predates the sweep, so it gets one
  // re-check: those are precisely the verdicts that may have been a wrong
  // channel refused rather than a model that is gone — and a permanent verdict
  // on a wrong channel is how a working model goes missing for good.
  // The round's scope, decided by one pure function below.
  const { targets, notListed } = planRound(state.models, live, servedSet, state.probes, hidden);
  // The panel polls this while the round runs: a progress pill ("4/10") and
  // one badge per row (ok with latency / failed / probing / waiting). It is
  // replaced wholesale at the start of every round and frozen when the round
  // ends, so a late poll never shows a previous round's leftovers as live.
  state.probeRun = {
    running: true,
    // The round's whole scope, so the panel can tell "queued" from "skipped".
    targets: [...targets, ...notListed].map((model) => model.id),
    total: targets.length + notListed.length,
    done: 0,
    current: null,
    results: {},
    startedAt: stamp,
  };
  let untrusted = false;
  for (const model of notListed) {
    // At zero cost, with the reason that is actually known: Zen does not list
    // it. This is what lets the panel say so rather than leave a gap.
    state.probeRun.results[model.id] = {
      status: "failed",
      ms: 0,
      code: "not-listed",
      http: 0,
      removed: true,
    };
    state.probeRun.done += 1;
  }
  try {
    for (const model of targets) {
      state.probeRun.current = model.id;
      const started = deps.now();
      let outcome: ProbeResult;
      try {
        outcome = await probe!(model);
      } catch {
        untrusted = true;
        state.probeRun.results[model.id] = {
          status: "failed",
          ms: Math.max(0, deps.now() - started),
          code: "error",
          http: 0,
        };
        state.probeRun.done += 1;
        continue;
      }
      // The row badge reports whether the model ANSWERED, not what the
      // verdict was: `dead` removes the model from the list, but from this
      // round's point of view it is still "did not answer usably". Only
      // `ok` earns the green badge; everything else is red — and red carries
      // WHY, because a red badge with no reason is not a report.
      const elapsed = Math.max(0, deps.now() - started);
      state.probeRun.results[model.id] = probeRowFor(outcome, elapsed, state.probes[model.id]?.verdict);
      state.probeRun.done += 1;
      if (outcome === undefined || outcome === null || outcome.kind === "inconclusive") {
        untrusted = true;
        continue;
      }
      if (outcome.kind !== "ok" && outcome.kind !== "dead") {
        untrusted = true;
        continue;
      }
      state.probes[model.id] = {
        verdict: outcome.kind,
        at: stamp,
        ...(typeof outcome.reason === "string" && outcome.reason !== "" ? { reason: outcome.reason } : {}),
        // Only an answer names a channel. A refusal is evidence that the
        // channel did not work, not evidence that another one would.
        ...(outcome.kind === "ok" && isMeasuredChannel(outcome.api) ? { api: outcome.api } : {}),
        // Reaching here means the prober exhausted every channel before
        // concluding, so this `dead` is earned and can be final.
        ...(outcome.kind === "dead" ? { swept: true } : {}),
      };
      // Applied HERE, not when the round ends. A row is painted the moment its
      // verdict lands, so a model shown as working must already be routed the
      // way it worked — waiting for the last model to finish left a visibly
      // successful model still going down the channel the probe had just ruled
      // out. The cache write stays once per round.
      if (outcome.kind === "ok") applyMeasuredChannel(state.models, state.probes);
    }
  } finally {
    state.probeRun.running = false;
    state.probeRun.current = null;
  }
  // The round marker is written even when nothing concluded: it is the only
  // thing that stops a fully-gated day from re-probing on every single read.
  state.lastProbeAt = stamp;
  state.probeUntrusted = untrusted;
  // One atomic write per round, never per model: a half-finished round must
  // not be read back as a complete set of verdicts.
  //
  // Written even when `state.cache` is null — i.e. a first boot whose catalogue
  // fetch failed, where the round is running against the pi-ai offline floor.
  // That round may spend up to 34 real requests from the shared anonymous
  // bucket, and the guard used to throw all of it away, so the next DSH restart
  // bought the same 34 again. `state.models` degrades to an empty dictionary, which
  // `readCache` accepts and `adopt` treats as "nothing to derive", leaving the
  // offline floor in place while the verdicts survive.
  const report: NonNullable<CatalogCacheRecord["lastRound"]> = {
    total: state.probeRun.total,
    done: state.probeRun.done,
    results: state.probeRun.results,
    targets: state.probeRun.targets,
  };
  await writeCacheAtomic(path, {
    etag: state.cache?.etag,
    fetchedAt: state.cache?.fetchedAt ?? 0,
    models: state.cache?.models ?? {},
    probes: state.probes,
    lastProbeAt: state.lastProbeAt,
    // The report, so the panel's progress area survives a restart.
    lastRound: report,
  });
  // Mirror the write back into the in-memory record. Every sync path carries
  // `state.cache.lastRound` forward rather than re-deriving it, so a round that
  // writes the report to disk without recording it here leaves the NEXT sync
  // carrying `undefined` — which deleted the very report it had just written.
  // Two writers of one field, only one of which updated the state.source of truth:
  // reproduced 2026-09-30 (fixing the sync branch alone was not enough).
  if (state.cache !== null) state.cache = { ...state.cache, lastRound: report };
}

export function createCatalog(options: CreateCatalogOptions): Catalog {
  const {
    template,
    builtinBaseline,
    knownApis,
    cachePath: path,
    fetchImpl,
    ttlMs = DEFAULT_TTL_MS,
  } = options;
  const now = options.now ?? Date.now;
  const userAgent = options.userAgent;
  const probe = options.probe;
  const listZenIds = options.listZenIds;
  const hidden = options.hidden;

  const state = initialState(builtinBaseline);

  /**
   * Resolves once the warm state.cache read has settled.
   *
   * The warm start is deliberately fire-and-forget — a container must answer
   * synchronously — but that left it free to land AFTER a sync and replace the
   * fresher section with the older cached one, holding a removed model in the
   * picker for a whole TTL. `sync(state, deps)` therefore waits for this before fetching.
   * The wait is one local `readFile` of the state.cache (megabytes, not a download)
   * and is bounded, so a wedged filesystem delays a sync rather than hanging
   * it forever.
   */
  const WARM_READ_TIMEOUT_MS = 2_000;
  let settleWarm: () => void = () => undefined;
  const warm = new Promise<void>((resolve) => {
    settleWarm = resolve;
  });

  // Three one-liners over the pure rules above. They exist so the call sites
  // read as questions ("is the catalogue stale?") rather than as expressions,
  // and so the rules themselves can be exercised without a container.
  const currentTtl = (): number => effectiveTtl(options.ttlMs, ttlMs, state.lastFetchWasNotModified);
  const stale = (): boolean => catalogueIsStale(state.updatedAt, now, currentTtl());
  const gateStale = (): boolean => gateIsStale(state.gateCheckedAt, now);

  const warmStart = (): void => {
    void readCache(path)
      .then((found) => {
        if (found === null) return;
        state.cache = found;
        // Adopted whatever its age: a stale state.cache is still a far better answer
        // than the offline floor, and `ensureFresh` revalidates on the first read
        // in the background rather than making the user wait for 5.2MB.
        adopt(state, deps, found, true);
      })
      .catch(() => undefined)
      .finally(settleWarm);
  };
  warmStart();

  // An explicit `ttlMs` is a caller asking for exactly that window (tests pin
  // it), so it is honoured verbatim and the adaptive step is skipped. Only the
  // default path shortens, and only after a 304 proved the header works.

  /**
   * Ask Zen, right now, which ids it serves — and remember the answer.
   *
   * The ONE writer of `state.zenIds` and `state.gateCheckedAt`. Three call sites used to
   * write the gate independently (`runProbeRound`, `applyZenGate`, and the host
   * refresh); with two independent cadences now running, two writers would mean
   * whichever finished last silently overwrote the other's answer, and a stale
   * one winning that race would look exactly like an upstream change.
   *
   * Single-flight, because a poll and a probe round can reach it together and
   * one GET answers both.
   *
   * `null` means "could not tell" and is the only reading that leaves the gate in
   * force. A narrowed gate is the one update here that can empty a picker, and a
   * timeout, a region refusal or a malformed body must never be read as "these
   * state.models are gone".
   */
  // The outside world, named once so the lifted functions can take it.
  const deps: CatalogDeps = {
    path,
    fetchImpl,
    now,
    userAgent,
    ttlMs,
    probe,
    listZenIds,
    hidden,
    template,
    knownApis,
    warmReadTimeoutMs: WARM_READ_TIMEOUT_MS,
    warm,
  };

  /**
   * D2/D6b: one ordered round over the state.models that are still unjudged.
   *
   * Sequential `for…await` on purpose (no concurrency, no batching): the round
   * spends a shared anonymous-quota bucket, and firing 30+ requests at once
   * would both exhaust it faster and hammer upstream.
   *
   * A model already judged `dead` is NOT re-probed. The verdict is final by
   * design: re-asking a model the route has already refused spends quota to
   * re-learn a settled fact, and on this provider that is the difference
   * between ~34 requests a day and ~10. A Zen key does not change this — it
   * raises the quota, not the model list, so a refused model is refused with a
   * key too. Recovery is manual and is for upstream changes (a model coming
   * back, a channel being fixed): delete
   * `$DSH_HOME/dsh-opencode-free/catalog.json` and the next start re-derives
   * and re-state.probes the whole catalogue.
   *
   * Only conclusive verdicts are recorded. An `inconclusive` — or a prober that
   * rejects — leaves the model exactly as it was (D5): one gated IP must never
   * empty the picker.
   */

  return {
    current(): CatalogSnapshot {
      // One pass over the single effective list feeds both `visible` and
      // `capabilities`, so the ids and the cards can never disagree.
      const effective = effectiveList(state.models, state.zenIds, state.probes);
      return {
        models: state.models.slice(),
        visible: effective.map((model) => model.id),
        capabilities: effective.map(modelCapability),
        source: state.source,
        updatedAt: state.updatedAt,
        gateCheckedAt: state.gateCheckedAt,
        unknownFree: unknownFree(state.models, state.zenIds),
        refreshing: state.inflight !== null,
        probedAt: state.lastProbeAt,
        probeInconclusive: state.probeUntrusted,
      };
    },
    effectiveModels(): Model<Api>[] {
      return effectiveList(state.models, state.zenIds, state.probes);
    },
    async ensureFresh(): Promise<void> {
      // Two independent expiry axes. Both are STARTED before the first await,
      // so they overlap rather than interleave; neither waits on the other,
      // because the failure modes are unrelated — a Zen outage must not delay
      // the catalogue, and a 5.2MB download must not delay a one-request gate.
      const catalogue = state.inflight ?? (stale() ? runSingle(state, deps) : null);
      const gate = gateStale() ? refreshGate(state, deps) : null;
      // The gate is awaited first because it cannot reject: letting a catalogue
      // failure skip it would silently drop the cheap, quota-free check.
      if (gate !== null) await gate;
      if (catalogue !== null) await catalogue;
    },
    async forceRefresh(): Promise<void> {
      return runSingle(state, deps);
    },
    async runProbes(): Promise<void> {
      if (probe === undefined) return;
      if (state.probeInflight !== null) return state.probeInflight;
      if (probedToday(state.lastProbeAt, now)) return;
      return runProbeSingle(state, deps);
    },
    async forceProbes(): Promise<void> {
      if (probe === undefined) return;
      // A manual round still costs one request per model from a bucket shared
      // per egress IP, and the POST route has no rate limit of its own — so
      // repeated clicks spent the whole office's quota. A short floor keeps the
      // button honest without making it useless: the user asked for a fresh
      // answer, not a second one five seconds later.
      if (now() - state.lastProbeAt < FORCED_PROBE_MIN_INTERVAL_MS) return;
      return runProbeSingle(state, deps);
    },
    probeProgress(): ProbeProgress {
      // A copy: the round mutates `state.probeRun` while the panel reads this.
      return {
        running: state.probeRun.running,
        total: state.probeRun.total,
        done: state.probeRun.done,
        current: state.probeRun.current,
        results: { ...state.probeRun.results },
        targets: state.probeRun.targets.slice(),
        startedAt: state.probeRun.startedAt,
      };
    },
    applyZenGate(ids: readonly string[] | null): void {
      // The host's own refresh is a SECOND writer of `state.zenIds`, and the review
      // that shipped the 30-minute gate is what made that worth saying out
      // loud. Today only `refreshGate` runs — the host never calls
      // `provider.refreshModels`, verified 2026-09-30 — so nothing can race. If
      // a future host does call it, these two paths can interleave and the
      // slower one can overwrite the newer answer, which is indistinguishable
      // from an upstream change. Fold this into `refreshGate` before relying on
      // it.
      //
      // Same admissibility rules meanwhile: a null, empty, non-array or wholly
      // disjoint answer is not a membership decision, it is an absent one.
      const served = admissibleGate(state, ids);
      if (served === null) return;
      state.zenIds = served;
      // A host refresh answered the same question this poll would, so the
      // freshness stamp moves too — otherwise the next read would spend a
      // second GET on an answer already in hand.
      state.gateCheckedAt = now();
    },
  };
}
