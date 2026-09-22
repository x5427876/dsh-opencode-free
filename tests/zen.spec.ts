/**
 * Unit coverage for Zen identity helpers and config resolution.
 * @module dsh-opencode-free/zen-spec
 */

import { describe, expect, it, vi } from 'vitest'
import { resolveZenOptions } from '../src/config.ts'
import { zenAuth, zenModels } from '../src/adapter.ts'
import {
  ZEN_BASE_URL,
  ZEN_PROVIDER,
  base62FromBytes,
  isAnonymousKey,
  isEncryptedContentError,
  requestHeader,
  sessionHeader,
  stripStaleReasoning,
  withEncryptedContentFallback,
} from '../src/zen.ts'

describe('zen identity', () => {
  it('maps a session to a valid OpenCode id', () => {
    expect(sessionHeader('abc')).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(sessionHeader('abc')).toBe(sessionHeader('abc'))
    expect(sessionHeader('a')).not.toBe(sessionHeader('b'))
  })

  it('issues random request ids', () => {
    expect(requestHeader()).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(requestHeader()).not.toBe(requestHeader())
  })

  it('detects encrypted-content rotation', () => {
    expect(isEncryptedContentError(400, 'reasoning `encrypted_content` was not issued')).toBe(true)
    expect(isEncryptedContentError(400, 'other')).toBe(false)
    expect(isEncryptedContentError(500, 'encrypted_content')).toBe(false)
  })

  it('strips stale reasoning', () => {
    const stripped = stripStaleReasoning({
      input: [
        { type: 'reasoning', id: 'rs_1' },
        { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'read' },
        { type: 'message', role: 'user' },
      ],
    }) as { input: Array<Record<string, unknown>> }
    expect(stripped.input.some(item => item.type === 'reasoning')).toBe(false)
    expect(stripped.input[0]).not.toHaveProperty('id')
    expect(stripStaleReasoning({ input: [{ type: 'message' }] })).toBe(null)
  })

  it('treats blank and public as anonymous', () => {
    expect(isAnonymousKey('public')).toBe(true)
    expect(isAnonymousKey('  ')).toBe(true)
    expect(isAnonymousKey('sk-zen')).toBe(false)
  })

  it('passes non-400 responses through', async () => {
    const first = new Response('{}', { status: 200 })
    const inner = vi.fn(async () => first)
    const fetch = withEncryptedContentFallback(inner)
    await expect(fetch('https://opencode.ai/zen/v1/models', {})).resolves.toBe(first)
    expect(inner).toHaveBeenCalledTimes(1)
  })

  it('passes foreign 400 responses through', async () => {
    const first = new Response('{"error":"bad"}', { status: 400 })
    const inner = vi.fn(async () => first)
    const fetch = withEncryptedContentFallback(inner)
    await expect(fetch('https://x', {})).resolves.toBe(first)
    expect(inner).toHaveBeenCalledTimes(1)
  })

  it('retries once without stale reasoning on rotation', async () => {
    const rotated = new Response('reasoning `encrypted_content` was not issued to this caller', { status: 400 })
    const retried = new Response('{}', { status: 200 })
    const inner = vi.fn(async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => retried)
    inner.mockResolvedValueOnce(rotated)
    const fetch = withEncryptedContentFallback(inner)
    const body = JSON.stringify({ input: [{ type: 'reasoning' }, { type: 'message' }] })
    await expect(fetch('https://x', { body, method: 'POST' })).resolves.toBe(retried)
    expect(inner).toHaveBeenCalledTimes(2)
    const sent = inner.mock.calls[1]?.[1] as { body?: unknown } | undefined
    expect(typeof sent?.body).toBe('string')
    expect(JSON.parse(sent?.body as string)).toEqual({ input: [{ type: 'message' }] })
  })

  it('keeps the first response when nothing can be stripped', async () => {
    const first = new Response('encrypted_content mismatch', { status: 400 })
    const inner = vi.fn(async () => first)
    const fetch = withEncryptedContentFallback(inner)
    await expect(fetch('https://x', { body: JSON.stringify({ input: [] }), method: 'POST' })).resolves.toBe(first)
    expect(inner).toHaveBeenCalledTimes(1)
  })

  it('encodes empty input as zero digits', () => {
    expect(base62FromBytes(new Uint8Array(0), 3)).toBe('000')
  })

  it('rejects null, driverless, and reasonless bodies', () => {
    expect(stripStaleReasoning(null)).toBe(null)
    expect(stripStaleReasoning({})).toBe(null)
    expect(stripStaleReasoning({ input: [null] })).toBe(null)
  })
  it('keeps the first response for a non-string body', async () => {
    const first = new Response('encrypted_content mismatch', { status: 400 })
    const inner = vi.fn(async () => first)
    const fetch = withEncryptedContentFallback(inner)
    await expect(fetch('https://x')).resolves.toBe(first)
    expect(inner).toHaveBeenCalledTimes(1)
  })

  it('keeps the first response for an unparsable body', async () => {
    const first = new Response('encrypted_content mismatch', { status: 400 })
    const inner = vi.fn(async () => first)
    const fetch = withEncryptedContentFallback(inner)
    await expect(fetch('https://x', { body: 'encrypted_content {oops', method: 'POST' })).resolves.toBe(first)
    expect(inner).toHaveBeenCalledTimes(1)
  })

  it('builds on the global fetch when no override is given', () => {
    expect(typeof withEncryptedContentFallback()).toBe('function')
  })

  it('keeps the first response when its body cannot be read', async () => {
    class UnreadableResponse extends Response {
      override clone(): Response {
        throw new Error('gone')
      }
    }
    const first = new UnreadableResponse('encrypted_content mismatch', { status: 400 })
    const inner = vi.fn(async () => first)
    const fetch = withEncryptedContentFallback(inner)
    await expect(fetch('https://x', {})).resolves.toBe(first)
  })
})

