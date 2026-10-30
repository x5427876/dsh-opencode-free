import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCompat } from '../scripts/compat-core.mjs'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const PIN = pkg.peerDependencies['@deepseek-ai/dsh-llm']

/**
 * Fake world for one compat run. Every dependency is in memory: no DSH, no
 * Zen, no real waiting. `replies` maps a model id to the queue
 * of driver outputs it answers with, in order; the last entry repeats.
 */
function world({
  replies = {},
  zenIds = ['alpha-free', 'beta-free'],
  efforts = {},
  env = {},
} = {}) {
  const calls = []
  const sleeps = []
  const writes = []
  const queues = new Map(Object.entries(replies).map(([id, list]) => [id, [...list]]))
  const deps = {
    pkg: {
      version: '9.9.9',
      peerDependencies: { '@deepseek-ai/dsh-llm': PIN, '@deepseek-ai/dsh-llm-pi-ai': PIN },
    },
    env,
    platform: 'linux',
    osLabel: 'linux 6.0 x64',
    now: () => new Date('2026-10-03T00:00:00.000Z'),
    tmpDir: '/tmp/compat-xyz',
    catalogue: async () => ({
      zenIds,
      targets: zenIds.map(id => ({ id, api: 'openai-completions', efforts: efforts[id] })),
      selection: { sources: [], excluded: [], unresolved: [] },
    }),
    driver: {
      setup: async () => {
        calls.push({ kind: 'setup' })
      },
      warmup: async (request) => {
        calls.push({ kind: 'warmup', ...request })
        return { visible: [...zenIds], probe: { results: Object.fromEntries(zenIds.map(id => [id, { status: 'ok' }])) } }
      },
      run: async (request) => {
        calls.push({ kind: 'run', ...request })
        const queue = queues.get(request.model) ?? [ok()]
        const next = queue.length > 1 ? queue.shift() : queue[0]
        return typeof next === 'function' ? next(request) : next
      },
      dispose: async () => {
        calls.push({ kind: 'dispose' })
      },
    },
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    writeFile: async (path, text) => {
      writes.push({ path, text })
    },
  }
  return { deps, calls, sleeps, writes, runs: () => calls.filter((call) => call.kind === 'run') }
}

/** One official model-list entry; free and chat-completions by default. */
function official(id, { price = 0, type = 'chat', api, effort, cost } = {}) {
  return {
    id,
    type,
    created: 1793344437,
    cost: cost ?? { text: { input: { price, cache: { read: 0, write: 0 } }, output: { price } } },
    api: api ?? { 'chat-completions': { base_url: 'https://opencode.ai/inference/openai/v1' } },
    capabilities: { reasoning: { supported: true, ...(effort === undefined ? {} : { effort }) } },
  }
}
function ok(stdout = 'OK\n') {
  return { stdout, stderr: '', exitCode: 0 }
}
function failed(stderr) {
  return { stdout: '', stderr, exitCode: 1 }
}

test('a missing DSH version is refused before anything runs', async () => {
  const { deps, calls } = world()
  await assert.rejects(runCompat({}, deps), /--dsh/)
  assert.deepEqual(calls, [])
})

test('a DSH version the peer pin does not name stops before installing or spending quota', async () => {
  const { deps, calls } = world()
  await assert.rejects(runCompat({ dsh: '0.2.0-rc.2' }, deps), (error) => {
    assert.match(error.message, /0\.2\.0-rc\.2/)
    assert.ok(error.message.includes(PIN))
    return true
  })
  assert.deepEqual(calls, [])
})

test('every model that answers with text is ok, the header says what was run, and the exit code is 0', async () => {
  const { deps } = world()
  const { report, exitCode } = await runCompat({ dsh: PIN }, deps)
  assert.equal(exitCode, 0)
  assert.deepEqual(report.header, {
    dshVersion: PIN,
    pluginVersion: '9.9.9',
    date: '2026-10-03T00:00:00.000Z',
    os: 'linux 6.0 x64',
    keyed: false,
    tools: false,
    path: report.header.path,
  })
  assert.match(report.header.path, /headless/)
  assert.match(report.header.path, /not .*web/i)
  assert.deepEqual(
    report.models.map((m) => [m.id, m.verdict, m.layer]),
    [
      ['alpha-free', 'ok', 'L1'],
      ['beta-free', 'ok', 'L1'],
    ],
  )
})

for (const [label, output] of [
  ['an empty reply', ok('   \n')],
  ['a plugin that never loaded', failed('dsh: UNKNOWN_MODEL: pi-ai provider "opencode-zen-free" has no configured model "beta-free"')],
  ['NO_ADAPTER', failed('dsh: NO_ADAPTER: no adapter registered for provider "opencode-zen-free"')],
]) {
  test(`${label} is a plugin-fault and makes the exit code 1`, async () => {
    const { deps } = world({ replies: { 'beta-free': [output] } })
    const { report, exitCode } = await runCompat({ dsh: PIN }, deps)
    const beta = report.models.find((m) => m.id === 'beta-free')
    assert.equal(beta.verdict, 'plugin-fault')
    assert.notEqual(beta.reason, '')
    assert.equal(exitCode, 1)
  })
}

const RATE_LIMITED = failed('dsh: RATE_LIMIT: 免費額度用完。等視窗重置。（上游 HTTP 429）')
const GATED = failed('dsh: PROVIDER_ERROR: 上游拒絕免費層請求。（上游 HTTP 403）')

for (const [label, output, verdict] of [
  ['a 429', RATE_LIMITED, 'rate-limited'],
  ['a gate 403', GATED, 'gate-refused'],
  ['Endpoint is unavailable', failed('dsh: PROVIDER_ERROR: 400 Upstream request failed: Endpoint is unavailable'), 'upstream-down'],
  ['Model is unavailable', failed('dsh: PROVIDER_ERROR: Model is unavailable'), 'upstream-down'],
  ['an upstream 500', failed('dsh: PROVIDER_ERROR: 未知的上游錯誤。（上游 HTTP 500）'), 'upstream-down'],
]) {
  test(`${label} is classified ${verdict}`, async () => {
    const { deps } = world({ replies: { 'alpha-free': [output] } })
    const { report } = await runCompat({ dsh: PIN }, deps)
    const alpha = report.models.find((m) => m.id === 'alpha-free')
    assert.equal(alpha.verdict, verdict)
    assert.equal(alpha.layer, 'L0')
    assert.notEqual(alpha.reason, '')
  })
}

