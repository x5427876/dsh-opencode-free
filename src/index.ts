/**
 * DSH host plugin: registers the `opencode-zen-free` provider route on
 * `ctx.llm` via DSH's generic `PiAiAdapter`.
 *
 * Mirrors `pi-opencode-direct` (same Zen identity, same optional-key
 * priority, same encrypted-content retry, same compaction-prompt swap) but
 * expressed as a DSH bundle for `0.2.1-alpha.1`: no OpenCode install, no
 * separate server, native pi-ai transports, tools execute through DSH.
 */
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import type { PiAiAdapterOptions } from "@deepseek-ai/dsh-llm-pi-ai";
import z from "@deepseek-ai/schemastery";
import { createModels } from "@earendil-works/pi-ai";
import type {
  AuthContext,
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  Provider,
} from "@earendil-works/pi-ai";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { Buffer } from "node:buffer";
import { cachePath, createCatalog } from "./catalog.js";
import type { Catalog, FetchLike, FetchLikeResponse } from "./catalog.js";
import {
  PROVIDER_ID,
  ZEN_API_KEY_ENV,
  builtinFreeModels,
  builtinKnownApis,
  catalogTemplate,
  fetchZenModelIds,
  patchCompatDirectTransport,
  patchGlobalFetchForZen,
  patchNodeHttpForZen,
  probeModel,
  zenProvider,
} from "./zen-provider.js";
import type { ProbeStreamer } from "./zen-provider.js";

export {
  BASE_URL,
  OPENCODE_CLIENT,
  OPENCODE_PROJECT,
  OPENCODE_SUMMARIZATION_PROMPT,
  OPENCODE_USER_AGENT,
  PROVIDER_ID,
  STATIC_ZEN_HEADERS,
  ZEN_API_KEY_ENV,
  ZEN_FAILURE_GUIDANCE,
  ZEN_TRANSPORT_GUIDANCE,
  builtinFreeModels,
  builtinKnownApis,
  catalogTemplate,
  classifyZenFailure,
  createTransportRecorder,
  describeTransportCause,
  fetchZenModelIds,
  freeModels,
  isEncryptedContentError,
  isModelUnavailableFailure,
  mapTransportErrorToGuidance,
  probeModel,
  requestHeader,
  resolveZenApiKey,
  sessionHeader,
  stripStaleReasoning,
  swapCompactionPrompt,
  zenProvider,
} from "./zen-provider.js";
export type { ProbeDeps, ProbeOutcome, ProbeStreamer } from "./zen-provider.js";

export const name = "opencode-free";
// `webServer` backs the two read/refresh routes the detail-page panel reads;
// the panel is useless without them, and the routes are inert without it.
export const inject: readonly string[] = ["llm", "webServer"];

/** Panel routes. The prefix is package-scoped, so it cannot collide. */
const CATALOG_ROUTE = "/dsh-opencode-free/api/catalog";
const REFRESH_ROUTE = "/dsh-opencode-free/api/refresh";
const PROBE_ROUTE = "/dsh-opencode-free/api/probe";

/** Plugin configuration: only the optional Zen key. Everything else is automatic. */
export interface Config {
  readonly apiKey?: string | undefined;
  // Volatile: DSH only serves configForms rows (and accepts live writes) for
  // volatile fields. Without this flag the detail-page card has no scope and
  // renders nothing. Cordis delivers a live Volatile ref at runtime; the
  // plain-array shape below covers tests and non-volatile hosts.
  readonly hiddenModels?:
    readonly string[] | { readonly get: () => readonly string[] | undefined } | undefined;
}

export const Config = z.object({
  apiKey: z.string(),
  hiddenModels: z.array(z.string()).default([]).volatile(),
});

