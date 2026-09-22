/**
 * pi-ai-backed OpenCode Zen adapter for the harness LLM seam.
 * @module dsh-opencode-free/adapter
 */

import { randomUUID } from 'node:crypto'
import type { Api, ApiKeyAuth, Model, MutableModels, ThinkingLevel } from '@earendil-works/pi-ai'
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import {
  attributionHeaders,
  contentHasImage,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { toPiContext } from './pi-context.js'
import { createModels, getSupportedThinkingLevels } from './pi-models.js'
import { toStreamChunks } from './pi-stream.js'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ResolvedZenOptions } from './config.js'
import {
  OPENCODE_SUMMARIZATION_PROMPT,
  STATIC_ZEN_HEADERS,
  ZEN_PROVIDER,
  isAnonymousKey,
  requestHeader,
  sessionHeader,
  withEncryptedContentFallback,
} from './zen.js'

const SUPPORTED_APIS = new Set(['openai-responses', 'openai-completions'])
const SESSION_TITLE_PURPOSE = 'session-title'
const COMPACTION_MARKER = 'context summarization'

/**
 * Resolve one attachment reference into the current model-tool execution world.
 */
export type ZenImageAccessResolver = (
  attachments: import('@deepseek-ai/dsh-attachment').AttachmentStore,
  ref: import('@deepseek-ai/dsh-attachment').ImageAttachmentRef,
) => import('@deepseek-ai/dsh-llm').ImageAttachmentAccess | undefined

/**
 * Dependencies the plugin wires per request.
 */
export interface ZenAdapterDeps {
  /** Resolved static options. */
  options: () => ResolvedZenOptions
  /** Resolve the Zen key per call; absence means anonymous. */
  resolveApiKey: () => Promise<string>
  /** Resolve the durable attachment service. */
  resolveAttachments?: () => import('@deepseek-ai/dsh-attachment').AttachmentStore | undefined
  /** Bridge one attachment into the execution world. */
  resolveImageAccess?: ZenImageAccessResolver
  /** Observe degraded replay. */
  onReplayDegrade?: (detail: { provider: string; model: string; reason: string }) => void
}

/**
 * Zen request authentication honoring the per-request key override.
 * @returns api-key auth resolving the request credential.
 */
export function zenAuth(): { apiKey: ApiKeyAuth } {
  return {
    apiKey: {
      name: 'OpenCode Zen API key (or anonymous free tier)',
      resolve: ({ credential }) => Promise.resolve({
        auth: credential?.key === undefined ? {} : { apiKey: credential.key },
        source: 'opencode-zen-free',
      }),
    },
  }
}

/**
 * Free Zen models from the installed pi-ai catalog.
 * @param baseURL - endpoint to serve.
 * @param ids - explicit ids replacing the free set.
 * @returns models re-homed to this route.
 */
export function zenModels(baseURL: string, ids?: readonly string[]): Array<Model<Api>> {
  const catalog = getBuiltinModels('opencode')
  const wanted = ids === undefined ? undefined : new Set(ids)
  return catalog
    .filter(model => SUPPORTED_APIS.has(model.api))
    .filter(model => wanted !== undefined ? wanted.has(model.id) : Object.values(model.cost).every(cost => cost === 0))
    .map(model => ({
      ...model,
      provider: ZEN_PROVIDER,
      baseUrl: baseURL,
      headers: { ...model.headers, ...STATIC_ZEN_HEADERS },
    }))
}

/**
 * Default reasoning for one model id.
 * @param modelId - exact model.
 * @param configured - profile default.
 * @returns level to send, or undefined to omit.
 */
function defaultReasoning(modelId: string, configured: ResolvedZenOptions['reasoning']): ThinkingLevel | undefined {
  if (configured === undefined) {
    if (modelId.startsWith('muse-spark-')) return 'xhigh'
    return undefined
  }
  if (configured === 'off') return undefined
  return configured
}

/**
 * Swap dsh summarization wording for OpenCode wording on anonymous auxiliary calls.
 * @param options - harness request.
 * @param apiKey - resolved key.
 * @returns request with swapped prompt, or the original.
 */
