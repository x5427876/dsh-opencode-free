/**
 * Adapter behavior coverage over stub transports.
 * @module dsh-opencode-free/adapter-spec
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime, { BlockAssembler, createAssistantMessage, createSystemMessage, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, UserMessage } from '@deepseek-ai/dsh-llm'
import * as Zen from '../src/index.ts'
import { ZenAdapter, zenModels } from '../src/adapter.ts'
import { OPENCODE_SUMMARIZATION_PROMPT, ZEN_BASE_URL } from '../src/zen.ts'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  vi.unstubAllEnvs()
})

/** Recorded request headers. */
interface RecordedHeaders {
  [name: string]: string | string[] | undefined
}

/**
 * Local completions stand-in replaying one scripted SSE body per request.
 * @param events - SSE data lines.
 * @param delayMs - optional delay before the first byte.
 * @returns endpoint url plus recorded requests.
 */
async function completionsServer(events: string[], delayMs = 0): Promise<{
  url: string
  paths: string[]
  bodies: unknown[]
  headers: RecordedHeaders[]
}> {
  const paths: string[] = []
  const bodies: unknown[] = []
  const headers: Record<string, string | string[] | undefined>[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk) => { body += String(chunk) })
    request.on('end', () => {
      paths.push(request.url ?? '')
      bodies.push(body.length === 0 ? undefined : JSON.parse(body))
      headers.push({ ...request.headers })
      const send = (): void => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const event of events) response.write(`data: ${event}\n\n`)
        response.end()
      }
      if (delayMs === 0) send()
      else setTimeout(send, delayMs)
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, paths, bodies, headers }
}

const TEXT_EVENTS = [
  '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"content":"hello"},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
  '[DONE]',
]

const IMAGE_REF: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 1,
  width: 1,
  height: 1,
}

/**
 * Attachment backend serving host paths for offloaded images only.
 */
class OffloadOnlyStore extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 1024,
    maxImagesPerMessage: 1,
    maxMessageImageBytes: 1024,
    maxImagePixels: 4,
    maxImageDimension: 2,
    mediaTypes: ['image/png'],
  }

  /**
   * @returns never resolves; retained images never occur in these tests.
   */
  validateImage(): Promise<void> {
    return Promise.reject(new Error('unused'))
  }

  /**
   * @returns never resolves; retained images never occur in these tests.
   */
  saveImage(): Promise<ImageAttachmentRef> {
    return Promise.reject(new Error('unused'))
  }

  /**
   * @returns never resolves; retained images never occur in these tests.
   */
  readImage(): Promise<StoredImageAttachment> {
    return Promise.reject(new Error('unused'))
  }

  /**
   * Expose a host path so the access resolver runs its mapping.
   * @param _ref - durable reference.
   * @returns fixed host path.
   */
  override imageHostPath(_ref: ImageAttachmentRef): string | undefined {
    return '/host/img.png'
  }
}

/**
 * Mount the adapter with static config and no credential seam.
 * @param config - plugin config.
 * @returns live context.
 */
async function harness(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Zen, config)
  return ctx
}

/**
 * User text carrying replay provenance for one route model.
 * @param text - message text.
 * @param model - route model id.
 * @returns user message.
 */
function userText(text: string, model: string): UserMessage {
  return userContent([{ type: 'text', text }], model)
}

/**
 * User content carrying replay provenance for one route model.
 * @param content - message content blocks.
 * @param model - route model id.
 * @returns user message.
 */
function userContent(content: UserMessage['content'], model: string): UserMessage {
  return createUserMessage({
    content,
    source: { kind: 'model', provider: 'opencode-zen-free', model },
  })
}

/**
 * Stream one text request and assemble the result.
 * @param ctx - live context.
 * @param options - request overrides.
 * @returns assembled text.
 */
async function textOf(ctx: Context, options: Partial<GenerateOptions> & { model: string }): Promise<string> {
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream({
    provider: 'opencode-zen-free',
    messages: [userText('hi', options.model)],
    ...options,
  })) assembler.push(chunk)
  const message = assembler.message({ provider: 'opencode-zen-free', model: options.model })
  return message.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('')
}