test('upstream-down and gate-refused are incomplete and exit 2', async () => {
  const { deps } = world({
    replies: { 'alpha-free': [GATED], 'beta-free': [failed('dsh: PROVIDER_ERROR: Endpoint is unavailable')] },
  })
  const { report, exitCode } = await runCompat({ dsh: PIN }, deps)
  assert.deepEqual(report.models.map((m) => m.verdict), ['gate-refused', 'upstream-down'])
  assert.equal(exitCode, 2)
})

test('a 429 backs off 30s and is ok when the retry answers', async () => {
  const { deps, sleeps, runs } = world({ replies: { 'alpha-free': [RATE_LIMITED, ok()] } })
  const { report, exitCode } = await runCompat({ dsh: PIN }, deps)
  assert.equal(report.models[0].verdict, 'ok')
  assert.deepEqual(sleeps, [30_000, 3_000])
  assert.equal(runs().filter((r) => r.model === 'alpha-free').length, 2)
  assert.equal(exitCode, 0)
})

test('still 429 after backing off 30s then 60s is rate-limited, and the exit code is 2', async () => {
  const { deps, sleeps, runs } = world({ replies: { 'alpha-free': [RATE_LIMITED] } })
  const { report, exitCode } = await runCompat({ dsh: PIN }, deps)
  assert.equal(report.models[0].verdict, 'rate-limited')
  assert.deepEqual(sleeps, [30_000, 60_000, 3_000])
  assert.equal(runs().filter((r) => r.model === 'alpha-free').length, 3)
  assert.equal(exitCode, 2)
})

test('models are spaced 3s apart', async () => {
  const ids = ['a-free', 'b-free', 'c-free']
  const { deps, sleeps } = world({ zenIds: ids })
  await runCompat({ dsh: PIN }, deps)
  assert.deepEqual(sleeps, [3_000, 3_000])
})

test('three rate-limited models in a row end the run and the rest are listed as unverified', async () => {
  const ids = ['a-free', 'b-free', 'c-free', 'd-free', 'e-free']
  const { deps, runs } = world({
    zenIds: ids,
    replies: { 'a-free': [RATE_LIMITED], 'b-free': [RATE_LIMITED], 'c-free': [RATE_LIMITED] },
  })
  const { report, exitCode } = await runCompat({ dsh: PIN }, deps)
  assert.deepEqual(report.models.map((m) => m.verdict), [
    'rate-limited',
    'rate-limited',
    'rate-limited',
    'unverified',
    'unverified',
  ])
  assert.deepEqual(report.unverified, ['d-free', 'e-free'])
  assert.equal(runs().some((r) => r.model === 'd-free' || r.model === 'e-free'), false)
  assert.equal(exitCode, 2)
})

test('an answer between rate-limited models resets the streak', async () => {
  const ids = ['a-free', 'b-free', 'c-free', 'd-free']
  const { deps } = world({
    zenIds: ids,
    replies: { 'a-free': [RATE_LIMITED], 'b-free': [RATE_LIMITED], 'd-free': [RATE_LIMITED] },
  })
  const { report } = await runCompat({ dsh: PIN }, deps)
  assert.deepEqual(report.models.map((m) => m.verdict), ['rate-limited', 'rate-limited', 'ok', 'rate-limited'])
  assert.deepEqual(report.unverified, [])
})

test('a plugin-fault outranks an unfinished run: exit 1, not 2', async () => {
  const { deps } = world({
    replies: { 'alpha-free': [RATE_LIMITED], 'beta-free': [ok('')] },
  })
  const { report, exitCode } = await runCompat({ dsh: PIN }, deps)
  assert.deepEqual(report.models.map((m) => m.verdict), ['rate-limited', 'plugin-fault'])
  assert.equal(exitCode, 1)
})

test('the models verified are the free chat entries of the official list, and the report names the snapshot', async () => {
  const { fetchCompatCatalogue } = await import('../scripts/compat-catalogue.mjs')
  const { deps, runs } = world()
  deps.catalogue = () => fetchCompatCatalogue({ fetchImpl: async url => {
    if (String(url).endsWith('/models')) return Response.json({ data: [official('alpha-free'), official('paid-model', { price: 2 }), official('image-free', { type: 'image' }), official('new-free')] })
    return new Response('', { status: 503 })
  }, now: () => new Date('2026-10-15T00:00:00Z') })
  deps.driver.warmup = async () => ({ visible: ['alpha-free', 'new-free'], probe: { results: { 'alpha-free': { status: 'ok' }, 'new-free': { status: 'ok' } } } })
  const { report, text } = await runCompat({ dsh: PIN }, deps)
  assert.deepEqual(report.models.map((m) => m.id), ['alpha-free', 'new-free'])
  assert.deepEqual([...new Set(runs().map((r) => r.model))], ['alpha-free', 'new-free'])
  assert.deepEqual(report.catalogue.excluded.map((row) => [row.id, row.reason]), [['paid-model', 'paid'], ['image-free', 'non-conversational']])
  assert.deepEqual(report.catalogue.snapshot.free, ['alpha-free', 'new-free'])
  assert.equal(report.catalogue.snapshot.total, 4)
  assert.match(report.catalogue.snapshot.digest, /^[0-9a-f]{64}$/)
  assert.match(text, /Official list: 4 entries, 2 free/)
})

test('the snapshot digest names the free set and ignores volatile fields', async () => {
  const { fetchCompatCatalogue } = await import('../scripts/compat-catalogue.mjs')
  const fetchWith = created => fetchCompatCatalogue({ fetchImpl: async url => String(url).endsWith('/models')
    ? Response.json({ data: [{ ...official('alpha-free'), created }, official('paid-model', { price: 1 })] })
    : new Response('', { status: 503 }) })
  const first = await fetchWith(1)
  const second = await fetchWith(2)
  assert.equal(first.selection.snapshot.digest, second.selection.snapshot.digest)
})

test('each model is asked at its lowest published effort; a model without levels uses the default and says so', async () => {
  const { deps, runs } = world({
    zenIds: ['effort-free', 'none-free', 'bare-free'],
    efforts: { 'effort-free': ['high', 'low', 'max'], 'none-free': ['none'] },
  })
  const { report } = await runCompat({ dsh: PIN }, deps)
  assert.deepEqual(runs().map((r) => [r.model, r.effort]), [
    ['effort-free', 'low'],
    ['none-free', undefined],
    ['bare-free', undefined],
  ])
  assert.deepEqual(report.models.map((m) => [m.id, m.effort, m.effortNote]), [
    ['effort-free', 'low', ''],
    ['none-free', null, 'no published levels (無等級可選)'],
    ['bare-free', null, 'no published levels (無等級可選)'],
  ])
})

