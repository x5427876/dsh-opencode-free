/**
 * DSH host plugin: registers the `opencode-zen-free` provider route on
 * `ctx.llm` via DSH's generic `PiAiAdapter`.
 *
 * Mirrors `pi-opencode-direct` (same Zen identity, same optional-key
 * priority, same encrypted-content retry, same compaction-prompt swap) but
 * expressed as a DSH bundle for `0.2.0-rc.2`: no OpenCode install, no
 * separate server, native pi-ai transports, tools execute through DSH.
 */
import { LlmError, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
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
} from "@earendil-works/pi-ai";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import {
  PROVIDER_ID,
  ZEN_API_KEY_ENV,
  patchCompatDirectTransport,
  patchGlobalFetchForZen,
  patchNodeHttpForZen,
  zenProvider,
} from "./zen-provider.js";

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
  classifyZenFailure,
  freeModels,
  isEncryptedContentError,
  mapTransportErrorToGuidance,
  requestHeader,
  resolveZenApiKey,
  sessionHeader,
  stripStaleReasoning,
  swapCompactionPrompt,
  zenProvider,
} from "./zen-provider.js";

export const name = "opencode-free";
export const inject: readonly string[] = ["llm"];

/** Plugin configuration: only the optional Zen key. Everything else is automatic. */
export interface Config {
  readonly apiKey?: string | undefined;
}

export const Config = z.object({
  apiKey: z.string(),
});

const PI_AI_AUTH_CONTEXT: AuthContext = Object.freeze({
  async env(name: string): Promise<string | undefined> {
    return process.env[name];
  },
  async fileExists(path: string): Promise<boolean> {
    const expanded =
      path === "~" || path.startsWith("~/")
        ? resolvePath(homedir(), path.slice(1).replace(/^\//, ""))
        : path;
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
  readonly [key: string]: unknown;
}

export function apply(ctx: HostContext, config?: Config): void {
  const configuredKey = config?.apiKey?.trim() || undefined;
  const getConfigKey = (): string | undefined => configuredKey || process.env[ZEN_API_KEY_ENV]?.trim() || undefined;

  const provider = zenProvider(() => undefined, getConfigKey);
  const auth = Object.freeze({
    credentials: new EphemeralCredentialStore() as unknown as CredentialStore,
    authContext: PI_AI_AUTH_CONTEXT,
  });
  const authModels = createModels(auth);
  authModels.setProvider(provider as unknown as Parameters<typeof authModels.setProvider>[0]);
  const profile = Object.freeze({
    provider: PROVIDER_ID,
    displayName: "OpenCode Zen Free",
    piProvider: provider,
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
      try {
        return getConfigKey() ?? "public";
      } catch {
        throw new LlmError("OpenCode Zen authorization failed", "AUTH_FAILED");
      }
    },
    resolveAttachments: () => undefined,
  } as unknown as PiAiAdapterOptions);
  ctx.llm.registerAdapter([PROVIDER_ID], adapter);

  // Cover side-channels that bypass Models (direct compat transport, Pi core
  // flows calling fetch, axios/node-fetch style callers): same Zen identity,
  // no per-user config. Never let a side-channel patch failure break provider
  // registration.
  try {
    patchCompatDirectTransport(() => undefined);
  } catch {
    // Main-path streaming still works without the compat patch.
  }
  try {
    patchGlobalFetchForZen(() => undefined);
  } catch {
    // Wrappers above already cover the known paths.
  }
  try {
    patchNodeHttpForZen(() => undefined);
  } catch {
    // Fetch-level coverage above is the common case.
  }
}