const PI_AI_AUTH_CONTEXT: AuthContext = Object.freeze({
  async env(name: string): Promise<string | undefined> {
    return process.env[name];
  },
  async fileExists(path: string): Promise<boolean> {
    const expanded =
      path === "~" || path.startsWith("~/") ? resolvePath(homedir(), path.slice(1).replace(/^\//, "")) : path;
    try {
      await access(expanded);
      return true;
    } catch {
      return false;
    }
  },
});

/**
 * v1 carries no persisted login: the key comes from plugin config or the
 * environment on every request. The store below only satisfies the
 * `PiAiAdapter` seam (which requires an explicit store so a collection
 * rebuild never forgets who is signed in); it holds nothing.
 */
class EphemeralCredentialStore {
  async read(): Promise<Credential | undefined> {
    return undefined;
  }
  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return [];
  }
  async modify(
    _providerId: string,
    update: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return update(undefined);
  }
  async delete(_providerId: string, options?: AuthOperationOptions): Promise<void> {
    options?.signal?.throwIfAborted();
  }
}

// Minimal structural view of the DSH host context this plugin consumes.
interface HostContext {
  readonly llm: {
    readonly registerAdapter: (providers: readonly string[], adapter: unknown) => unknown;
  };
  readonly get: (key: string) => unknown;
  readonly inject: (requires: readonly string[], apply: (child: never) => void) => void;
  readonly effect: (fn: () => (() => void) | void, label?: string) => unknown;
  readonly [key: string]: unknown;
}

/** The subset of `webServer.register` this plugin uses (gitbash-shell's shape). */
interface WebServerContext {
  readonly webServer: {
    readonly register: (options: { kind: "prefix"; path: string; handler: RouteHandler }) => () => void;
  };
  readonly effect: (fn: () => (() => void) | void, label?: string) => unknown;
}

type RouteRequest = { readonly method?: string; readonly headers?: Record<string, string | undefined> };
type RouteResponse = {
  writeHead: (code: number, headers: Record<string, string | number>) => void;
  end: (body: string) => void;
};
type RouteHandler = (req: RouteRequest, res: RouteResponse) => void;

function sendJson(res: RouteResponse, code: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    // Never cached: the panel repaints from a snapshot that changes underneath it.
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * The catalogue payload the panel reads. Names, booleans and one level id per
 * model — never a config value, and never the full model records (which carry
 * request-shaping internals the browser has no use for).
 *
 * One shape for all three routes: the probe route repaints from what it returns,
 * so a panel that got a differently-shaped body would have to re-read anyway.
 * There is no list of unavailable models — a dead model is simply absent from
 * both `visible` and `models`, so there is nothing for the panel to reconcile.
 */
function catalogPayload(catalog: Catalog): Record<string, unknown> {
  const snapshot = catalog.current();
  return {
    visible: [...snapshot.visible],
    models: snapshot.capabilities.map((card) => ({ ...card })),
    source: snapshot.source,
    updatedAt: snapshot.updatedAt,
    // Separate from updatedAt: the Zen gate has its own clock, and a panel that
    // shows only one age would report a withdrawn model as current for a day.
    gateCheckedAt: snapshot.gateCheckedAt,
    // Usually empty. Non-empty means Zen serves a free-tier id that models.dev
    // has not published yet, so the panel can say so rather than leave the user
    // wondering why the list is short. A diagnostic; nothing downstream treats
    // it as membership.
    unknownFree: [...snapshot.unknownFree],
    refreshing: snapshot.refreshing,
    // Present only once a round has run; the panel treats absence as
    // "never probed" rather than as a fault.
    ...(snapshot.probedAt === undefined ? {} : { probedAt: snapshot.probedAt }),
    ...(snapshot.probeInconclusive === undefined ? {} : { probeInconclusive: snapshot.probeInconclusive }),
  };
}

/**
 * Same-origin fence for the one mutating route (mirrors dsh-gitbash-shell's
 * `fenceToolRequest`): a POST must carry an Origin/Referer matching Host, so a
 * third-party page cannot drive a refresh. The GET route is read-only and
 * passes trivially, which is why only the refresh handler calls this.
 */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "0.0.0.0"]);

