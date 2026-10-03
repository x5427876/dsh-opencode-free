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
