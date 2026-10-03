import assert from 'node:assert/strict'
import test from 'node:test'
import { runCompat } from '../scripts/compat-core.mjs'

const PIN = '0.2.1-alpha.1'

/**
 * Fake world for one compat run. Every dependency is in memory: no DSH, no
 * Zen, no models.dev, no real waiting. `replies` maps a model id to the queue
 * of driver outputs it answers with, in order; the last entry repeats.
 */
function world({
  replies = {},
  zenIds = ['alpha-free', 'beta-free'],
  modelsDev,
  builtinIds = ['alpha-free', 'beta-free'],
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
      modelsDev: modelsDev ?? Object.fromEntries(zenIds.map((id) => [id, free()])),
      builtinIds,
    }),
    driver: {
      setup: async () => {
        calls.push({ kind: 'setup' })
      },
      warmup: async () => {
        calls.push({ kind: 'warmup' })
        return { visible: [...zenIds], probe: { results: {} } }
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

function free(extra = {}) {
  return { cost: { input: 0, output: 0 }, ...extra }
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
    assert.match(error.message, /0\.2\.1-alpha\.1/)
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

test('upstream-down and gate-refused are reported but leave the exit code at 0', async () => {
  const { deps } = world({
    replies: { 'alpha-free': [GATED], 'beta-free': [failed('dsh: PROVIDER_ERROR: Endpoint is unavailable')] },
  })
  const { report, exitCode } = await runCompat({ dsh: PIN }, deps)
  assert.deepEqual(report.models.map((m) => m.verdict), ['gate-refused', 'upstream-down'])
  assert.equal(exitCode, 0)
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
  const { deps, sleeps } = world({ zenIds: ids, builtinIds: ids })
  await runCompat({ dsh: PIN }, deps)
  assert.deepEqual(sleeps, [3_000, 3_000])
})

test('three rate-limited models in a row end the run and the rest are listed as unverified', async () => {
  const ids = ['a-free', 'b-free', 'c-free', 'd-free', 'e-free']
  const { deps, runs } = world({
    zenIds: ids,
    builtinIds: ids,
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
    builtinIds: ids,
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

test('the models verified are Zen\'s list intersected with what models.dev calls free', async () => {
  const { deps, runs } = world({
    zenIds: ['alpha-free', 'paid-model', 'zen-only-free', 'new-free'],
    modelsDev: {
      'alpha-free': free(),
      'paid-model': { cost: { input: 1, output: 2 } },
      'new-free': free(),
      'md-only-free': free(),
    },
    builtinIds: ['alpha-free', 'retired-free'],
  })
  const { report } = await runCompat({ dsh: PIN }, deps)
  assert.deepEqual(report.models.map((m) => m.id), ['alpha-free', 'new-free'])
  assert.deepEqual([...new Set(runs().map((r) => r.model))], ['alpha-free', 'new-free'])
  assert.deepEqual(report.catalogue.onlyLive, ['new-free'])
  assert.deepEqual(report.catalogue.onlyBuiltin, ['retired-free'])
})

test('each model is asked at its lowest published effort; a model without levels uses the default and says so', async () => {
  const { deps, runs } = world({
    zenIds: ['effort-free', 'toggle-free', 'bare-free'],
    modelsDev: {
      'effort-free': free({ reasoning_options: [{ type: 'effort', values: ['high', 'low', 'max'] }] }),
      'toggle-free': free({ reasoning_options: [{ type: 'toggle' }] }),
      'bare-free': free(),
    },
    builtinIds: [],
  })
  const { report } = await runCompat({ dsh: PIN }, deps)
  assert.deepEqual(runs().map((r) => [r.model, r.effort]), [
    ['effort-free', 'low'],
    ['toggle-free', undefined],
    ['bare-free', undefined],
  ])
  assert.deepEqual(report.models.map((m) => [m.id, m.effort, m.effortNote]), [
    ['effort-free', 'low', ''],
    ['toggle-free', null, 'no published levels (無等級可選)'],
    ['bare-free', null, 'no published levels (無等級可選)'],
  ])
})

test('a live catalogue that cannot be fetched stops the run and says so instead of falling back to the builtin list', async () => {
  const { deps, calls } = world()
  deps.catalogue = async () => {
    throw new Error('models.dev: HTTP 503')
  }
  const { report, exitCode } = await runCompat({ dsh: PIN }, deps)
  assert.match(report.catalogue.error, /models\.dev: HTTP 503/)
  assert.deepEqual(report.models, [])
  assert.deepEqual(calls, [])
  assert.equal(exitCode, 2)
})

test('the warmup runs once, before any model, and no model run repeats it', async () => {
  const ids = ['a-free', 'b-free', 'c-free']
  const { deps, calls } = world({ zenIds: ids, builtinIds: ids })
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
  const { deps, runs } = world({ zenIds: ids, builtinIds: ids })
  deps.driver.warmup = async () => ({
    visible: ['shown-free'],
    probe: { results: { 'dead-free': { status: 'failed', code: 'dead', http: 404, ms: 300 } } },
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
