import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import {
  PROVIDER_ID,
  classifyZenFailure,
  ZEN_FAILURE_GUIDANCE,
  freeModels,
  isEncryptedContentError,
  requestHeader,
  resolveZenApiKey,
  sessionHeader,
  stripStaleReasoning,
  swapCompactionPrompt,
} from '../src/zen-provider.ts'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)))
const libUrl = new URL('../lib/', import.meta.url)
const hostFiles = (await readdir(libUrl)).filter((f) => f.endsWith('.js')).sort()
const host = (await Promise.all(hostFiles.map((f) => readFile(new URL(f, libUrl), 'utf8')))).join('\n')
const plugin = await import('../lib/index.js')
const { PiAiAdapter } = await import('@deepseek-ai/dsh-llm-pi-ai')
const { resolveRetryPolicy } = await import('@deepseek-ai/dsh-llm')

test('targets the DSH 0.1.7-rc.2 contracts', () => {
  assert.equal(pkg.version, '0.1.4')
  for (const [name, version] of Object.entries(pkg.peerDependencies)) {
    if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(version, '0.1.7-rc.2', name)
    assert.equal(pkg.peerDependenciesMeta[name]?.optional, true, name)
  }
  assert.equal(pkg.peerDependencies['@earendil-works/pi-ai'], '^0.85.1')
  assert.equal(pkg.peerDependencies['react'], undefined)
  assert.deepEqual(pkg.dsh, { bundle: { patch: './cordis.patch.yml' } })
})

test('registers opencode-zen-free through the PiAiAdapter seam', async () => {
  const provider = plugin.zenProvider(() => 'test-session', () => undefined)
  assert.equal(provider.id, 'opencode-zen-free')
  const models = provider.getModels()
  assert.ok(models.length > 0, 'expected at least one free model')
  for (const m of models) {
    assert.equal(m.provider, PROVIDER_ID)
    assert.ok(m.baseUrl?.includes('opencode.ai/zen'), m.id)
    assert.ok(Object.values(m.cost).every((c) => c === 0), m.id)
  }
  const profile = Object.freeze({
    provider: PROVIDER_ID,
    displayName: 'OpenCode Zen Free',
    piProvider: provider,
    modelErrors: new Map(),
    configuredMaxTokens: new Map(),
    streamIdleTimeoutMs: 600000,
    maxRequestImageBytes: 20 * 1024 * 1024,
    requestImagePixelBudget: 2048 * 2048,
    requestImageMaxBytes: 1024 * 1024,
    retryPolicy: resolveRetryPolicy(undefined, 'compatibility test'),
    cacheRetention: 'short',
    transport: 'sse',
  })
  const registered = []
  const fakeCtx = { llm: { registerAdapter: (routes, adapter) => { registered.push([routes, adapter]) } } }
  plugin.apply(fakeCtx, {})
  assert.deepEqual(registered[0][0], [PROVIDER_ID])
  assert.ok(registered[0][1] instanceof PiAiAdapter)
  const advertised = await registered[0][1].listModels(PROVIDER_ID)
  assert.deepEqual(advertised.map((m) => m.id), models.map((m) => m.id))
})