test('a live catalogue that cannot be fetched stops the run and says so instead of falling back to the builtin list', async () => {
  const { deps, calls } = world()
  deps.catalogue = async () => {
    throw new Error('official model list unavailable')
  }
  const { report, exitCode } = await runCompat({ dsh: PIN }, deps)
  assert.match(report.catalogue.error, /official model list unavailable/)
  assert.deepEqual(report.models, [])
  assert.deepEqual(calls, [])
  assert.equal(exitCode, 2)
})

test('the warmup runs once, before any model, and no model run repeats it', async () => {
  const ids = ['a-free', 'b-free', 'c-free']
  const { deps, calls } = world({ zenIds: ids })
  await runCompat({ dsh: PIN }, deps)
  assert.deepEqual(calls.map((c) => (c.kind === 'run' ? `run:${c.model}` : c.kind)), [
    'setup',
    'warmup',
    'run:a-free',
    'run:b-free',
    'run:c-free',
    'dispose',
  ])
})

test('the warmup round becomes each model\'s L0', async () => {
  const { deps } = world()
  deps.driver.warmup = async () => ({
    visible: ['alpha-free', 'beta-free'],
    probe: { results: { 'alpha-free': { status: 'ok', ms: 900 }, 'beta-free': { status: 'failed', code: 'quota-exhausted', http: 429, ms: 200 } } },
  })
  const { report } = await runCompat({ dsh: PIN }, deps)
  assert.equal(report.warmup.ok, true)
  assert.deepEqual(report.models.map((m) => [m.id, m.l0.inPicker, m.l0.probe]), [
    ['alpha-free', true, 'ok'],
    ['beta-free', true, 'failed: quota-exhausted (HTTP 429)'],
  ])
})

test('a live model missing from the picker fails L0 and is not asked; a probe-dead one is upstream-down', async () => {
  const ids = ['shown-free', 'dead-free', 'lost-free']
  const { deps, runs } = world({ zenIds: ids })
  deps.driver.warmup = async () => ({
    visible: ['shown-free'],
    probe: { results: { 'shown-free': { status: 'ok' }, 'dead-free': { status: 'failed', code: 'dead', http: 404, ms: 300 } } },
  })
  const { report, exitCode } = await runCompat({ dsh: PIN }, deps)
  assert.deepEqual(report.models.map((m) => [m.id, m.verdict, m.layer, m.l0.inPicker]), [
    ['shown-free', 'ok', 'L1', true],
    ['dead-free', 'upstream-down', null, false],
    ['lost-free', 'plugin-fault', null, false],
  ])
  assert.deepEqual(runs().map((r) => r.model), ['shown-free'])
  assert.equal(exitCode, 1)
})

test('a failed warmup is reported, verifies nothing and fails the run', async () => {
  const { deps, runs, calls } = world()
  deps.driver.warmup = async () => {
    throw new Error('catalogue route never answered within 60s')
  }
  const { report, exitCode } = await runCompat({ dsh: PIN }, deps)
  assert.equal(report.warmup.ok, false)
  assert.match(report.warmup.error, /never answered/)
  assert.deepEqual(report.models.map((m) => m.verdict), ['unverified', 'unverified'])
  assert.equal(runs().length, 0)
  assert.equal(calls.at(-1).kind, 'dispose')
  assert.equal(exitCode, 1)
})

test('a failed setup is reported like a failed warmup', async () => {
  const { deps, calls } = world()
  deps.driver.setup = async () => {
    throw new Error('pnpm add exited with code 1')
  }
  const { report, exitCode } = await runCompat({ dsh: PIN }, deps)
  assert.equal(report.warmup.ok, false)
  assert.match(report.warmup.error, /^setup: pnpm add/)
  assert.equal(calls.some((c) => c.kind === 'run' || c.kind === 'warmup'), false)
  assert.equal(exitCode, 1)
})

test('without --out only the JSON is written, and only under the temp directory', async () => {
  const { deps, writes } = world()
  const { files } = await runCompat({ dsh: PIN }, deps)
  assert.equal(writes.length, 1)
  assert.ok(writes[0].path.replaceAll('\\', '/').startsWith('/tmp/compat-xyz/'))
  assert.ok(writes[0].path.endsWith('.json'))
  assert.deepEqual(files, [writes[0].path])
})

test('--out writes the matrix and the JSON into the given directory', async () => {
  const { deps, writes } = world()
  await runCompat({ dsh: PIN, out: 'docs/compat' }, deps)
  const paths = writes.map((w) => w.path.replaceAll('\\', '/'))
  assert.equal(paths.filter((p) => p.startsWith('docs/compat/')).length, 2)
  assert.ok(paths.some((p) => p.startsWith('docs/compat/') && p.endsWith('.md')))
  assert.ok(paths.some((p) => p.startsWith('docs/compat/') && p.endsWith('.json')))
})

test('the JSON parses back to the report and the matrix carries the same header and rows', async () => {
  const ids = ['ok-free', 'down-free', 'a-free', 'b-free', 'c-free', 'late-free']
  const { deps, writes } = world({
    zenIds: ids,
    efforts: { 'ok-free': ['low'] },
    replies: {
      'down-free': [failed('dsh: PROVIDER_ERROR: Endpoint is unavailable')],
      'a-free': [RATE_LIMITED],
      'b-free': [RATE_LIMITED],
      'c-free': [RATE_LIMITED],
    },
  })
  const { report, text } = await runCompat({ dsh: PIN, out: 'out' }, deps)
  const json = JSON.parse(writes.find((w) => w.path.endsWith('.json')).text)
  assert.deepEqual(json, report)
  const md = writes.find((w) => w.path.endsWith('.md')).text
  assert.equal(md, text)
  for (const value of [PIN, '9.9.9', '2026-10-03T00:00:00.000Z', 'linux 6.0 x64', report.header.path]) {
    assert.ok(md.includes(value), `matrix is missing ${value}`)
  }
  assert.match(md, /key: no/i)
  for (const model of report.models) {
    const row = md.split('\n').find((line) => line.startsWith(`| ${model.id} |`))
    assert.ok(row, `no matrix row for ${model.id}`)
    assert.ok(row.includes(model.verdict))
    if (model.layer !== null) assert.ok(row.includes(model.layer))
    if (model.reason !== '') assert.ok(row.includes(model.reason.slice(0, 20)))
  }
  assert.match(md.split('\n').find((line) => line.startsWith('| ok-free |')), /\| low \|/)
  assert.match(md, /Unverified: late-free/)
  assert.match(md, /exit code 2/i)
})

