import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CONTEXT_OVERFLOW_CLAUSE,
  ZEN_FAILURE_GUIDANCE,
  zenProvider,
} from '../src/zen-provider.ts'
import {
  completionsToolCall,
  refusal,
  scriptedUpstream,
  textOf,
  textReply,
  toolNames,
  truncatedStream,
} from './helpers/replay-upstream.mjs'

// Offline replay, tier B1: the provider runs against a scripted upstream, so
// each scenario is repeatable and spends no anonymous quota. See
// docs/offline-replay-design.md. Host behavior (tool loop through a real DSH,
// compaction) belongs to tier B2.

const APIS = ['openai-completions', 'openai-responses']
const SESSION = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const user = text => ({ role: 'user', content: text, timestamp: 1 })

const modelFor = (provider, api, overrides = {}) => {
  const base = provider.getModels().find(m => m.api === api) ?? { ...provider.getModels()[0], api }
  return { ...base, ...overrides }
}

const run = async (upstream, { api = 'openai-completions', context, options = {}, model = {} } = {}) => {
  const provider = zenProvider(() => 'replay-session')
  const stream = provider.streamSimple(
    modelFor(provider, api, model),
    context ?? { messages: [user('OK')] },
    { apiKey: 'public', maxRetries: 0, fetch: upstream.fetch, ...options },
  )
  return stream.result()
}

test('S1 a plain reply arrives as text and carries the anonymous identity', async t => {
  for (const api of APIS) await t.test(api, async () => {
    const upstream = scriptedUpstream([textReply[api]('REPLAY-OK')])
    const result = await run(upstream, { api })
    assert.equal(result.stopReason, 'stop')
    assert.equal(textOf(result), 'REPLAY-OK')

    const [request] = upstream.requests
    assert.equal(upstream.requests.length, 1)
    assert.equal(request.url, `https://opencode.ai/inference/v1/${api === 'openai-responses' ? 'responses' : 'chat/completions'}`)
    assert.equal(request.headers.get('authorization'), 'Bearer public')
    assert.equal(request.headers.get('x-opencode-client'), 'cli')
    assert.match(request.headers.get('x-opencode-session'), SESSION)
    assert.deepEqual(toolNames(request.body), ['bash', 'read'], 'admission tools are declared')
  })
})

test('S2 a tool call is surfaced and its result is replayed on the next request', async t => {
  const provider = zenProvider(() => 'replay-session')
  const model = modelFor(provider, 'openai-completions')
  const tool = {
    name: 'read',
    description: 'Read a UTF-8 text file.',
    parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
  }
  const upstream = scriptedUpstream([
    completionsToolCall('read', { file_path: 'note.txt' }),
    textReply['openai-completions']('The note says hello.'),
  ])
  const options = { apiKey: 'public', maxRetries: 0, fetch: upstream.fetch }

  const first = await provider.streamSimple(model, { messages: [user('read note.txt')], tools: [tool] }, options).result()
  assert.equal(first.stopReason, 'toolUse')
  const call = first.content.find(part => part.type === 'toolCall')
  assert.equal(call.name, 'read')
  assert.deepEqual(call.arguments, { file_path: 'note.txt' })

  const history = [
    user('read note.txt'),
    first,
    { role: 'toolResult', toolCallId: call.id, toolName: 'read', content: [{ type: 'text', text: 'hello' }], isError: false, timestamp: 2 },
  ]
  const second = await provider.streamSimple(model, { messages: history, tools: [tool] }, options).result()
  assert.equal(second.stopReason, 'stop')
  assert.equal(textOf(second), 'The note says hello.')

  const replayed = upstream.requests[1].body.messages
  const assistant = replayed.find(m => m.role === 'assistant')
  assert.equal(assistant.tool_calls[0].id, call.id)
  assert.equal(assistant.tool_calls[0].function.name, 'read')
  const result = replayed.find(m => m.role === 'tool')
  assert.equal(result.tool_call_id, call.id, 'the result pairs with the call')
  assert.equal(replayed.at(-1), result, 'the tool result is the last message')
  const [one, two] = upstream.requests.map(r => r.headers.get('x-opencode-session'))
  assert.match(one, SESSION)
  assert.equal(one, two, 'both turns share one session identity')
})

test('S3 a generic refusal after pi-ai lowered max_tokens is named as a context overflow', async t => {
  const big = 'x'.repeat(40_000)
  for (const api of APIS) await t.test(api, async () => {
    const upstream = scriptedUpstream([
      refusal(400, { type: 'invalid_request_error', message: 'Error from provider (Console): Upstream request failed: [invalid_request_error] invalid request' }),
    ])
    const result = await run(upstream, {
      api,
      context: { messages: [user(big)] },
      model: { contextWindow: 20_000, maxTokens: 16_000 },
    })
    assert.equal(result.stopReason, 'error')
    assert.ok(result.errorMessage.endsWith(CONTEXT_OVERFLOW_CLAUSE), result.errorMessage)
    assert.match(result.errorMessage, /invalid request/, 'the upstream wording is kept')
  })
})