function sameOrigin(req: RouteRequest): boolean {
  const headers = req.headers ?? {};
  const host = headers.host ?? "";
  const origin = headers.origin ?? headers.referer ?? "";
  if (host === "" || origin === "") return false;
  // The Host header must name THIS machine. Comparing Origin against Host only
  // proves the two agree with each other, and under DNS rebinding an attacker
  // page at evil.com resolves to 127.0.0.1 — so both headers read evil.com and
  // the check passes, letting a third-party page drive POST /probe and spend the
  // shared anonymous bucket. CSRF is still covered (a browser will not forge
  // Origin cross-origin); this closes the rebinding shape on top of it
  //.
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  if (!LOCAL_HOSTS.has(name.toLowerCase())) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function registerCatalogRoutes(ctx: HostContext, catalog: Catalog): void {
  try {
    ctx.inject(["webServer"], (child: never) => {
      const wctx = child as unknown as WebServerContext;
      try {
        const readHandler: RouteHandler = (req, res) => {
          if ((req.method ?? "GET").toUpperCase() !== "GET") {
            sendJson(res, 405, { error: "method not allowed" });
            return;
          }
          sendJson(res, 200, catalogPayload(catalog));
        };
        const refreshHandler: RouteHandler = (req, res) => {
          if ((req.method ?? "GET").toUpperCase() !== "POST") {
            sendJson(res, 405, { error: "method not allowed" });
            return;
          }
          if (!sameOrigin(req)) {
            sendJson(res, 403, { error: "forbidden", reason: "cross-origin" });
            return;
          }
          // Awaited so the panel repaints from the answer instead of
          // re-reading a list the sync may not have reached yet.
          catalog
            .forceRefresh()
            .catch(() => undefined)
            .then(() => sendJson(res, 200, catalogPayload(catalog)));
        };
        // `runProbes`, not `forceProbes`: the button is the user's explicit
        // "ask upstream now", so the daily gate must not swallow it. (The
        // automatic daily round is the lazy trigger in apply() instead.)
        //
        // One path, two methods. POST STARTS a round and answers at once, with
        // `running: true` — it no longer waits for the round to finish, because
        // nothing needs it to. GET answers the live progress; the panel polls it
        // until `running` goes false and then re-reads the catalogue for the
        // settled snapshot. GET is read-only like the catalogue read, so it
        // carries no origin fence; POST keeps the write route's.
        const probeHandler: RouteHandler = (req, res) => {
          const method = (req.method ?? "GET").toUpperCase();
          if (method === "GET") {
            sendJson(res, 200, catalog.probeProgress());
            return;
          }
          if (method !== "POST") {
            sendJson(res, 405, { error: "method not allowed" });
            return;
          }
          if (!sameOrigin(req)) {
            sendJson(res, 403, { error: "forbidden", reason: "cross-origin" });
            return;
          }
          // Answer IMMEDIATELY, then let the panel follow the round by polling
          // GET. This used to await the whole round, which made a click on
          // "Probe now" a request that could stay open for minutes — a round is
          // one request per model, and a model that hangs holds it for the full
          // 15s each. Nothing was gained by blocking: the progress endpoint
          // already reports `running`/`done`/`total` live, and the panel already
          // re-paints from what the catalogue endpoint says.
          //
          // It also removes a failure mode we could not check for: if the host's
          // web server enforces a request timeout, a multi-minute POST would
          // fail rather than merely be slow, and the user would be told the
          // probe request failed when the round was in fact running fine.
          //
          // 202 says "accepted, not finished". Deliberately NOT echoing the
          // progress reading: a round sets `running` only after it has asked Zen
          // what it serves, so a reading taken here is the PRE-round one, and a
          // panel that adopted it would conclude the round had already finished
          // and stop following it. The progress endpoint is the single owner of
          // round lifecycle; the POST's only job is to say it started.
          //
          // Failures are swallowed, as before: the round is designed to conclude
          // nothing without that being an error (D5), and it must never reject
          // into a 5xx or an unhandled rejection now that nothing awaits it.
          void catalog.forceProbes().catch(() => undefined);
          sendJson(res, 202, catalogPayload(catalog));
        };
        const disposers = [
          wctx.webServer.register({ kind: "prefix", path: CATALOG_ROUTE, handler: readHandler }),
          wctx.webServer.register({ kind: "prefix", path: REFRESH_ROUTE, handler: refreshHandler }),
          wctx.webServer.register({ kind: "prefix", path: PROBE_ROUTE, handler: probeHandler }),
        ];
        wctx.effect(
          () => () => {
            for (const dispose of disposers) {
              try {
                dispose();
              } catch {
                // Best effort: another instance already released the route.
              }
            }
          },
          "opencode-free: catalogue routes",
        );
      } catch (error) {
        // A missing route degrades the panel only; the provider still works.
        console.warn(`opencode-free: catalogue routes failed: ${(error as Error)?.message ?? error}`);
      }
    });
  } catch (error) {
    console.warn(`opencode-free: webServer wiring failed: ${(error as Error)?.message ?? error}`);
  }
}

export function apply(ctx: HostContext, config?: Config): void {
  const configuredKey = config?.apiKey?.trim() || undefined;
  const getConfigKey = (): string | undefined =>
    configuredKey || process.env[ZEN_API_KEY_ENV]?.trim() || undefined;

  // models.dev owns WHICH free models exist; Zen `/models` gates availability.
  // Built eagerly so the provider, the picker and the panel share one instance:
  // nobody here keeps a second copy of the list.
  const template = catalogTemplate();
  // The probe is the one thing that needs the provider, and the provider needs
  // the catalogue, so the two are wired by handing `createCatalog` a closure
  // that reads `provider` at call time. There is still exactly one owner of the
  // verdicts (the catalogue) and one owner of transport (the provider): the
  // provider is asked for a conclusion, it never remembers one.
  // hiddenModels arrives as a live Volatile ref under DSH (see Config docs
  // above); unwrap tolerantly so plain arrays keep working in tests.
  //
  // Read LIVE, every time. A one-shot Set goes stale the moment a toggle
  // changes, and then two answers to "is this model shown" disagree — the
  // picker filters by the snapshot, the probe round by the disk — which is how
  // a probe ends up measuring a model the user cannot see, or misses one they
  // can. One reader, consulted by both.
  const rawHidden: unknown = config?.hiddenModels;
  const hiddenGet =
    typeof rawHidden === "object" && rawHidden !== null && "get" in rawHidden
      ? (rawHidden as { readonly get?: unknown }).get
      : undefined;
  const isHidden = (id: string): boolean => {
    const live: unknown = typeof hiddenGet === "function" ? (hiddenGet as () => unknown)() : rawHidden;
    const list: readonly string[] = Array.isArray(live) ? (live as readonly string[]) : [];
    return list.some((entry) => String(entry).trim() === id);
  };

  let provider: Provider = undefined as unknown as Provider;
  const catalog = createCatalog({
    template: template ?? builtinFreeModels()[0]!,
    builtinBaseline: builtinFreeModels(),
    knownApis: builtinKnownApis(),
    cachePath: cachePath(),
    // A round spends the shared anonymous bucket, so it only asks about the
    // models the user has switched ON: probing a model they hid is quota spent
    // on an answer they will never read, and it crowds out the ones they will.
    hidden: isHidden,
    fetchImpl: ((url, init) =>
      fetch(url, init as RequestInit) as unknown as Promise<FetchLikeResponse>) as FetchLike,
    now: Date.now,
    // Never rejects: `probeModel` converts every failure mode, including a
    // thrown transport error, into a three-state conclusion.
    probe: async (model) =>
      await probeModel(model, {
        provider: provider as unknown as ProbeStreamer,
        apiKey: getConfigKey() ?? "public",
      }),
    // A probe round asks the catalogue before it asks any model: one free GET
    // settles "does Zen still serve this id", so a withdrawn model costs no
    // inference at all. Same request, same headers, as the host's own refresh.
    listZenIds: async () => await fetchZenModelIds(fetch as unknown as typeof globalThis.fetch),
  });
  registerCatalogRoutes(ctx, catalog);

  provider = zenProvider(() => undefined, getConfigKey, { catalog });
  const filtered = {
    ...provider,
    getModels: () => {
      // D4: lazy revalidation on read, fire-and-forget so a cold catalogue
      // never delays the read that triggered it. A first boot legitimately
      // reports the builtin floor until a sync lands.
      void catalog.ensureFresh().catch(() => undefined);
      // D2: one availability round per local day, triggered the same way.
      // Gated on a real catalogue first: probing the offline builtin floor
      // would spend the shared anonymous bucket to re-confirm models the
      // picker is already offering. `runProbes` no-ops when today's round
      // already ran, so this stays a single cheap check per read.
      const snapshot = catalog.current();
      if (snapshot.source !== "builtin-fallback") void catalog.runProbes().catch(() => undefined);
      return provider.getModels().filter((m) => !isHidden(m.id));
    },
    // Required by the pi-ai Provider interface, so it stays even though this
    // host never calls it (zen-provider.ts records the verification). It is a
    // pass-through, not a second implementation: the gate work lives in the
    // catalogue, and both entry points now share one admissibility rule.
    refreshModels: (c: unknown) => (provider as { refreshModels: (c: unknown) => unknown }).refreshModels(c),
  };
  const auth = Object.freeze({
    credentials: new EphemeralCredentialStore() as unknown as CredentialStore,
    authContext: PI_AI_AUTH_CONTEXT,
  });
  const authModels = createModels(auth);
  authModels.setProvider(filtered as unknown as Parameters<typeof authModels.setProvider>[0]);
  const profile = Object.freeze({
    provider: PROVIDER_ID,
    displayName: "OpenCode Zen Free",
    piProvider: filtered,
    modelErrors: /* @__PURE__ */ new Map<string, string>(),
    configuredMaxTokens: /* @__PURE__ */ new Map<string, number>(),
    streamIdleTimeoutMs: 600 * 1_000,
    timeoutMs: 180_000,
    maxRequestImageBytes: 20 * 1024 * 1024,
    requestImagePixelBudget: 2048 * 2048,
    requestImageMaxBytes: 1024 * 1024,
    retryPolicy: resolveRetryPolicy(undefined, "opencode-free retryPolicy"),
    cacheRetention: "short" as const,
    transport: "sse" as const,
  });
  const profiles = /* @__PURE__ */ new Map([[PROVIDER_ID, profile]]);
  const adapter = new PiAiAdapter({
    profiles: () => profiles as unknown as ReturnType<PiAiAdapterOptions["profiles"]>,
    auth,
    resolveApiKey: async (route: string) => {
      if (route !== PROVIDER_ID) return undefined;
      // No try/catch: getConfigKey() is config-or-env-or-"public" and cannot
      // throw. The catch was unreachable and advertised an AUTH_FAILED class
      // that could never be produced.
      return getConfigKey() ?? "public";
    },
    resolveAttachments: () => ctx.get("attachments"),
  } as unknown as PiAiAdapterOptions);
  ctx.llm.registerAdapter([PROVIDER_ID], adapter);

  // Cover side-channels that bypass Models (direct compat transport, Pi core
  // flows calling fetch, axios/node-fetch style callers): same Zen identity,
  // no per-user config. Never let a side-channel patch failure break provider
  // registration.
  //
  // The two process-global patches hand back a restore function, and the host's
  // lifecycle convention (`ctx.effect`, the same one the catalogue routes already
  // use) is what puts them back. Without this, disabling the plugin left
  // `globalThis.fetch` and `node:http`/`node:https` wrapped for the rest of the
  // process — affecting the host and every other plugin, with no way to tell
  //.
  const restoreTransport: Array<() => void> = [];
  try {
    patchCompatDirectTransport(() => undefined);
  } catch {
    // Main-path streaming still works without the compat patch.
  }
  try {
    restoreTransport.push(patchGlobalFetchForZen(() => undefined));
  } catch {
    // Wrappers above already cover the known paths.
  }
  try {
    restoreTransport.push(patchNodeHttpForZen(() => undefined));
  } catch {
    // Fetch-level coverage above is the common case.
  }
  ctx.effect(
    () => () => {
      for (const restore of restoreTransport) {
        try {
          restore();
        } catch {
          // Best effort: another instance may have already unwrapped.
        }
      }
    },
    "opencode-free: transport patches",
  );
}