const FAKE_KEY = 'sk-zen-fake-1234567890abcdef'
const KEY_IDS = ['ok-free', 'limited-free', 'gated-free', 'down-free']
const KEY_REPLIES = {
  'limited-free': [RATE_LIMITED],
  'gated-free': [GATED],
  'down-free': [failed('dsh: PROVIDER_ERROR: Endpoint is unavailable')],
}

test('without a key nothing is re-run with one', async () => {
  const { deps, runs } = world({ zenIds: KEY_IDS, replies: KEY_REPLIES })
  const { report } = await runCompat({ dsh: PIN }, deps)
  assert.equal(report.header.keyed, false)
  assert.equal(runs().some((r) => r.apiKey !== undefined), false)
  assert.equal(report.models.some((m) => m.keyed !== null), false)
})

test('with a key only rate-limited and gate-refused models are re-run once, beside the anonymous verdict', async () => {
  const keyedReply = (request) => (request.apiKey === FAKE_KEY ? ok() : request.model === 'gated-free' ? GATED : RATE_LIMITED)
  const { deps, runs } = world({
    zenIds: KEY_IDS,
    env: { OPENCODE_API_KEY: FAKE_KEY },
    replies: { ...KEY_REPLIES, 'limited-free': [keyedReply], 'gated-free': [keyedReply] },
  })
  const { report, exitCode } = await runCompat({ dsh: PIN }, deps)
  assert.equal(report.header.keyed, true)
  assert.deepEqual(
    runs().filter((r) => r.apiKey !== undefined).map((r) => [r.model, r.apiKey === FAKE_KEY]),
    [
      ['limited-free', true],
      ['gated-free', true],
    ],
  )
  assert.deepEqual(report.models.map((m) => [m.id, m.verdict, m.keyed?.verdict ?? null]), [
    ['ok-free', 'ok', null],
    ['limited-free', 'rate-limited', 'ok'],
    ['gated-free', 'gate-refused', 'ok'],
    ['down-free', 'upstream-down', null],
  ])
  // A keyed answer does not make the anonymous run finished.
  assert.equal(exitCode, 2)
})

test('compat reports retain failure signals but never echo conversation or tool arguments', async () => {
  const sensitive = 'private-conversation-and-tool-command'
  const { deps, writes } = world({ replies: { 'alpha-free': [failed(`dsh: PROVIDER_ERROR: ${sensitive} Bearer public (HTTP 403) FreeTierError`)] } })
  const { report, text } = await runCompat({ dsh: PIN, out: 'out' }, deps)
  assert.equal(report.models[0].verdict, 'gate-refused')
  assert.match(report.models[0].reason, /PROVIDER_ERROR.*HTTP 403/)
  assert.doesNotMatch(JSON.stringify(report) + text + JSON.stringify(writes), new RegExp(`${sensitive}|Bearer public`))
})

test('the key never reaches the report, the JSON or the matrix, even when upstream echoes it', async () => {
  const echo = failed(`dsh: AUTH_FAILED: Zen key 無效 Bearer ${FAKE_KEY} rejected（上游 HTTP 401）`)
  const { deps, writes } = world({
    zenIds: KEY_IDS,
    env: { OPENCODE_API_KEY: FAKE_KEY },
    replies: {
      ...KEY_REPLIES,
      'ok-free': [failed(`dsh: PROVIDER_ERROR: request ${FAKE_KEY} failed`)],
      'gated-free': [(request) => (request.apiKey === undefined ? GATED : echo)],
    },
  })
  const { report, text } = await runCompat({ dsh: PIN, out: 'out' }, deps)
  const everything = [JSON.stringify(report), text, ...writes.map((w) => w.text)].join('\n')
  assert.equal(everything.includes(FAKE_KEY), false)
  assert.equal(everything.includes(FAKE_KEY.slice(0, 12)), false)
  assert.equal(report.models.find((m) => m.id === 'gated-free').keyed.verdict, 'gate-refused')
})

/** A model that really uses its tools: it reads the nonce file and runs the hash command. */
function toolUser({ read = true, shell = true } = {}) {
  return (request) => {
    const files = request.files ?? {}
    const reply = (tool, input, value) => ({ stdout: [
      { type: 'tool_call', callId: 'owned-call', tool, input },
      { type: 'tool_result', callId: 'owned-call', status: 'completed', result: value },
      { type: 'final', text: value },
    ].map(row => JSON.stringify(row)).join('\n') + '\n', stderr: '', exitCode: 0, format: 'headless-json' })
    if (files['compat-read.txt'] !== undefined) return reply('read', { file_path: 'compat-read.txt' }, read ? `${files['compat-read.txt']}\n` : 'I read it: 0000\n')
    if (files['compat-shell.txt'] !== undefined) {
      const hash = createHash('sha256').update(files['compat-shell.txt']).digest('hex').slice(0, 16).toUpperCase()
      return reply(request.task.includes('Use the pwsh tool') ? 'pwsh' : 'bash', { command: request.task.split('only: ')[1], description: 'Compute the test file hash' }, shell ? `${hash}\n` : 'DEADBEEFDEADBEEF\n')
    }
    return ok()
  }
}

test('without --tools no tool round-trip is run', async () => {
  const { deps, runs } = world()
  const { report } = await runCompat({ dsh: PIN }, deps)
  assert.equal(runs().some((r) => r.files !== undefined), false)
  assert.equal(report.models.every((m) => m.tools === null), true)
})

test('--tools passes L2 only when the read and shell replies carry this run\'s nonce', async () => {
  const { deps, runs } = world({ replies: { 'alpha-free': [toolUser()], 'beta-free': [toolUser()] } })
  const { report, exitCode } = await runCompat({ dsh: PIN, tools: true }, deps)
  assert.equal(report.header.tools, true)
  assert.deepEqual(report.models.map((m) => [m.id, m.verdict, m.layer, m.tools.read.pass, m.tools.shell.pass]), [
    ['alpha-free', 'ok', 'L2', true, true],
    ['beta-free', 'ok', 'L2', true, true],
  ])
  const nonces = runs().flatMap((r) => Object.values(r.files ?? {}))
  assert.equal(new Set(nonces).size, nonces.length, 'every step gets its own nonce')
  assert.equal(exitCode, 0)
})