function swapCompactionPrompt(options: GenerateOptions, apiKey: string): GenerateOptions {
  if (!isAnonymousKey(apiKey)) return options
  if (options.purpose !== 'compaction' && options.purpose !== SESSION_TITLE_PURPOSE) return options
  if (options.system !== undefined) {
    if (options.system.length > 2000 || !options.system.toLowerCase().includes(COMPACTION_MARKER)) return options
    return { ...options, system: OPENCODE_SUMMARIZATION_PROMPT }
  }
  const [first, ...rest] = options.messages
  if (first === undefined || first.role !== 'system') return options
  const text = first.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('')
  if (text.length === 0 || text.length > 2000 || !text.toLowerCase().includes(COMPACTION_MARKER)) return options
  return { ...options, messages: [{ ...first, content: [{ type: 'text', text: OPENCODE_SUMMARIZATION_PROMPT }] }, ...rest] }
}

/**
 * Zen adapter serving one free-tier route through pi-ai transports.
 */
export class ZenAdapter extends LlmAdapter {
  private readonly models: MutableModels
  private readonly catalog: Array<Model<Api>>

  /**
   * @param deps - plugin wiring.
   */
  constructor(private readonly deps: ZenAdapterDeps) {
    super()
    const options = deps.options()
    this.catalog = zenModels(options.baseURL, options.models)
    this.models = createModels()
    this.models.setProvider(createProvider({
      id: ZEN_PROVIDER,
      name: 'OpenCode Zen Free',
      baseUrl: options.baseURL,
      auth: zenAuth(),
      models: this.catalog,
      api: {
        'openai-responses': openAIResponsesApi(),
        'openai-completions': openAICompletionsApi(),
      },
    }))
  }