describe('zen catalog', () => {
  it('re-homes explicit ids to this route', () => {
    const models = zenModels(ZEN_BASE_URL, ['muse-spark-1.3-contributor-free'])
    expect(models.map(model => model.id)).toEqual(['muse-spark-1.3-contributor-free'])
    expect(models.every(model => model.provider === 'opencode-zen-free')).toBe(true)
  })

  it('describes spark reasoning by default', async () => {
    const ctx = await harness()
    const spark = await ctx.llm.resolveModelInfo('opencode-zen-free', 'muse-spark-1.3-contributor-free')
    expect(spark.reasoning?.defaultEffort).toEqual(ReasoningEffortId('xhigh'))
    const other = await ctx.llm.resolveModelInfo('opencode-zen-free', 'big-pickle')
    expect(other.reasoning?.defaultEffort).toBe(undefined)
    expect(other.context?.contextWindow).toBeGreaterThan(0)
    await ctx.fiber.dispose()
  })

  it('honors a configured reasoning default and output cap', async () => {
    const ctx = await harness({ reasoning: 'off', maxTokens: 512 })
    const spark = await ctx.llm.resolveModelInfo('opencode-zen-free', 'muse-spark-1.3-contributor-free')
    expect(spark.reasoning?.defaultEffort).toBe(undefined)
    expect(spark.defaultMaxTokens).toBe(512)
    await ctx.fiber.dispose()
  })

  it('rejects unknown models', async () => {
    const ctx = await harness()
    await expect(ctx.llm.resolveModelInfo('opencode-zen-free', 'nope')).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
    await ctx.fiber.dispose()
  })

  it('names the provider and its retry policy', async () => {
    const ctx = await harness()
    expect(ctx.llm.listProviders()).toEqual([{ id: 'opencode-zen-free', name: 'OpenCode Zen Free' }])
    expect(ctx.llm.providerRetryPolicy('opencode-zen-free')).toMatchObject({ mode: 'normal' })
    const adapter = new ZenAdapter({ options: () => Zen.resolveZenOptions({}), resolveApiKey: () => Promise.resolve('public') })
    const prepared = await adapter.prepareCall('opencode-zen-free', 'big-pickle')
    expect(prepared.model.id).toBe('big-pickle')
    await ctx.fiber.dispose()
  })
})

