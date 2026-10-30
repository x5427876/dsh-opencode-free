import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import test from 'node:test'
import { createCatalog } from '../src/catalog.ts'
import {
  catalogTemplate,
  fetchZenModelIds,
  isZenNodeRequestOptions,
  patchGlobalFetchForZen,
  probeModel,
  sessionHeader,
  zenProvider,
} from '../src/zen-provider.ts'
import { OPENCODE_TLS_CIPHERS, zenHttpsFetch } from '../src/zen-tls.ts'

const endpoint = 'https://opencode.ai/inference/v1'
const context = { messages: [{ role: 'user', content: 'OK', timestamp: 1 }] }
const refused = () => Response.json({ error: { type: 'diagnostic_stop' } }, { status: 403 })

test('session identity uses the official descending time prefix and remains stable', t => {
  t.mock.method(Date, 'now', () => 0)
  const first = sessionHeader('fixed-time-first')
  // Official identifier worked example: timestamp 0, counter 1 => ~1 in six bytes.
  assert.equal(first.slice(0, 16), 'ses_fffffffffffe')
  const second = sessionHeader('fixed-time-second')
  assert.equal(second.slice(0, 16), 'ses_fffffffffffd')
  assert.notEqual(first, second)
  Date.now.mock.mockImplementation(() => 1000)
  assert.equal(sessionHeader('fixed-time-first'), first)
  const later = sessionHeader('fixed-time-later')
  Date.now.mock.mockImplementation(() => 0)
  const rollback = sessionHeader('fixed-time-rollback')
  assert.ok(rollback.slice(4, 16) < later.slice(4, 16), 'descending IDs do not reverse on clock rollback')
})