test('a made-up answer does not pass, and the report names the step that failed', async () => {
  const { deps } = world({
    replies: { 'alpha-free': [toolUser({ read: false })], 'beta-free': [toolUser({ shell: false })] },
  })
  const { report, exitCode } = await runCompat({ dsh: PIN, tools: true }, deps)
  const [alpha, beta] = report.models
  assert.deepEqual([alpha.verdict, alpha.layer, alpha.tools.read.pass, alpha.tools.shell.pass], ['plugin-fault', 'L1', false, true])
  assert.match(alpha.reason, /^read step/)
  assert.deepEqual([beta.verdict, beta.layer, beta.tools.read.pass, beta.tools.shell.pass], ['plugin-fault', 'L1', true, false])
  assert.match(beta.reason, /^shell step \(bash\)/)
  assert.equal(exitCode, 1)
})

test('nonces differ between runs', async () => {
  const first = world({ replies: { 'alpha-free': [toolUser()], 'beta-free': [toolUser()] } })
  const second = world({ replies: { 'alpha-free': [toolUser()], 'beta-free': [toolUser()] } })
  await runCompat({ dsh: PIN, tools: true }, first.deps)
  await runCompat({ dsh: PIN, tools: true }, second.deps)
  const nonces = (w) => w.runs().flatMap((r) => Object.values(r.files ?? {}))
  assert.equal(nonces(first).some((n) => nonces(second).includes(n)), false)
})

test('the shell step asks for pwsh on Windows and bash elsewhere', async () => {
  for (const [platform, tool, command] of [
    ['win32', 'pwsh', /Get-FileHash/],
    ['darwin', 'bash', /sha256sum|shasum/],
  ]) {
    const { deps, runs } = world({ replies: { 'alpha-free': [toolUser()], 'beta-free': [toolUser()] } })
    deps.platform = platform
    const { report } = await runCompat({ dsh: PIN, tools: true }, deps)
    const shellRun = runs().find((r) => r.files?.['compat-shell.txt'] !== undefined)
    assert.match(shellRun.task, new RegExp(`\\b${tool}\\b`))
    assert.match(shellRun.task, command)
    assert.equal(shellRun.task.includes(shellRun.files['compat-shell.txt']), false, 'the nonce is never in the prompt')
    assert.equal(report.models[0].tools.shell.tool, tool)
  }
})

test('a tool step that stays 429 is rate-limited, not a plugin-fault', async () => {
  const limitedShell = (request) =>
    request.files?.['compat-shell.txt'] !== undefined ? RATE_LIMITED : toolUser()(request)
  const { deps, sleeps } = world({ replies: { 'alpha-free': [limitedShell], 'beta-free': [toolUser()] } })
  const { report, exitCode } = await runCompat({ dsh: PIN, tools: true }, deps)
  const alpha = report.models[0]
  assert.deepEqual([alpha.verdict, alpha.layer, alpha.tools.read.pass, alpha.tools.shell.pass], ['rate-limited', 'L1', true, false])
  assert.ok(sleeps.includes(30_000) && sleeps.includes(60_000))
  assert.equal(exitCode, 2)
})

test('the matrix shows each tool step on its own', async () => {
  const { deps } = world({ replies: { 'alpha-free': [toolUser({ shell: false })], 'beta-free': [toolUser()] } })
  const { text } = await runCompat({ dsh: PIN, tools: true }, deps)
  assert.match(text.split('\n').find((l) => l.startsWith('| alpha-free |')), /read pass, bash FAIL/)
  assert.match(text.split('\n').find((l) => l.startsWith('| beta-free |')), /read pass, bash pass/)
})

test('a run the driver had to kill for hanging is a plugin-fault that says so', async () => {
  const { deps } = world({ replies: { 'alpha-free': [{ stdout: '', stderr: '', exitCode: null, timedOut: true }] } })
  const { report } = await runCompat({ dsh: PIN }, deps)
  assert.equal(report.models[0].verdict, 'plugin-fault')
  assert.match(report.models[0].reason, /no answer within the driver timeout/)
})

test('models the warmup round saw answer are asked first, so a run of 429s cannot hide them', async () => {
  const ids = ['a-free', 'b-free', 'c-free', 'd-free', 'e-free']
  const limited = failed('dsh: RATE_LIMIT: 免費額度用完。（上游 HTTP 429）')
  const { deps, runs } = world({
    zenIds: ids,
    replies: { 'a-free': [limited], 'b-free': [limited], 'c-free': [limited] },
  })
  const quota = { status: 'failed', code: 'quota-exhausted', http: 429, ms: 200 }
  deps.driver.warmup = async () => ({
    visible: ids,
    probe: {
      results: { 'a-free': quota, 'b-free': quota, 'c-free': quota, 'd-free': { status: 'ok', ms: 1 }, 'e-free': { status: 'ok', ms: 1 } },
    },
  })
  const { report } = await runCompat({ dsh: PIN }, deps)
  assert.deepEqual([...new Set(runs().map((r) => r.model))], ['d-free', 'e-free', 'a-free', 'b-free', 'c-free'])
  assert.deepEqual(report.models.map((m) => [m.id, m.verdict]), [
    ['d-free', 'ok'],
    ['e-free', 'ok'],
    ['a-free', 'rate-limited'],
    ['b-free', 'rate-limited'],
    ['c-free', 'rate-limited'],
  ])
})

test('a model left rate-limited by a tool step also gets the keyed re-run', async () => {
  const limitedShell = (request) =>
    request.apiKey === undefined && request.files?.['compat-shell.txt'] !== undefined ? RATE_LIMITED : toolUser()(request)
  const { deps, runs } = world({
    env: { OPENCODE_API_KEY: FAKE_KEY },
    replies: { 'alpha-free': [limitedShell], 'beta-free': [toolUser()] },
  })
  const { report } = await runCompat({ dsh: PIN, tools: true }, deps)
  assert.deepEqual(runs().filter((r) => r.apiKey !== undefined).map((r) => r.model), ['alpha-free'])
  assert.deepEqual([report.models[0].verdict, report.models[0].keyed?.verdict], ['rate-limited', 'ok'])
})