describe('zen stream guards', () => {
  it('refuses foreign providers, stop lists, unknown models, and bad efforts', async () => {
    const adapter = new ZenAdapter({ options: () => Zen.resolveZenOptions({}), resolveApiKey: () => Promise.resolve('public') })
    const base = {
      provider: 'opencode-zen-free',
      model: 'big-pickle',
      messages: [userText('hi', 'big-pickle')],
    }
    await expect(collect(adapter.stream({ ...base, provider: 'elsewhere' }))).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    await expect(collect(adapter.stream({ ...base, stop: ['x'] }))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    await expect(collect(adapter.stream({ ...base, model: 'nope' }))).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
    await expect(collect(adapter.stream({ ...base, reasoningEffort: ReasoningEffortId('ultra') }))).rejects.toMatchObject({
      code: 'UNSUPPORTED_REASONING_EFFORT',
    })
  })

  it('rejects images the model or the composition cannot serve', async () => {
    const adapter = new ZenAdapter({ options: () => Zen.resolveZenOptions({}), resolveApiKey: () => Promise.resolve('public') })
    const image = { type: 'image', attachment: IMAGE_REF } as const
    await expect(collect(adapter.stream({
      provider: 'opencode-zen-free',
      model: 'big-pickle',
      messages: [userContent([image], 'big-pickle')],
    }))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    await expect(collect(adapter.stream({
      provider: 'opencode-zen-free',
      model: 'muse-spark-1.3-contributor-free',
      messages: [userContent([image], 'muse-spark-1.3-contributor-free')],
    }))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('maps a caller abort during conversion to ABORTED', async () => {
    const adapter = new ZenAdapter({ options: () => Zen.resolveZenOptions({}), resolveApiKey: () => Promise.resolve('public') })
    const controller = new AbortController()
    controller.abort()
    const image = { type: 'image', attachment: IMAGE_REF } as const
    await expect(collect(adapter.stream({
      provider: 'opencode-zen-free',
      model: 'big-pickle',
      messages: [userContent([image], 'big-pickle')],
      signal: controller.signal,
    }))).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('degrades unusable replay state to provider-neutral content', async () => {
    const server = await completionsServer(TEXT_EVENTS)
    const ctx = await harness({ baseURL: server.url })
    const text = await textOf(ctx, {
      model: 'big-pickle',
      messages: [
        userText('hi', 'big-pickle'),
        createAssistantMessage({
          content: [{ type: 'text', text: 'stale' }],
          source: { provider: 'opencode-zen-free', model: 'big-pickle', replayState: { response: { kind: 'bogus' }, blocks: [] } },
        }),
        userText('again', 'big-pickle'),
      ],
    })
    expect(text).toBe('hello')
    await ctx.fiber.dispose()
  })
})

/**
 * Read system message texts from one recorded completions body.
 * @param body - recorded request body.
 * @returns system contents.
 */
function systemTexts(body: unknown): string[] {
  const messages = (body as { messages?: { role?: unknown; content?: unknown }[] }).messages ?? []
  return messages
    .filter(msg => msg.role === 'system' && typeof msg.content === 'string')
    .map(msg => msg.content as string)
}

describe('zen call options', () => {
  it('sends temperature, output cap, session routing, and explicit effort', async () => {
    const server = await completionsServer(TEXT_EVENTS)
    const ctx = await harness({ baseURL: server.url })
    const text = await textOf(ctx, {
      model: 'big-pickle',
      temperature: 0.5,
      maxTokens: 64,
      sessionId: 'zen-test-session' as never,
      reasoningEffort: ReasoningEffortId('low'),
    })
    expect(text).toBe('hello')
    const body = server.bodies[0] as { temperature?: number; max_tokens?: number }
    expect(body.temperature).toBe(0.5)
    expect(body.max_tokens).toBe(64)
    await ctx.fiber.dispose()
  })

  it('applies a configured default without runtime injection', async () => {
    const server = await completionsServer(TEXT_EVENTS)
    for (const reasoning of ['low', 'off'] as const) {
      const adapter = new ZenAdapter({
        options: () => Zen.resolveZenOptions({ baseURL: server.url, reasoning }),
        resolveApiKey: () => Promise.resolve('public'),
      })
      const assembler = new BlockAssembler()
      for await (const chunk of adapter.stream({
        provider: 'opencode-zen-free',
        model: 'big-pickle',
        messages: [userText('hi', 'big-pickle')],
      })) assembler.push(chunk)
      expect(assembler.finish).toEqual({ kind: 'stop' })
    }
    const failing = new ZenAdapter({
      options: () => Zen.resolveZenOptions({ baseURL: server.url, reasoning: 'max' }),
      resolveApiKey: () => Promise.resolve('public'),
    })
    await expect(collect(failing.stream({
      provider: 'opencode-zen-free',
      model: 'big-pickle',
      messages: [userText('hi', 'big-pickle')],
    }))).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
  })

  it('keeps thinking on anonymous auxiliary calls', async () => {
    const server = await responsesServer([{ blocks: RESPONSES_TEXT }])
    const ctx = await harness({ baseURL: server.url })
    await textOf(ctx, {
      model: SPARK_MODEL,
      purpose: 'session-title',
      system: 'Create a concise title for tests',
    })
    const body = server.bodies[0] as { reasoning?: { effort?: string } }
    expect(body.reasoning?.effort).toBe('xhigh')
    await ctx.fiber.dispose()
  })

  it('honors a configured reasoning default on the wire', async () => {
    const server = await completionsServer(TEXT_EVENTS)
    const low = await harness({ baseURL: server.url, reasoning: 'low' })
    expect(await textOf(low, { model: 'big-pickle' })).toBe('hello')
    await low.fiber.dispose()
    const off = await harness({ baseURL: server.url, reasoning: 'off' })
    expect(await textOf(off, { model: 'big-pickle' })).toBe('hello')
    await off.fiber.dispose()
  })

  it('keeps prompts without summarization wording intact', async () => {
    const server = await completionsServer(TEXT_EVENTS)
    const ctx = await harness({ baseURL: server.url })
    await textOf(ctx, {
      model: 'big-pickle',
      purpose: 'compaction',
      system: 'plain hello',
    })
    expect(systemTexts(server.bodies[0])).toEqual(['plain hello'])
    await textOf(ctx, {
      model: 'big-pickle',
      purpose: 'compaction',
      messages: [],
    })
    await textOf(ctx, {
      model: 'big-pickle',
      purpose: 'compaction',
      messages: [
        createSystemMessage('plain hello'),
        userText('summarize', 'big-pickle'),
      ],
    })
    expect(systemTexts(server.bodies[server.bodies.length - 1])).toEqual(['plain hello'])
    await ctx.fiber.dispose()
  })
})

describe('zen credentials', () => {
  it('prefers a stored credential over the anonymous tier', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-zen-creds-'))
    try {
      await writeFile(join(dir, '.credentials.yaml'), 'version: 1\nrefs:\n  ZEN_STORED_KEY: stored-zen-key\n', { mode: 0o600 })
      const server = await completionsServer(TEXT_EVENTS)
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), debounceMs: 10 })
      await ctx.plugin(Zen, { baseURL: server.url, apiKeyEnv: 'ZEN_STORED_KEY' })
      expect(await textOf(ctx, { model: 'big-pickle' })).toBe('hello')
      expect(server.headers[0]?.authorization).toBe('Bearer stored-zen-key')
      await ctx.fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses a stored credential no header can carry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-zen-creds-'))
    try {
      await writeFile(join(dir, '.credentials.yaml'), 'version: 1\nrefs:\n  ZEN_BAD_KEY: \'has space\'\n', { mode: 0o600 })
      const server = await completionsServer(TEXT_EVENTS)
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), debounceMs: 10 })
      await ctx.plugin(Zen, { baseURL: server.url, apiKeyEnv: 'ZEN_BAD_KEY' })
      const assembler = new BlockAssembler()
      for await (const chunk of ctx.llm.stream({
        provider: 'opencode-zen-free',
        model: 'big-pickle',
        messages: [userText('hi', 'big-pickle')],
      })) assembler.push(chunk)
      expect(assembler.finish).toMatchObject({ kind: 'error', failure: { code: 'INVALID_CREDENTIAL' } })
      await ctx.fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('zen images and timeouts', () => {
  it('sends offloaded images as placeholder text', async () => {
    const server = await responsesServer([{ blocks: RESPONSES_TEXT }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(OffloadOnlyStore)
    await ctx.plugin(Zen, { baseURL: server.url })
    const text = await textOf(ctx, {
      model: 'muse-spark-1.3-contributor-free',
      messages: [userContent([{ type: 'image', attachment: IMAGE_REF, offloaded: true }], SPARK_MODEL)],
    })
    expect(text).toBe('hello')
    expect(JSON.stringify(server.bodies[0])).toContain('image omitted to fit request image limits')
    await ctx.fiber.dispose()
  })

  it('fails a stalled stream with TIMEOUT', async () => {
    const server = await completionsServer(TEXT_EVENTS, 500)
    const adapter = new ZenAdapter({
      options: () => Zen.resolveZenOptions({ baseURL: server.url, streamIdleTimeoutMs: 50 }),
      resolveApiKey: () => Promise.resolve('public'),
    })
    await expect(collect(adapter.stream({
      provider: 'opencode-zen-free',
      model: 'big-pickle',
      messages: [userText('hi', 'big-pickle')],
    }))).rejects.toMatchObject({ code: 'TIMEOUT' })
  })
})

/**
 * One SSE block pairing an event name with its JSON payload.
 * @param event - server-sent event name.
 * @param data - payload.
 * @returns framed block.
 */
function sseBlock(event: string, data: unknown): string {
  return `event: ${event}
data: ${JSON.stringify(data)}`
}

const SPARK_MODEL = 'muse-spark-1.3-contributor-free'

/**
 * Minimal Responses text stream saying hello.
 */
const RESPONSES_TEXT: string[] = [
  sseBlock('response.created', { type: 'response.created', sequence_number: 0, response: { id: 'resp_fx', object: 'response', status: 'in_progress', model: SPARK_MODEL, output: [] } }),
  sseBlock('response.output_item.added', { type: 'response.output_item.added', sequence_number: 1, output_index: 1, item: { id: 'msg_fx', type: 'message', status: 'in_progress', role: 'assistant', content: [] } }),
  sseBlock('response.content_part.added', { type: 'response.content_part.added', sequence_number: 2, output_index: 1, content_index: 0, item_id: 'msg_fx' }),
  sseBlock('response.output_text.delta', { type: 'response.output_text.delta', sequence_number: 3, output_index: 1, content_index: 0, item_id: 'msg_fx', delta: 'hello', logprobs: [] }),
  sseBlock('response.content_part.done', { type: 'response.content_part.done', sequence_number: 4, output_index: 1, content_index: 0, item_id: 'msg_fx' }),
  sseBlock('response.output_item.done', { type: 'response.output_item.done', sequence_number: 5, output_index: 1, item: { id: 'msg_fx', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'hello', annotations: [] }] } }),
  sseBlock('response.completed', { type: 'response.completed', sequence_number: 6, response: { id: 'resp_fx', object: 'response', status: 'completed', model: SPARK_MODEL, error: null, output: [{ id: 'msg_fx', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } }),
]

/**
 * Responses stream carrying one stale reasoning chain before its text.
 */
const RESPONSES_REASONED: string[] = [
  sseBlock('response.created', { type: 'response.created', sequence_number: 0, response: { id: 'resp_fx', object: 'response', status: 'in_progress', model: SPARK_MODEL, output: [] } }),
  sseBlock('response.output_item.added', { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { id: 'rs_fx', type: 'reasoning', status: 'in_progress' } }),
  sseBlock('response.output_item.done', { type: 'response.output_item.done', sequence_number: 2, output_index: 0, item: { id: 'rs_fx', type: 'reasoning', status: 'completed', encrypted_content: 'enc-rotated' } }),
  sseBlock('response.output_item.added', { type: 'response.output_item.added', sequence_number: 3, output_index: 1, item: { id: 'msg_fx', type: 'message', status: 'in_progress', role: 'assistant', content: [] } }),
  sseBlock('response.output_text.delta', { type: 'response.output_text.delta', sequence_number: 4, output_index: 1, content_index: 0, item_id: 'msg_fx', delta: 'hello', logprobs: [] }),
  sseBlock('response.output_item.done', { type: 'response.output_item.done', sequence_number: 5, output_index: 1, item: { id: 'msg_fx', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'hello', annotations: [] }] } }),
  sseBlock('response.completed', { type: 'response.completed', sequence_number: 6, response: { id: 'resp_fx', object: 'response', status: 'completed', model: SPARK_MODEL, error: null, output: [{ id: 'rs_fx', type: 'reasoning', status: 'completed', encrypted_content: 'enc-rotated' }, { id: 'msg_fx', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } }),
]

/**
 * One scripted Responses behavior per request.
 */
interface ResponsesBehavior {
  /** Non-200 status with an optional JSON body. */
  status?: number
  /** Error payload for a non-200 behavior. */
  body?: string
  /** SSE blocks for a 200 behavior. */
  blocks?: string[]
}

/**
 * Local Responses stand-in replaying scripted behaviors in order.
 * @param script - one behavior per request.
 * @returns endpoint url plus recorded requests.
 */
async function responsesServer(script: ResponsesBehavior[]): Promise<{
  url: string
  paths: string[]
  bodies: unknown[]
}> {
  const paths: string[] = []
  const bodies: unknown[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk) => { body += String(chunk) })
    request.on('end', () => {
      paths.push(request.url ?? '')
      bodies.push(body.length === 0 ? undefined : JSON.parse(body))
      const behavior = script.shift() ?? { status: 500, body: 'script exhausted' }
      if (behavior.status !== undefined && behavior.status !== 200) {
        response.writeHead(behavior.status, { 'content-type': 'application/json' })
        response.end(behavior.body ?? '{}')
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const block of behavior.blocks ?? []) response.write(block + '\n\n')
      response.end()
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  const port = (address as { port: number }).port
  return { url: `http://127.0.0.1:${port}`, paths, bodies }
}

describe('zen responses', () => {
  it('streams spark text with default xhigh reasoning', async () => {
    const server = await responsesServer([{ blocks: RESPONSES_TEXT }])
    const ctx = await harness({ baseURL: server.url })
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({
      provider: 'opencode-zen-free',
      model: SPARK_MODEL,
      messages: [userText('hi', SPARK_MODEL)],
    })) assembler.push(chunk)
    expect(assembler.message({ provider: 'opencode-zen-free', model: SPARK_MODEL }).content).toEqual([
      { type: 'text', text: 'hello' },
    ])
    expect(assembler.usage).toEqual({ inputTokens: 3, outputTokens: 1, totalTokens: 4 })
    expect(assembler.finish).toEqual({ kind: 'stop' })
    expect(server.paths).toEqual(['/responses'])
    const body = server.bodies[0] as { reasoning?: { effort?: string } }
    expect(body.reasoning?.effort).toBe('xhigh')
    await ctx.fiber.dispose()
  })

  it('retries a rotated encrypted chain without replayed reasoning', async () => {
    const server = await responsesServer([
      { blocks: RESPONSES_REASONED },
      { status: 400, body: '{"error":"reasoning `encrypted_content` was not issued"}' },
      { blocks: RESPONSES_TEXT },
    ])
    const ctx = await harness({ baseURL: server.url })
    const first = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({
      provider: 'opencode-zen-free',
      model: SPARK_MODEL,
      messages: [userText('hi', SPARK_MODEL)],
    })) first.push(chunk)
    const prior = first.message({
      provider: 'opencode-zen-free',
      model: SPARK_MODEL,
      ...(first.replayState === undefined ? {} : { replayState: first.replayState }),
    })
    const second = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({
      provider: 'opencode-zen-free',
      model: SPARK_MODEL,
      messages: [userText('hi', SPARK_MODEL), prior, userText('again', SPARK_MODEL)],
    })) second.push(chunk)
    expect(second.message({ provider: 'opencode-zen-free', model: SPARK_MODEL }).content).toEqual([
      { type: 'text', text: 'hello' },
    ])
    expect(server.paths).toEqual(['/responses', '/responses', '/responses'])
    expect(JSON.stringify(server.bodies[1])).toContain('reasoning')
    expect(JSON.stringify(server.bodies[2])).not.toContain('"type":"reasoning"')
    await ctx.fiber.dispose()
  })
})

describe('zen auxiliary prompts', () => {
  it('swaps the compaction system prompt on the anonymous tier', async () => {
    const server = await completionsServer(TEXT_EVENTS)
    const ctx = await harness({ baseURL: server.url })
    const text = await textOf(ctx, {
      model: 'big-pickle',
      purpose: 'compaction',
      system: 'You are a context summarization assistant for tests',
    })
    expect(text).toBe('hello')
    expect(systemTexts(server.bodies[0])).toEqual([OPENCODE_SUMMARIZATION_PROMPT])
    await ctx.fiber.dispose()
  })

  it('swaps a leading system message and keeps keyed prompts intact', async () => {
    const server = await completionsServer(TEXT_EVENTS)
    const ctx = await harness({ baseURL: server.url })
    await textOf(ctx, {
      model: 'big-pickle',
      purpose: 'compaction',
      messages: [
        createSystemMessage('You are a context summarization assistant for tests'),
        userText('summarize', 'big-pickle'),
      ],
    })
    expect(systemTexts(server.bodies[0])).toEqual([OPENCODE_SUMMARIZATION_PROMPT])
    await ctx.fiber.dispose()

    vi.stubEnv('OPENCODE_API_KEY', 'test-zen-key')
    const keyed = await harness({ baseURL: server.url })
    await textOf(keyed, {
      model: 'big-pickle',
      purpose: 'session-title',
      system: 'You are a context summarization assistant for tests',
    })
    expect(systemTexts(server.bodies[server.bodies.length - 1])).toEqual([
      'You are a context summarization assistant for tests',
    ])
    const auth = server.headers[server.headers.length - 1]?.authorization
    expect(auth).toBe('Bearer test-zen-key')
    await keyed.fiber.dispose()
  })
})

/**
 * Drain one chunk stream, discarding output.
 * @param stream - chunk stream.
 */
async function collect(stream: AsyncIterable<unknown>): Promise<void> {
  await Array.fromAsync(stream)
}