test('anonymous DSH definitions use admission parameter names without losing host constraints', async () => {
  const provider = zenProvider()
  const model = provider.getModels().find(m => m.api === 'openai-responses')
  const tools = [
    { name: 'read', description: 'Read a UTF-8 text file and return line-numbered content.', parameters: { type: 'object', properties: { file_path: { type: 'string', description: 'Path to read, resolved by the filesystem backend.' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['file_path'] } },
    { name: 'pwsh', description: 'Execute a PowerShell command (`pwsh -Command`) and return its stdout/stderr.', parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' }, timeoutMs: { type: 'number', description: 'Timeout in milliseconds.' }, workdir: { type: 'string' }, run_in_background: { type: 'boolean' } }, required: ['command', 'description'] } },
  ]
  const input = { ...context, tools }
  const before = structuredClone(input)
  let body
  await provider.streamSimple(model, input, { apiKey: 'public', maxRetries: 0, fetch: async (_, init) => { body = JSON.parse(init.body); return refused() } }).result()
  const read = body.tools.find(t => t.name === 'read')
  const bash = body.tools.find(t => t.name === 'bash')
  assert.deepEqual(read.parameters.required, ['filePath'])
  assert.equal(read.parameters.properties.filePath.type, 'string')
  assert.equal(read.parameters.properties.offset.type, 'number')
  assert.equal(bash.parameters.properties.timeout.type, 'number')
  assert.equal(bash.parameters.properties.run_in_background.type, 'boolean')
  assert.deepEqual(bash.parameters.required, ['command', 'description'])
  assert.match(bash.description, /PowerShell/)
  assert.match(read.description, /does not read directories, images, or PDFs/)
  assert.doesNotMatch(read.description, /can read image files|read a file or directory/i)
  assert.deepEqual(input, before)
})

test('later tool removals cannot discard admission declarations or the system prompt', async () => {
  const provider = zenProvider()
  const input = { messages: [
    { role: 'system', content: 'Keep this host instruction.', timestamp: 1, toolsAdded: [{ name: 'read', description: 'Read text.', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }] },
    { role: 'system', content: '', timestamp: 2, toolsRemoved: [{ name: 'read' }] },
    ...context.messages,
  ] }
  const before = structuredClone(input)
  for (const api of ['openai-responses', 'openai-completions']) {
    const model = provider.getModels().find(m => m.api === api)
    let body
    await provider.streamSimple(model, input, { apiKey: 'public', maxRetries: 0, fetch: async (_, init) => { body = JSON.parse(init.body); return refused() } }).result()
    assert.deepEqual(body.tools.map(t => (t.function ?? t).name).sort(), ['bash', 'read'])
    assert.ok(JSON.stringify(body).includes('Keep this host instruction.'))
    assert.equal(body.tool_choice, undefined)
  }
  assert.deepEqual(input, before)
})

test('tool-less anonymous requests keep admission declarations without an unsupported tool choice', async () => {
  const provider = zenProvider()
  for (const api of ['openai-responses', 'openai-completions']) {
    const model = provider.getModels().find(m => m.api === api)
    let body
    await provider.streamSimple(model, context, { apiKey: 'public', maxRetries: 0, fetch: async (_, init) => { body = JSON.parse(init.body); return refused() } }).result()
    const tools = body.tools.map(t => t.function ?? t)
    assert.equal(body.tool_choice, undefined)
    assert.ok(tools.every(t => Object.keys(t.parameters.properties).length > 0))
    assert.ok(tools.every(t => t.description.includes('Unavailable in this request')))
    assert.equal(tools.find(t => t.name === 'read').parameters.properties.filePath.type, 'string')
    assert.equal(tools.find(t => t.name === 'bash').parameters.properties.command.type, 'string')
  }
})

test('provider and availability requests use the current inference endpoint', async () => {
  const provider = zenProvider()
  for (const api of ['openai-responses', 'openai-completions']) {
    const model = provider.getModels().find(m => m.api === api)
    let target
    await provider.streamSimple(model, context, {
      apiKey: 'public', maxRetries: 0,
      fetch: async url => { target = String(url); return refused() },
    }).result()
    assert.equal(target, `${endpoint}/${api === 'openai-responses' ? 'responses' : 'chat/completions'}`)
  }
  let target
  const ids = await fetchZenModelIds(async url => {
    target = String(url)
    return Response.json({ data: [{ id: 'big-pickle' }] })
  })
  assert.equal(target, `${endpoint}/models`)
  assert.deepEqual(ids, ['big-pickle'])
})

test('fetch guard handles inference Request headers and leaves other requests untouched', async () => {
  const original = globalThis.fetch
  const seen = []
  globalThis.fetch = async (...args) => { seen.push(args); return refused() }
  const restore = patchGlobalFetchForZen(() => 'guard')
  try {
    for (const input of [endpoint, new URL(`${endpoint}/responses`), new Request(`${endpoint}/responses`, { headers: { authorization: 'Bearer fake-key', 'x-custom': 'retained' } })]) {
      await fetch(input)
      const headers = new Headers(seen.at(-1)[1].headers)
      assert.equal(headers.get('x-opencode-client'), 'cli')
      if (input instanceof Request) {
        assert.equal(headers.get('authorization'), 'Bearer fake-key')
        assert.equal(headers.get('x-custom'), 'retained')
      }
    }
    for (const url of ['https://opencode.ai/inference/v10/responses', 'https://opencode.ai/inference/v1-other', 'https://opencode.ai:444/inference/v1/responses', 'http://opencode.ai/inference/v1/responses', 'https://other.example/inference/v1/responses', 'https://opencode.ai/zen/v1/responses']) {
      const init = { headers: { 'x-custom': 'unchanged' } }
      await fetch(url, init)
      assert.equal(seen.at(-1)[0], url)
      assert.equal(seen.at(-1)[1], init)
    }
  } finally { restore(); globalThis.fetch = original }
})

test('Node HTTP guard targets only the exact HTTPS inference origin and path', () => {
  assert.equal(isZenNodeRequestOptions({ protocol: 'https:', hostname: 'opencode.ai', path: '/inference/v1/responses' }), true)
  assert.equal(isZenNodeRequestOptions({ host: 'opencode.ai:443', path: '/inference/v1?x=1' }), true)
  for (const options of [
    { protocol: 'http:', hostname: 'opencode.ai', path: '/inference/v1/responses' },
    { hostname: 'opencode.ai', port: 444, path: '/inference/v1/responses' },
    { hostname: 'opencode.ai', path: '/inference/v10/responses' },
    { hostname: 'opencode.ai', path: '/inference/v1-other' },
    { hostname: 'other.example', path: '/inference/v1/responses' },
  ]) assert.equal(isZenNodeRequestOptions(options), false)
})

test('warm catalogue rederives cached records with current identity and preserves dead verdicts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inference-cache-'))
  try {
    const path = join(dir, 'catalog.json')
    const free = (id, extra = {}) => ({ id, type: 'chat', cost: { text: { input: { price: 0 }, output: { price: 0 } } }, ...extra })
    await writeFile(path, JSON.stringify({ version: 2, fetchedAt: 100, models: [
      free('available', { baseUrl: 'https://opencode.ai/zen/v1' }),
      free('retired'),
    ], probes: { retired: { verdict: 'dead', at: 100, swept: true } }, lastProbeAt: 100 }))
    const catalog = createCatalog({ template: catalogTemplate(), cachePath: path, fetchImpl: async () => { throw new Error('offline') } })
    for (let i = 0; i < 100 && catalog.current().models.length === 0; i++) await new Promise(r => setTimeout(r, 5))
    assert.deepEqual(catalog.effectiveModels().map(m => m.id), ['available'])
    assert.equal(catalog.effectiveModels()[0].baseUrl, endpoint)
    assert.equal(catalog.current().probedAt, 100)
    assert.deepEqual(catalog.current().models.map(m => m.id), ['available', 'retired'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('fragmented admission tool names never reach the host as tool-call events', async () => {
  const provider = zenProvider()
  const model = provider.getModels().find(m => m.api === 'openai-completions')
  const chunks = [
    { tool_calls: [{ index: 0, id: 'call_probe', type: 'function', function: { name: '', arguments: '' } }] },
    { tool_calls: [{ index: 0, function: { name: 'read', arguments: '{"filePath":"private"}' } }] },
  ].map(delta => ({ id: 'test', choices: [{ index: 0, delta, finish_reason: null }] }))
  chunks.push({ id: 'test', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
  const observed = []
  const stream = provider.streamSimple(model, context, {
    apiKey: 'public', maxRetries: 0,
    fetch: async () => new Response(new ReadableStream({
      async start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`))
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        controller.close()
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } }),
  })
  await assert.rejects(async () => { for await (const event of stream) if (event.type.startsWith('toolcall_')) observed.push(event.type) }, /unavailable admission tool/)
  assert.deepEqual(observed, [])
})

test('explicit caller tool choices survive anonymous and keyed requests', async () => {
  for (const api of ['openai-responses', 'openai-completions']) {
    const provider = zenProvider()
    const model = provider.getModels().find(m => m.api === api)
    for (const apiKey of ['public', 'fixture-key']) for (const choice of ['none', 'auto', 'required']) {
      let body
      const options = { apiKey, maxRetries: 0,
        onPayload: payload => ({ ...payload, tool_choice: choice }),
        fetch: async (_, init) => { body = JSON.parse(init.body); return refused() },
      }
      await provider.streamSimple(model, context, options).result()
      assert.equal(body.tool_choice, choice)
      if (apiKey !== 'public') assert.ok(!body.tools?.length)
    }
  }
})

test('keyed probes do not inject anonymous admission tools', async () => {
  const provider = zenProvider()
  const model = provider.getModels().find(m => m.api === 'openai-completions')
  let body
  await probeModel(model, { provider, apiKey: 'fixture-key', fetchImpl: async (_, init) => {
    body = JSON.parse(init.body)
    return refused()
  } })
  assert.equal(body.tools, undefined)
})

const systemText = body => (body.messages ?? [])
  .filter(m => m.role === 'system' || m.role === 'developer')
  .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
  .join('\n')

test('anonymous requests carry the gate\'s environment block exactly once and keyed ones do not', async () => {
  const provider = zenProvider()
  const model = provider.getModels().find(m => m.api === 'openai-completions')
  const sent = async (ctx, apiKey) => {
    let body
    await provider.streamSimple(model, ctx, {
      apiKey, maxRetries: 0,
      fetch: async (_url, init) => { body = JSON.parse(init.body); return refused() },
    }).result()
    return systemText(body)
  }
  const user = { role: 'user', content: 'OK', timestamp: 1 }
  const count = text => text.split('Working directory:').length - 1

  const plain = await sent({ systemPrompt: 'Be brief.', messages: [user] }, 'public')
  assert.match(plain, /Be brief\./)
  assert.match(plain, /<env>\s+Working directory: [^\n]+\s+<\/env>/)
  assert.equal(count(plain), 1)
  assert.doesNotMatch(plain, /\/(Users|home)\//, 'the host path is not disclosed')

  const own = '<env>\n  Working directory: /srv/app\n</env>'
  const kept = await sent({ systemPrompt: `Be brief.\n${own}`, messages: [user] }, 'public')
  assert.equal(count(kept), 1)
  assert.match(kept, /\/srv\/app/)

  assert.equal(count(await sent({ messages: [user] }, 'public')), 1)
  assert.equal(count(await sent({ systemPrompt: 'Be brief.', messages: [user] }, 'sk-real-key')), 0)
})

test('Zen transport offers the official cipher suites, in the official order', async () => {
  let hello
  const server = net.createServer(socket => {
    socket.once('data', data => { hello = data; socket.destroy() })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await assert.rejects(zenHttpsFetch(`https://127.0.0.1:${server.address().port}/inference/v1/models`), /fetch failed/)
  } finally { await new Promise(resolve => server.close(resolve)) }
  // record header 5 + handshake header 4 + version 2 + random 32, then session id and cipher list
  let at = 5 + 4 + 2 + 32
  at += 1 + hello[at]
  const length = hello.readUInt16BE(at)
  const offered = []
  for (let i = 0; i < length; i += 2) {
    const id = hello.readUInt16BE(at + 2 + i)
    // GREASE values vary per connection; OpenSSL 3.0 (Node 22) appends the renegotiation SCSV, which is not a cipher suite
    if ((id & 0x0f0f) !== 0x0a0a && id !== 0x00ff) offered.push(id)
  }
  assert.deepEqual(offered, [0x1301, 0x1302, 0x1303, 0xc02b, 0xc02f, 0xc02c, 0xc030, 0xcca9, 0xcca8, 0xc009, 0xc013, 0xc00a, 0xc014, 0x9c, 0x9d, 0x2f, 0x35])
  assert.equal(OPENCODE_TLS_CIPHERS.split(':').length, 17)
})

test('fetch guard sends Zen requests through the given transport and other hosts through fetch', async () => {
  const original = globalThis.fetch
  const slot = '__dshOpenCodeFreeFetchOriginal' // the guard pins the first fetch it sees
  const pinned = globalThis[slot]
  delete globalThis[slot]
  const viaFetch = [], viaTransport = []
  globalThis.fetch = async (...args) => { viaFetch.push(String(args[0])); return refused() }
  const restore = patchGlobalFetchForZen(() => 'guard', async (url, init) => {
    viaTransport.push([String(url), new Headers(init.headers).get('x-opencode-client')])
    return refused()
  })
  try {
    await fetch(`${endpoint}/chat/completions`)
    await fetch('https://other.example/x')
    assert.deepEqual(viaTransport, [[`${endpoint}/chat/completions`, 'cli']])
    assert.deepEqual(viaFetch, ['https://other.example/x'])
  } finally { restore(); globalThis.fetch = original; globalThis[slot] = pinned }
})

test('anonymous requests alias gate-refused host tool names and restore them on returned calls', async () => {
  const provider = zenProvider()
  const model = provider.getModels().find(m => m.api === 'openai-completions')
  const schema = { type: 'object', properties: { cd: { type: 'string' } } }
  const tools = ['read', 'bash', 'subagent_fork', 'working_directory'].map(name => ({ name, description: 'A host tool.', parameters: name === 'bash' ? { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } : schema }))
  const history = { messages: [
    { role: 'user', content: 'go', timestamp: 1 },
    { role: 'assistant', api: model.api, provider: model.provider, model: model.id, stopReason: 'toolUse', timestamp: 2, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, content: [{ type: 'toolCall', id: 'call_1', name: 'working_directory', arguments: {} }] },
    { role: 'toolResult', toolCallId: 'call_1', toolName: 'working_directory', content: [{ type: 'text', text: '/work' }], isError: false, timestamp: 3 },
  ], tools }
  const sse = (name) => new Response([
    { id: 't', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_2', type: 'function', function: { name, arguments: '{}' } }] }, finish_reason: null }] },
    { id: 't', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
  let anonymous, keyed
  const result = await provider.streamSimple(model, history, { apiKey: 'public', maxRetries: 0, fetch: async (_, init) => { anonymous = JSON.parse(init.body); return sse('agent_fork') } }).result()
  await provider.streamSimple(model, history, { apiKey: 'sk-real-key', maxRetries: 0, fetch: async (_, init) => { keyed = JSON.parse(init.body); return refused() } }).result()
  const names = body => body.tools.map(t => t.function.name)
  assert.deepEqual(names(anonymous), ['read', 'bash', 'agent_fork', 'cwd_tool'])
  assert.doesNotMatch(JSON.stringify(anonymous), /subagent_fork|working_directory/)
  assert.ok(JSON.stringify(anonymous.messages).includes('cwd_tool'))
  assert.deepEqual(names(keyed), ['read', 'bash', 'subagent_fork', 'working_directory'])
  assert.deepEqual(result.content.filter(c => c.type === 'toolCall').map(c => c.name), ['subagent_fork'])
})