describe('zen config', () => {
  it('resolves defaults', () => {
    const resolved = resolveZenOptions({})
    expect(resolved.apiKeyEnv).toBe('OPENCODE_API_KEY')
    expect(resolved.baseURL).toBe(ZEN_BASE_URL)
    expect(resolved.timeoutMs).toBe(180_000)
  })

  it('rejects a non-http endpoint', () => {
    expect(() => resolveZenOptions({ baseURL: 'ftp://x' })).toThrow()
  })

  it('rejects an empty endpoint', () => {
    expect(() => resolveZenOptions({ baseURL: '' })).toThrow()
  })

  it('keeps explicit option values', () => {
    const resolved = resolveZenOptions({
      apiKeyEnv: 'ZEN_KEY',
      baseURL: 'https://proxy.example.com/zen/',
      reasoning: 'low',
      maxTokens: 1024,
      timeoutMs: 1000,
      models: ['muse-spark-1.3-contributor-free'],
      retryPolicy: { mode: 'always', maxRetries: 1 },
    })
    expect(resolved.apiKeyEnv).toBe('ZEN_KEY')
    expect(resolved.baseURL).toBe('https://proxy.example.com/zen')
    expect(resolved.reasoning).toBe('low')
    expect(resolved.maxTokens).toBe(1024)
    expect(resolved.timeoutMs).toBe(1000)
    expect(resolved.models).toEqual(['muse-spark-1.3-contributor-free'])
    expect(resolved.retryPolicy).toMatchObject({ mode: 'always' })
  })

  it('treats an empty model list as the free catalog', () => {
    expect(resolveZenOptions({ models: [] }).models).toBe(undefined)
  })
})

describe('zen auth', () => {
  const signal = new AbortController().signal
  const ctx = { env: async () => undefined, fileExists: async () => false }

  it('passes a stored key through', async () => {
    await expect(zenAuth().apiKey.resolve({ ctx, credential: { type: 'api_key', key: 'k' }, signal })).resolves.toEqual({
      auth: { apiKey: 'k' },
      source: 'opencode-zen-free',
    })
  })

  it('reports an empty auth without a key', async () => {
    await expect(zenAuth().apiKey.resolve({ ctx, signal })).resolves.toEqual({ auth: {}, source: 'opencode-zen-free' })
    await expect(zenAuth().apiKey.resolve({ ctx, credential: { type: 'api_key' }, signal })).resolves.toEqual({
      auth: {},
      source: 'opencode-zen-free',
    })
  })
})

describe('zen catalog', () => {
  it('advertises the free contributor model on this route', () => {
    const models = zenModels(ZEN_BASE_URL)
    const spark = models.find(model => model.id === 'muse-spark-1.3-contributor-free')
    expect(spark).toBeDefined()
    expect(spark?.provider).toBe(ZEN_PROVIDER)
    expect(spark?.baseUrl).toBe(ZEN_BASE_URL)
    expect(models.length).toBeGreaterThan(0)
    expect(models.every(model => model.provider === ZEN_PROVIDER)).toBe(true)
  })
})
