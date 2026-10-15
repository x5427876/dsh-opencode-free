import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCatalog } from '../src/catalog.ts'
import {
  catalogTemplate,
  fetchZenModelIds,
  isZenNodeRequestOptions,
  patchGlobalFetchForZen,
  sessionHeader,
  zenProvider,
} from '../src/zen-provider.ts'

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
    assert.equal(body.tool_choice, 'none')
  }
  assert.deepEqual(input, before)
})

test('tool-less anonymous requests declare substantive tools but disable execution', async () => {
  const provider = zenProvider()
  for (const api of ['openai-responses', 'openai-completions']) {
    const model = provider.getModels().find(m => m.api === api)
    let body
    await provider.streamSimple(model, context, { apiKey: 'public', maxRetries: 0, fetch: async (_, init) => { body = JSON.parse(init.body); return refused() } }).result()
    const tools = body.tools.map(t => t.function ?? t)
    assert.equal(body.tool_choice, 'none')
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
    await writeFile(path, JSON.stringify({ version: 1, fetchedAt: 100, models: {
      available: { id: 'available', cost: { input: 0, output: 0 }, baseUrl: 'https://opencode.ai/zen/v1' },
      retired: { id: 'retired', cost: { input: 0, output: 0 } },
    }, probes: { retired: { verdict: 'dead', at: 100, swept: true } }, lastProbeAt: 100 }))
    const catalog = createCatalog({ template: catalogTemplate(), builtinBaseline: [], cachePath: path, fetchImpl: async () => { throw new Error('offline') } })
    for (let i = 0; i < 100 && catalog.current().models.length === 0; i++) await new Promise(r => setTimeout(r, 5))
    assert.deepEqual(catalog.effectiveModels().map(m => m.id), ['available'])
    assert.equal(catalog.effectiveModels()[0].baseUrl, endpoint)
    assert.equal(catalog.current().probedAt, 100)
    assert.deepEqual(catalog.current().models.map(m => m.id), ['available', 'retired'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})