  /**
   * Describe this route.
   * @param provider - route key.
   * @returns display metadata.
   */
  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: 'OpenCode Zen Free' }
  }

  /**
   * Provider-owned retry policy.
   * @param _provider - route key.
   * @returns resolved policy.
   */
  override providerRetryPolicy(_provider: string): ResolvedZenOptions['retryPolicy'] {
    return this.deps.options().retryPolicy
  }

  /**
   * List advisory models.
   * @param provider - route key.
   * @returns models in catalog order.
   */
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    void provider
    return Promise.resolve(this.catalog.map(model => ({
      provider: ZEN_PROVIDER,
      id: model.id,
      name: model.name,
      inputModalities: [...model.input],
    })))
  }

  /**
   * Resolve exact model metadata.
   * @param provider - route key.
   * @param model - exact model id.
   * @param _signal - cancellation.
   * @returns resolved info.
   */
  override resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const found = this.catalog.find(entry => entry.id === model)
    if (found === undefined) throw new LlmError(`opencode-zen-free has no model "${model}"`, 'UNKNOWN_MODEL')
    const options = this.deps.options()
    const rawDefault = options.reasoning ?? (model.startsWith('muse-spark-') ? 'xhigh' : undefined)
    const supported = getSupportedThinkingLevels(found)
    const supportedDefault = rawDefault === undefined
      ? undefined
      : supported.find(level => level === rawDefault)
    const describable = supportedDefault === undefined ? undefined : ReasoningEffortId(supportedDefault)
    const configuredCap = options.maxTokens
    return Promise.resolve({
      provider,
      id: model,
      name: found.name,
      inputModalities: [...found.input],
      context: { contextWindow: found.contextWindow },
      ...(configuredCap === undefined ? {} : { defaultMaxTokens: configuredCap }),
      // No installed-catalog model ships without reasoning; the guard stays for
      // catalog drift so a future text-only model is not offered a no-op control.
      /* v8 ignore next -- no free-tier catalog model lacks reasoning metadata */
      ...(!found.reasoning ? {} : {
        reasoning: {
          efforts: supported.map(level => ({ id: ReasoningEffortId(level), name: `${level.charAt(0).toUpperCase()}${level.slice(1)}` })),
          ...(describable === undefined ? {} : { defaultEffort: describable }),
        },
      }),
    })
  }

  /**
   * Bind model metadata and dispatch.
   * @param provider - route key.
   * @param model - exact model id.
   * @param signal - cancellation.
   * @returns prepared call.
   */
  override prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return this.resolveModel(provider, model, signal).then(resolved => ({
      model: resolved,
      stream: options => this.stream(options),
    }))
  }

  /**
   * Stream one model call.
   * @param options - fully assembled request.
   * @returns chunk stream ending with usage then finish.
   */
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.generate(options)
  }

  /**
   * Generate with Zen identity, encrypted-content retry, and pi-ai translation.
   * @param options - harness request.
   * @returns chunk stream.
   */
  private async * generate(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (options.provider !== ZEN_PROVIDER) throw new LlmError(`zen adapter does not own provider "${options.provider}"`, 'NO_ADAPTER')
    if (options.stop !== undefined) throw new LlmError('dsh-opencode-free does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    const model = this.models.getModel(ZEN_PROVIDER, options.model)
    if (model === undefined) throw new LlmError(`opencode-zen-free has no model "${options.model}"`, 'UNKNOWN_MODEL')
    const resolved = this.deps.options()
    const rawKey = await this.deps.resolveApiKey()
    // The resolver never yields a blank key: absence falls back to the anonymous tier.
    const apiKey = rawKey.trim()
    const effective = swapCompactionPrompt(options, apiKey)
    let reasoning: ThinkingLevel | undefined
    // The anonymous tier rejects Responses requests without a reasoning envelope,
    // so only keyed auxiliary calls omit thinking to save output tokens.
    if (effective.purpose === SESSION_TITLE_PURPOSE && !isAnonymousKey(apiKey)) {
      reasoning = undefined
    } else if (effective.reasoningEffort !== undefined) {
      const wanted = String(effective.reasoningEffort)
      if (wanted !== 'off' && !getSupportedThinkingLevels(model).some(level => level === wanted)) {
        throw new LlmError(
          `opencode-zen-free model "${model.id}" does not support reasoning effort "${wanted}"`,
          'UNSUPPORTED_REASONING_EFFORT',
        )
      }
      reasoning = wanted === 'off' ? undefined : (wanted as ThinkingLevel)
    } else {
      const fallback = defaultReasoning(model.id, resolved.reasoning)
      if (fallback !== undefined && !getSupportedThinkingLevels(model).some(level => level === fallback)) {
        throw new LlmError(
          `opencode-zen-free model "${model.id}" does not support reasoning effort "${fallback}"`,
          'UNSUPPORTED_REASONING_EFFORT',
        )
      }
      reasoning = fallback
    }

    const consumer = new AbortController()
    const upstream = options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, resolved.streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')
    try {
      const containsImage = effective.messages.some(message => contentHasImage(message.content))
      if (containsImage && !model.input.includes('image')) {
        throw new LlmError(`zen model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
      }
      const attachments = containsImage ? this.deps.resolveAttachments?.() : undefined
      if (containsImage && attachments === undefined) {
        throw new LlmError('zen image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
      }
      const onReplayDegrade = (reason: string): void => {
        this.deps.onReplayDegrade?.({ provider: options.provider, model: options.model, reason })
      }
      const context = attachments === undefined
        ? toPiContext(effective, undefined, onReplayDegrade)
        : await toPiContext({ ...effective, signal: watchdog.signal }, {
          attachments,
          resolveImageAccess: ref => this.deps.resolveImageAccess?.(attachments, ref),
          maxRequestImageBytes: 20 * 1024 * 1024,
        }, onReplayDegrade)
      const sessionSeed = effective.sessionId === undefined ? randomUUID() : String(effective.sessionId)
      const zenSession = sessionHeader(sessionSeed)
      const attribution = attributionHeaders()
      const baseUserAgent = attribution['user-agent']
      const headers = {
        ...attribution,
        ...STATIC_ZEN_HEADERS,
        'User-Agent': `${baseUserAgent} opencode/1.18.31`,
        Authorization: `Bearer ${apiKey}`,
        'x-client-request-id': zenSession,
        'x-opencode-session': zenSession,
        'x-opencode-request': requestHeader(),
      }
      const maxTokens = effective.maxTokens ?? resolved.maxTokens
      const events = this.models.streamSimple(model, context, {
        apiKey,
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(effective.temperature === undefined ? {} : { temperature: effective.temperature }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
        ...(effective.sessionId === undefined ? {} : { sessionId: String(effective.sessionId) }),
        signal: watchdog.signal,
        timeoutMs: resolved.timeoutMs,
        maxRetries: 0,
        fetch: withEncryptedContentFallback(undefined),
        headers,
      })
      const stream = toStreamChunks(events, model.contextWindow, options.signal, model.id)[Symbol.asyncIterator]()
      try {
        while (true) {
          const next = await watchdog.next(stream)
          const idleTimeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
          if (idleTimeout !== undefined) throw idleTimeout
          if (next.done) break
          yield next.value
        }
      } finally {
        consumer.abort('zen stream consumer stopped')
        try {
          await stream.return(undefined)
        } catch (_settledReturn) {
          // A settled stream reports no teardown outcome.
        }
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(`zen stream idle timeout after ${resolved.streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) throw new LlmError('zen request aborted by caller', 'ABORTED', { cause: error })
      throw error
    } finally {
      consumer.abort('zen stream consumer stopped')
    }
  }
}
