/**
 * Configuration schema for the OpenCode Zen adapter.
 * @module dsh-opencode-free/config
 */

import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { ZEN_API_KEY_ENV, ZEN_BASE_URL } from './zen.js'

/**
 * Default per-request timeout.
 */
export const DEFAULT_TIMEOUT_MS = 180_000

/**
 * Default stream idle timeout.
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Default context window for Zen free models without exact metadata.
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/**
 * Default reasoning level.
 */
export type ZenReasoning = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * Plugin configuration.
 */
export interface Options {
  /** Credential reference resolved per request; absence means anonymous. */
  apiKeyEnv?: string
  /** Zen endpoint root. */
  baseURL?: string
  /** Default reasoning level; muse-spark models default to xhigh. */
  reasoning?: ZenReasoning
  /** Per-request output cap. */
  maxTokens?: number
  /** Per-request timeout. */
  timeoutMs?: number
  /** Stream idle timeout. */
  streamIdleTimeoutMs?: number
  /** Provider-owned retry policy. */
  retryPolicy?: RetryPolicyConfig
  /** Explicit model ids replacing the free catalog. */
  models?: string[]
}

/**
 * Resolved adapter options.
 */
export interface ResolvedZenOptions {
  /** Credential reference. */
  apiKeyEnv: string
  /** Zen endpoint root. */
  baseURL: string
  /** Default reasoning level. */
  reasoning: ZenReasoning | undefined
  /** Per-request output cap. */
  maxTokens: number | undefined
  /** Per-request timeout. */
  timeoutMs: number
  /** Stream idle timeout. */
  streamIdleTimeoutMs: number
  /** Retry policy. */
  retryPolicy: ResolvedRetryPolicy
  /** Explicit model ids, if configured. */
  models: readonly string[] | undefined
}

/**
 * Runtime schema for plugin config.
 */
export const Config = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(ZEN_API_KEY_ENV),
  baseURL: z.string().default(ZEN_BASE_URL),
  reasoning: z.union(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  maxTokens: z.number().step(1).min(1),
  timeoutMs: z.natural().default(DEFAULT_TIMEOUT_MS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
  models: z.array(z.string()),
})

/**
 * Plain options accepted by the resolver.
 */
export type ConfigInput = { [K in keyof Options]?: Options[K] }

/**
 * Resolve raw config to validated options.
 * @param source - raw options.
 * @returns resolved options.
 */
export function resolveZenOptions(source: ConfigInput = {}): ResolvedZenOptions {
  const parsed = Config(source)
  if (parsed.baseURL.length === 0) throw new Error('dsh-opencode-free: baseURL must be non-empty')
  if (!/^https?:\/\//.test(parsed.baseURL)) throw new Error('dsh-opencode-free: baseURL must use HTTP(S)')
  return {
    apiKeyEnv: parsed.apiKeyEnv,
    baseURL: parsed.baseURL.replace(/\/+$/, ''),
    reasoning: parsed.reasoning,
    maxTokens: parsed.maxTokens,
    timeoutMs: parsed.timeoutMs,
    streamIdleTimeoutMs: parsed.streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(parsed.retryPolicy, 'dsh-opencode-free: retryPolicy'),
    models: parsed.models.length === 0 ? undefined : [...parsed.models],
  }
}