test('a --model id Zen does not serve as free is refused before installing or spending quota', async () => {
  const { deps, calls } = world()
  await assert.rejects(runCompat({ dsh: PIN, model: 'gamma-free' }, deps), (error) => {
    assert.match(error.message, /gamma-free/)
    assert.ok(error.message.includes('alpha-free'), 'the message lists the ids that can be chosen')
    return true
  })
  assert.deepEqual(calls, [])
})

test('--model asks only that model, hides the others during warmup, and the report says it was a single-model run', async () => {
  const ids = ['alpha-free', 'beta-free', 'gamma-free']
  const { deps, calls, runs } = world({ zenIds: ids })
  const { report, text, exitCode } = await runCompat({ dsh: PIN, model: 'beta-free' }, deps)
  assert.equal(exitCode, 0)
  assert.deepEqual(runs().map((run) => run.model), ['beta-free'])
  assert.deepEqual(calls.find((call) => call.kind === 'warmup').hidden, ['alpha-free', 'gamma-free'])
  assert.deepEqual(report.models.map((model) => model.id), ['beta-free'])
  assert.equal(report.header.model, 'beta-free')
  assert.deepEqual(report.catalogue, { error: null, sources: [], excluded: [], unresolved: [] })
  assert.match(text, /single-model/)
  assert.doesNotMatch(text, /every model verified/)
})

test('--l0-only reads the warmup round for every model and sends no L1 or L2 request', async () => {
  const ids = ['alpha-free', 'beta-free', 'gamma-free']
  const { deps, calls, runs } = world({ zenIds: ids })
  const { report, text, exitCode } = await runCompat({ dsh: PIN, l0Only: true }, deps)
  assert.equal(exitCode, 0)
  assert.equal(runs().length, 0)
  assert.equal(calls.find((call) => call.kind === 'warmup').hidden.length, 0)
  assert.deepEqual(report.models.map((model) => [model.id, model.verdict, model.layer]), ids.map((id) => [id, 'ok', 'L0']))
  assert.equal(report.header.l0Only, true)
  assert.deepEqual(report.acceptance, { scope: 'all-official-free-conversational-l0', requiredLayers: ['L0'], complete: true, fullModelAcceptance: false })
  assert.match(text, /L0 only/)
  assert.match(text, /not full acceptance/)
  assert.match(text, /Full-model L0\/L1\/L2 acceptance: not passed/)
})

test('--l0-only maps each failed probe to its verdict and never passes a refused model', async () => {
  const { deps, sleeps } = world({ zenIds: ['a-free', 'b-free', 'c-free', 'd-free'] })
  deps.driver.warmup = async () => ({
    visible: ['a-free', 'b-free', 'c-free', 'd-free'],
    probe: { results: {
      'a-free': { status: 'failed', code: 'quota-exhausted', http: 429 },
      'b-free': { status: 'failed', code: 'anon-gated', http: 403 },
      'c-free': { status: 'failed', code: 'dead', http: 404 },
      'd-free': { status: 'ok' },
    } },
  })
  const { report, exitCode } = await runCompat({ dsh: PIN, l0Only: true }, deps)
  assert.equal(exitCode, 2)
  assert.deepEqual(report.models.map((model) => [model.id, model.verdict]), [
    ['a-free', 'rate-limited'],
    ['b-free', 'gate-refused'],
    ['c-free', 'upstream-down'],
    ['d-free', 'ok'],
  ])
  assert.deepEqual(sleeps, [], 'no request follows the warmup, so nothing is spaced')
})

test('--l0-only still faults a free model missing from the picker', async () => {
  const { deps } = world({ zenIds: ['a-free', 'b-free'] })
  deps.driver.warmup = async () => ({ visible: ['a-free'], probe: { results: { 'a-free': { status: 'ok' } } } })
  const { report, exitCode } = await runCompat({ dsh: PIN, l0Only: true }, deps)
  assert.equal(exitCode, 1)
  assert.equal(report.models.find((model) => model.id === 'b-free').verdict, 'plugin-fault')
})

test('--l0-only cannot be combined with --model or --tools, and nothing runs', async () => {
  for (const extra of [{ model: 'alpha-free' }, { tools: true }]) {
    const { deps, calls } = world()
    await assert.rejects(runCompat({ dsh: PIN, l0Only: true, ...extra }, deps), /--l0-only/)
    assert.deepEqual(calls, [])
  }
})

test('a single-model run whose model was refused never says the model verified', async () => {
  const { deps } = world({ replies: { 'alpha-free': [GATED] } })
  const { report, text, exitCode } = await runCompat({ dsh: PIN, model: 'alpha-free' }, deps)
  assert.equal(exitCode, 2, 'a refused selected model is incomplete')
  assert.equal(report.models[0].verdict, 'gate-refused')
  assert.doesNotMatch(text, /selected model verified/)
  assert.match(text, /Result: exit code 2 .*incomplete/)
})

const officialDocsFixture = `<h2 id="endpoints">Endpoints</h2><table><tr><th>Model</th><th>Model ID</th><th>Endpoint</th><th>AI SDK Package</th></tr>
    <tr><td>New Chat</td><td>new-chat</td><td>https://opencode.ai/inference/openai/v1/chat/completions</td><td>sdk</td></tr>
    <tr><td>Paid</td><td>paid</td><td>https://opencode.ai/inference/openai/v1/responses</td><td>sdk</td></tr>
    <tr><td>Decision</td><td>decision-free</td><td>https://opencode.ai/inference/systemone/v1/systemone</td><td>-</td></tr></table>
    <h2 id="pricing">Pricing</h2><table><tr><th>Model</th><th>Input</th><th>Output</th><th>Cached Read</th><th>Cached Write</th></tr>
    <tr><td>New Chat</td><td>Free</td><td>Free</td><td>Free</td><td>-</td></tr>
    <tr><td>Paid</td><td>$1</td><td>$2</td><td>-</td><td>-</td></tr>
    <tr><td>Decision</td><td>Free</td><td>Free</td><td>-</td><td>-</td></tr></table>`

/** The official list plus the documentation page, as fetch doubles. */
const officialFetch = (data, docs = officialDocsFixture) => async url => {
  if (String(url).endsWith('/models')) return Response.json({ data })
  if (String(url).includes('/console/models/')) return typeof docs === 'string' ? new Response(docs) : new Response('', { status: docs })
  return new Response('', { status: 404 })
}