test('session/request headers are structurally valid OpenCode ids', () => {
  assert.match(sessionHeader('abc'), /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  assert.equal(sessionHeader('abc'), sessionHeader('abc'), 'stable per session')
  assert.notEqual(sessionHeader('a'), sessionHeader('b'), 'distinct between sessions')
  assert.match(requestHeader(), /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
})

test('encrypted-content retry triggers only on the 400 rotation signal', () => {
  assert.equal(isEncryptedContentError(400, 'reasoning `encrypted_content` was not issued to this caller'), true)
  assert.equal(isEncryptedContentError(400, 'encrypted content could not be verified'), true)
  assert.equal(isEncryptedContentError(403, 'reasoning `encrypted_content` was not issued'), false)
  assert.equal(isEncryptedContentError(400, 'FreeTierError'), false)
  const stripped = stripStaleReasoning({
    input: [
      { type: 'reasoning', id: 'rs_1' },
      { type: 'function_call', id: 'fc_1', call_id: 'c1' },
      { type: 'message', id: 'm1' },
    ],
  })
  assert.deepEqual(stripped, { input: [{ type: 'function_call', call_id: 'c1' }, { type: 'message', id: 'm1' }] })
  assert.equal(stripStaleReasoning({ input: [{ type: 'message' }] }), null)
})

test('compaction swap only rewrites short anonymous summarization prompts', async () => {
  const piPrompt = 'You are a context summarization assistant. Summarize.'
  const swapped = swapCompactionPrompt({ systemPrompt: piPrompt, messages: [], tools: [] }, 'public')
  assert.ok(swapped.systemPrompt.includes('context summarization agent'))
  assert.equal(swapCompactionPrompt({ systemPrompt: piPrompt, messages: [] }, 'sk-live-key').systemPrompt, piPrompt)
  assert.equal(swapCompactionPrompt({ systemPrompt: 'ordinary chat', messages: [] }, 'public').systemPrompt, 'ordinary chat')
  assert.equal((await resolveZenApiKey({ env: async () => undefined, configKey: '  ' })).apiKey, 'public')
  assert.equal((await resolveZenApiKey({ env: async () => 'env-key', configKey: undefined })).apiKey, 'env-key')
  assert.equal((await resolveZenApiKey({ env: async () => undefined, configKey: 'cfg-key' })).apiKey, 'cfg-key')
})

test('optional keys resolve config before env and send public when neither exists', async () => {
  const p = plugin.zenProvider()
  const model = p.getModels()[0]
  const context = { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }
  for (const [configKey, envKey, expected] of [
    [undefined, undefined, 'public'],
    ['  ', '  ', 'public'],
    [undefined, 'env-test-key', 'env-test-key'],
    ['config-test-key', 'env-test-key', 'config-test-key'],
  ]) {
    const { apiKey } = await resolveZenApiKey({ configKey, env: async () => envKey })
    let authorization
    await p.streamSimple(model, context, {
      apiKey,
      maxRetries: 0,
      fetch: async (_url, init) => {
        authorization = new Headers(init.headers).get('authorization')
        return new Response('{}', { status: 403, headers: { 'Content-Type': 'application/json' } })
      },
    }).result()
    assert.equal(authorization, `Bearer ${expected}`)
  }
})

test('upstream failures classify to actionable guidance (recorded bodies)', () => {
  // 403 body captured live 2026-09-22: the exact upstream verdict on this egress.
  assert.equal(classifyZenFailure(403, '{"type":"error","error":{"type":"FreeTierError","message":"Error from provider (Console): OpenCode\'s free tier can only be used from within OpenCode"}}'), 'anon-gated')
  // MissingSessionID shape per opencodex provider docs.
  assert.equal(classifyZenFailure(400, '{"type":"error","error":{"type":"MissingSessionID","message":"OpenCode\'s free tier can only be used in OpenCode"}}'), 'anon-gated')
  // 429 FreeUsageLimitError per opencode#42500.
  assert.equal(classifyZenFailure(429, '{"type":"error","error":{"type":"FreeUsageLimitError"}}'), 'quota-exhausted')
  assert.equal(classifyZenFailure(401, '{"error":{"type":"authentication_error","message":"invalid x-api-key"}}'), 'bad-key')
  assert.equal(classifyZenFailure(500, 'internal error'), 'unknown')
  assert.equal(classifyZenFailure(403, 'something entirely new'), 'unknown')
  // Guidance carries the actionable content, not just a label.
  assert.match(ZEN_FAILURE_GUIDANCE['anon-gated'], /匿名額度/)
  assert.match(ZEN_FAILURE_GUIDANCE['anon-gated'], /OPENCODE_API_KEY/)
  assert.doesNotMatch(ZEN_FAILURE_GUIDANCE['anon-gated'], /非插件問題|即解|出口 IP/)
  assert.match(ZEN_FAILURE_GUIDANCE['quota-exhausted'], /OPENCODE_API_KEY/)
  assert.match(ZEN_FAILURE_GUIDANCE['bad-key'], /key/)
})

test('catalogue refresh intersects live ids and survives failure', async () => {
  const p = plugin.zenProvider(() => undefined, () => undefined)
  const before = p.getModels().map((m) => m.id)
  assert.ok(before.length > 0)
  const known = before[0]
  const ctx = (fetch, publish) => ({
    stored: undefined,
    allowNetwork: true,
    signal: AbortSignal.timeout(5000),
    publish,
  })
  const origFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => Response.json({ data: [{ id: known }, { id: 'gpt-6-astra' }] })
    let update = null
    await p.refreshModels(ctx(null, async (u) => { update = u.update; return true }))
    update()
    assert.deepEqual(p.getModels().map((m) => m.id), [known])
    globalThis.fetch = async () => { throw new Error('offline') }
    await assert.rejects(p.refreshModels(ctx(null, async () => true)))
    assert.deepEqual(p.getModels().map((m) => m.id), [known])
    let called = false
    globalThis.fetch = async () => { called = true; throw new Error('must not fetch') }
    await p.refreshModels({ ...ctx(null, async () => true), allowNetwork: false })
    assert.equal(called, false)
  } finally {
    globalThis.fetch = origFetch
  }
})

test('request path surfaces guidance on gate failures (fixture transport)', async () => {
  const p = plugin.zenProvider(() => 's', () => undefined)
  const model = p.getModels()[0]
  const ctx = { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }
  const gate = (status, body) => async () =>
    new Response(body, { status, headers: { 'Content-Type': 'application/json' } })
  // pi-ai resolves transport failures (stopReason error), it does not reject.
  const r403 = await p.streamSimple(model, ctx, { fetch: gate(403, '{"type":"error","error":{"type":"FreeTierError","message":"only be used from within OpenCode"}}'), maxRetries: 0 }).result()
  assert.equal(r403.stopReason, 'error')
  assert.match(r403.errorMessage, /匿名額度/)
  const r429 = await p.streamSimple(model, ctx, { fetch: gate(429, '{"error":{"type":"FreeUsageLimitError"}}'), maxRetries: 0 }).result()
  assert.match(r429.errorMessage, /重置/)
  const r401 = await p.streamSimple(model, ctx, { fetch: gate(401, '{"error":{"message":"invalid x-api-key"}}'), maxRetries: 0 }).result()
  assert.match(r401.errorMessage, /key 無效/)
  const rUnknown = await p.streamSimple(model, ctx, { fetch: gate(403, 'something entirely new'), maxRetries: 0 }).result()
  assert.match(rUnknown.errorMessage, /403/)
  assert.doesNotMatch(rUnknown.errorMessage, /匿名額度/)
  // Responses transport formats failures differently (live-observed shape).
  const responsesModel = p.getModels().find((m) => m.api === 'openai-responses') ?? model
  const rResp = await p.streamSimple(responsesModel, ctx, { fetch: gate(403, '{"type":"FreeTierError","message":"only be used from within OpenCode"}}'), maxRetries: 0 }).result()
  assert.match(rResp.errorMessage, /匿名額度/)
  // The DSH session persists the streamed error event (its toStreamChunks
  // translates it to a finish chunk), not result(): iterate raw events.
  const seen = []
  for await (const ev of p.streamSimple(responsesModel, ctx, { fetch: gate(403, '{"type":"FreeTierError","message":"only be used from within OpenCode"}}'), maxRetries: 0 })) {
    seen.push(ev)
  }
  const errEv = seen.find((ev) => ev?.type === 'error' && typeof ev?.error?.errorMessage === 'string')
  assert.ok(errEv, 'expected a raw error event in the stream')
  assert.match(errEv.error.errorMessage, /匿名額度/)
})

test('anonymous requests satisfy the read+bash tool gate and map pwsh back', async () => {
  // Live replay 2026-09-27: Zen's anonymous tier 403s unless tools include
  // `read` and `bash` by name; DSH on Windows exposes `pwsh` instead.
  const p = plugin.zenProvider(() => 's', () => undefined)
  const model = p.getModels().find((m) => m.api === 'openai-responses')
  const tool = (name) => ({ name, description: name, parameters: { type: 'object', properties: {} } })
  const ctx = {
    tools: [tool('read'), tool('pwsh')],
    messages: [
      { role: 'user', content: 'ls', timestamp: 1 },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'call_0|fc_0', name: 'pwsh', arguments: {} }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: 2 },
      { role: 'toolResult', toolCallId: 'call_0|fc_0', toolName: 'pwsh', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 3 },
    ],
  }
  const sse = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'bash', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'bash', arguments: '{}' } },
    { type: 'response.completed', response: { id: 'r1', status: 'completed', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
  const run = async (context, apiKey) => {
    let body
    const events = []
    const s = p.streamSimple(model, context, {
      apiKey,
      maxRetries: 0,
      fetch: async (_url, init) => {
        body = JSON.parse(init.body)
        return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } })
      },
    })
    for await (const ev of s) events.push(ev)
    return { body, events, result: await s.result() }
  }
  const names = (body) => body.tools.map((t) => t.name).sort()

  const anon = await run(ctx, 'public')
  assert.deepEqual(names(anon.body), ['bash', 'read'])
  assert.ok(anon.body.input.some((i) => i.type === 'function_call' && i.name === 'bash'))
  assert.ok(!JSON.stringify(anon.body.input).includes('"pwsh"'))
  assert.equal(anon.result.content.find((c) => c.type === 'toolCall').name, 'pwsh')
  const end = anon.events.find((ev) => ev.type === 'toolcall_end')
  assert.equal(end.toolCall.name, 'pwsh')
  assert.equal(ctx.tools[1].name, 'pwsh', 'caller context must not be mutated')

  const keyed = await run(ctx, 'sk-test-key')
  assert.deepEqual(names(keyed.body), ['pwsh', 'read'])

  const bare = await run({ messages: [{ role: 'user', content: 'title', timestamp: 1 }] }, 'public')
  assert.deepEqual(names(bare.body), ['bash', 'read'])
})

test('free catalogue is non-empty and host output carries the Zen identity', () => {
  assert.ok(freeModels().length > 0)
  assert.match(host, /opencode-zen-free/)
  assert.match(host, /x-opencode-session/)
  assert.match(host, /registerAdapter/)
})