test('S3 the same refusal without a lowered max_tokens keeps the upstream wording', async () => {
  const upstream = scriptedUpstream([
    refusal(400, { type: 'invalid_request_error', message: 'Error from provider (Console): Upstream request failed: [invalid_request_error] invalid request' }),
  ])
  const result = await run(upstream)
  assert.equal(result.stopReason, 'error')
  assert.doesNotMatch(result.errorMessage, new RegExp(CONTEXT_OVERFLOW_CLAUSE))
})

test('S5 a rate limit retries a bounded number of times and then gives guidance', async t => {
  const limited = () => refusal(429, { type: 'FreeUsageLimitError', message: 'limit' }, { 'retry-after-ms': '1' })

  await t.test('recovers when a later attempt is admitted', async () => {
    const upstream = scriptedUpstream([limited(), textReply['openai-completions']('RECOVERED')])
    const result = await run(upstream, { options: { maxRetries: 1 } })
    assert.equal(textOf(result), 'RECOVERED')
    assert.equal(upstream.requests.length, 2)
  })

  await t.test('stops at the retry budget', async () => {
    const upstream = scriptedUpstream([limited(), limited(), limited()])
    const result = await run(upstream, { options: { maxRetries: 1 } })
    assert.equal(result.stopReason, 'error')
    assert.equal(upstream.requests.length, 2, 'one request plus one retry, no more')
    assert.equal(upstream.remaining(), 1)
    assert.ok(result.errorMessage.startsWith(ZEN_FAILURE_GUIDANCE['quota-exhausted']))
    assert.match(result.errorMessage, /HTTP 429/)
  })
})

test('S6 refusals map to guidance and never echo the credential', async t => {
  const secret = 'sk-replay-secret-0123456789'
  const cases = [
    { name: '401 with a key', status: 401, error: { type: 'authentication_error', message: `Invalid API key ${secret}` }, apiKey: secret, kind: 'bad-key' },
    { name: '403 free-tier refusal', status: 403, error: { type: 'FreeTierError', message: 'blocked' }, apiKey: 'public', kind: 'anon-gated' },
  ]
  for (const { name, status, error, apiKey, kind } of cases) await t.test(name, async () => {
    const upstream = scriptedUpstream([refusal(status, error)])
    const result = await run(upstream, { options: { apiKey } })
    assert.equal(result.stopReason, 'error')
    assert.ok(result.errorMessage.startsWith(ZEN_FAILURE_GUIDANCE[kind]), result.errorMessage)
    assert.ok(!result.errorMessage.includes(secret), 'the credential is not in the error')
    assert.equal(upstream.requests.length, 1)
  })
})

test('S7 a connection that drops mid-stream ends in an error instead of hanging', async t => {
  await t.test('stream cut inside a frame keeps the text received and reports an error', async t => {
    // The OpenAI SDK logs the unparseable frame; its level is read when the client is built.
    const previous = process.env.OPENAI_LOG
    process.env.OPENAI_LOG = 'off'
    t.after(() => { if (previous === undefined) delete process.env.OPENAI_LOG; else process.env.OPENAI_LOG = previous })
    const frames = [
      { id: 'replay', object: 'chat.completion.chunk', created: 1, model: 'replay', choices: [{ index: 0, delta: { role: 'assistant', content: 'part' }, finish_reason: null }] },
      { id: 'replay', object: 'chat.completion.chunk', created: 1, model: 'replay', choices: [{ index: 0, delta: { content: 'ial' }, finish_reason: null }] },
    ]
    const result = await run(scriptedUpstream([truncatedStream(frames)]), { options: { signal: AbortSignal.timeout(5_000) } })
    assert.equal(result.stopReason, 'error')
    assert.match(result.errorMessage, /malformed server-sent event/i)
    assert.equal(textOf(result), 'part')
  })

  await t.test('socket failure reports its cause', async () => {
    const error = new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) })
    const result = await run(scriptedUpstream([error]))
    assert.equal(result.stopReason, 'error')
    assert.match(result.errorMessage, /ECONNRESET/)
  })
})

test('S9 the reasoning effort reaches the request body on both channels', async t => {
  for (const effort of ['low', 'high']) for (const api of APIS) await t.test(`${api} ${effort}`, async () => {
    const upstream = scriptedUpstream([textReply[api]('OK')])
    await run(upstream, { api, model: { reasoning: true }, options: { reasoning: effort } })
    const body = upstream.requests[0].body
    assert.equal(body.reasoning_effort ?? body.reasoning?.effort, effort)
  })
})