test('the official list drives targets and exclusions; the documentation page only adds cross-check warnings', async () => {
  const { fetchCompatCatalogue } = await import('../scripts/compat-catalogue.mjs')
  const { deps } = world({ zenIds: ['new-chat'] })
  deps.catalogue = () => fetchCompatCatalogue({ fetchImpl: officialFetch([official('new-chat'), official('paid', { price: 1 }), official('decision-free', { type: 'decision' })]), now: () => new Date('2026-10-15T00:00:00Z') })
  const { report, text } = await runCompat({ dsh: PIN }, deps)
  assert.deepEqual(report.models.map(row => row.id), ['new-chat'])
  assert.deepEqual(report.catalogue.excluded.map(row => [row.id, row.reason]), [['paid', 'paid'], ['decision-free', 'non-conversational']])
  assert.deepEqual(report.catalogue.warnings, ['documentation lists as free, official list does not: decision-free'])
  assert.equal(report.catalogue.sources.length, 2)
  assert.match(text, /Warning: documentation lists as free, official list does not: decision-free/)
})

test('a documentation page that disagrees or is unavailable only warns and never changes the targets', async () => {
  const { fetchCompatCatalogue } = await import('../scripts/compat-catalogue.mjs')
  const entries = [official('new-chat'), official('extra-free')]
  const disagree = await fetchCompatCatalogue({ fetchImpl: officialFetch(entries) })
  assert.deepEqual(disagree.targets.map(row => row.id), ['new-chat', 'extra-free'])
  assert.deepEqual(disagree.selection.warnings, [
    'documentation lists as free, official list does not: decision-free',
    'official list has as free, documentation does not: extra-free',
  ])
  const missing = await fetchCompatCatalogue({ fetchImpl: officialFetch(entries, 503) })
  assert.deepEqual(missing.targets.map(row => row.id), ['new-chat', 'extra-free'])
  assert.match(missing.selection.warnings[0], /documentation cross-check unavailable: HTTP 503/)
  assert.equal(missing.selection.sources[1].status, 'unavailable')
  const changed = await fetchCompatCatalogue({ fetchImpl: officialFetch(entries, officialDocsFixture.replace('<th>Input</th>', '<th>Unknown</th>')) })
  assert.deepEqual(changed.targets.map(row => row.id), ['new-chat', 'extra-free'])
  assert.match(changed.selection.warnings[0], /schema changed/)
})

test('the official api keys decide the transport and the lowest published effort', async () => {
  const { fetchCompatCatalogue } = await import('../scripts/compat-catalogue.mjs')
  const catalogue = await fetchCompatCatalogue({ fetchImpl: officialFetch([
    official('completions-free', { effort: ['none', 'low', 'high'] }),
    official('responses-free', { api: { responses: { base_url: 'https://opencode.ai/inference/openai/v1' } } }),
    official('messages-free', { api: { messages: { base_url: 'https://opencode.ai/inference/anthropic/v1' } } }),
  ]) })
  assert.deepEqual(catalogue.targets.map(row => [row.id, row.api, row.efforts]), [
    ['completions-free', 'openai-completions', ['none', 'low', 'high']],
    ['responses-free', 'openai-responses', undefined],
    ['messages-free', null, undefined],
  ])
  assert.deepEqual(catalogue.selection.unresolved, [])
})

test('a model the plugin offers that the official list does not call free is a plugin fault', async () => {
  const { deps } = world()
  deps.driver.warmup = async () => ({ visible: ['alpha-free', 'beta-free', 'paid-leak'], probe: { results: { 'alpha-free': { status: 'ok' }, 'beta-free': { status: 'ok' } } } })
  const { report, exitCode, text } = await runCompat({ dsh: PIN }, deps)
  assert.equal(exitCode, 1)
  assert.deepEqual(report.warmup.extraVisible, ['paid-leak'])
  assert.match(text, /Plugin offers models the official list does not call free: paid-leak/)
})

test('unresolved official classifications prevent full acceptance without querying those IDs', async () => {
  const { deps, runs } = world()
  const prior = deps.catalogue
  deps.catalogue = async () => ({ ...(await prior()), selection: { sources: [], excluded: [], unresolved: [{ id: 'uncertain', reason: 'official price missing' }] } })
  const { report, exitCode } = await runCompat({ dsh: PIN }, deps)
  assert.equal(exitCode, 2)
  assert.equal(report.catalogue.unresolved[0].id, 'uncertain')
  assert.ok(!runs().some(row => row.model === 'uncertain'))
})

test('an empty official target set is unfinished and never installs a host', async () => {
  const { deps, calls } = world({ zenIds: [] })
  const { exitCode, report } = await runCompat({ dsh: PIN }, deps)
  assert.equal(exitCode, 2)
  assert.deepEqual(report.models, [])
  assert.deepEqual(calls, [])
})

test('unsupported official conversational transports remain unverified targets', async () => {
  const { deps, runs } = world()
  const prior = deps.catalogue
  deps.catalogue = async () => ({ ...(await prior()), targets: [{ id: 'new-transport', api: null }] })
  deps.driver.warmup = async () => ({ visible: ['new-transport'], probe: { results: {} } })
  const { report, exitCode } = await runCompat({ dsh: PIN }, deps)
  assert.equal(exitCode, 2)
  assert.equal(report.models[0].id, 'new-transport')
  assert.equal(report.models[0].verdict, 'unverified')
  assert.deepEqual(runs(), [])
})

for (const [label, data] of [
  ['a missing price', [official('new-chat'), { id: 'uncertain', type: 'chat' }]],
  ['a non-numeric price', [official('new-chat'), official('uncertain', { cost: { text: { input: { price: 'free' }, output: { price: 0 } } } })]],
]) test(`official list with ${label} cannot produce a complete pass`, async () => {
  const { fetchCompatCatalogue } = await import('../scripts/compat-catalogue.mjs')
  const { deps, runs } = world({ zenIds: ['new-chat'] })
  deps.catalogue = () => fetchCompatCatalogue({ fetchImpl: officialFetch(data) })
  const { exitCode, report } = await runCompat({ dsh: PIN }, deps)
  assert.equal(exitCode, 2)
  assert.deepEqual(report.catalogue.unresolved, [{ id: 'uncertain', reason: 'official price missing' }])
  assert.ok(!runs().some(row => row.model === 'uncertain'))
})

test('plain final text cannot impersonate host tool execution in L2', async () => {
  const { deps } = world({ replies: { 'alpha-free': [request => {
    if (!request.files || !Object.keys(request.files).length) return ok()
    const content = Object.values(request.files)[0]
    const value = request.task.includes('read tool') ? content : createHash('sha256').update(content).digest('hex').slice(0, 16)
    return { stdout: JSON.stringify({ type: 'final', text: value })+'\n', stderr: '', exitCode: 0, format: 'headless-json' }
  }] } })
  const { report } = await runCompat({ dsh: PIN, tools: true }, deps)
  assert.equal(report.models[0].tools.read.pass, false)
  assert.equal(report.models[0].tools.shell.pass, false)
})

for (const [label, alter] of [
  ['wrong tool', rows => { rows[0].tool = 'bash' }],
  ['wrong path', rows => { rows[0].input.file_path = 'different-file.txt' }],
  ['unpaired result', rows => { rows[1].callId = 'different-call' }],
  ['error result', rows => { rows[1].status = 'error' }],
  ['truncated result', rows => { rows[1].truncated = true }],
  ['missing result', rows => { rows.splice(1, 1) }],
  ['duplicate final', rows => { rows.push({ ...rows.at(-1) }) }],
  ['wrong final', rows => { rows.at(-1).text = 'incorrect' }],
]) test(`L2 rejects ${label} without leaking raw host events`, async () => {
  const model = request => {
    const output = toolUser()(request)
    if (request.files?.['compat-read.txt'] !== undefined) {
      const rows = output.stdout.trim().split('\n').map(line => JSON.parse(line))
      rows[0].input.private_detail = 'PRIVATE_EVENT_MARKER'
      alter(rows)
      return { ...output, stdout: rows.map(row => JSON.stringify(row)).join('\n')+'\n' }
    }
    return output
  }
  const { deps } = world({ replies: { 'alpha-free': [model], 'beta-free': [toolUser()] } })
  const { report, text } = await runCompat({ dsh: PIN, tools: true }, deps)
  assert.equal(report.models[0].tools.read.pass, false)
  assert.equal(JSON.stringify(report).includes('PRIVATE_EVENT_MARKER'), false)
  assert.equal(text.includes('PRIVATE_EVENT_MARKER'), false)
})

test('JSON status records without a final assistant answer fail L1', async () => {
  const { deps } = world({ replies: { 'alpha-free': [{ stdout: '{"type":"status","phase":"turn_start"}\n', stderr: '', exitCode: 0, format: 'headless-json' }] } })
  const { report, exitCode } = await runCompat({ dsh: PIN }, deps)
  assert.equal(exitCode, 1)
  assert.equal(report.models[0].verdict, 'plugin-fault')
})

test('L0 refusal cannot be overridden by successful L1 and tool roundtrips', async () => {
  const { deps } = world({ replies: { 'alpha-free': [toolUser()], 'beta-free': [toolUser()] } })
  deps.driver.warmup = async () => ({ visible: ['alpha-free', 'beta-free'], probe: { results: {
    'alpha-free': { status: 'failed', code: 'quota-exhausted', http: 429 }, 'beta-free': { status: 'ok' },
  } } })
  const { report, exitCode } = await runCompat({ dsh: PIN, tools: true }, deps)
  assert.equal(report.models[0].tools.read.pass, true)
  assert.equal(exitCode, 2)
})

test('all-model full acceptance requires successful L0 and both host tool steps', async () => {
  const { deps } = world({ replies: { 'alpha-free': [toolUser()], 'beta-free': [toolUser()] } })
  const { report, exitCode } = await runCompat({ dsh: PIN, tools: true }, deps)
  assert.equal(exitCode, 0)
  assert.equal(report.acceptance.fullModelAcceptance, true)
  const narrow = await runCompat({ dsh: PIN, model: 'alpha-free' }, world().deps)
  assert.equal(narrow.exitCode, 0)
  assert.equal(narrow.report.acceptance.fullModelAcceptance, false)
})

test('unexpected inferred probe scope cannot be called full acceptance', async () => {
  const { deps } = world()
  const prior = deps.driver.warmup
  deps.driver.warmup = async request => ({ ...(await prior(request)), targets: ['alpha-free', 'beta-free', 'unexpected'] })
  const { report, exitCode, text } = await runCompat({ dsh: PIN }, deps)
  assert.equal(exitCode, 2)
  assert.equal(report.acceptance.complete, false)
  assert.ok(text.includes('Unexpected probe targets: unexpected'))
})

test('mixed valid and malformed official model entries cannot shrink acceptance silently', async () => {
  const { fetchCompatCatalogue } = await import('../scripts/compat-catalogue.mjs')
  const { deps, calls } = world({ zenIds: ['new-chat'] })
  deps.catalogue = () => fetchCompatCatalogue({ fetchImpl: officialFetch([official('new-chat'), { model_id: 'new-official-free' }]) })
  const { exitCode, report } = await runCompat({ dsh: PIN, tools: true }, deps)
  assert.equal(exitCode, 2)
  assert.equal(report.acceptance.complete, false)
  assert.deepEqual(calls, [])
})

test('tool evidence accepts the host reporting the canonical path of a symlinked workspace', async (t) => {
  const { verifyToolEvidence } = await import('../scripts/compat-evidence.mjs')
  const root = await mkdtemp(join(tmpdir(), 'compat-evidence-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const real = join(root, 'real')
  const link = join(root, 'link')
  await mkdir(real)
  try { await symlink(real, link, 'dir') } catch { return t.skip('symlinks unavailable') }
  const canonicalReal = await realpath(real)
  const evidence = (input, tool = 'read') => ({ valid: true, text: 'abc123', calls: [{ tool, input, status: 'completed', result: 'abc123' }] })
  const read = verifyToolEvidence(evidence({ file_path: join(canonicalReal, 'compat-read.txt') }), { tool: 'read', file: 'compat-read.txt', cwd: link }, 'abc123')
  assert.deepEqual(read, { callMatched: true, argumentsMatched: true, resultMatched: true, finalMatched: true })
  const shell = verifyToolEvidence(evidence({ command: 'echo', workdir: canonicalReal }, 'bash'), { tool: 'bash', command: 'echo', cwd: link }, 'abc123')
  assert.equal(shell.argumentsMatched, true)
  const other = verifyToolEvidence(evidence({ file_path: join(canonicalReal, 'other.txt') }), { tool: 'read', file: 'compat-read.txt', cwd: link }, 'abc123')
  assert.equal(other.argumentsMatched, false)
})
