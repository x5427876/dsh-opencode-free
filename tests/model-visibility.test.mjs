import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROVIDER_ID, builtinFreeModels } from '../src/zen-provider.ts'

const plugin = await import('../src/index.ts')

// ── hermetic environment ─────────────────────────────────────────────────────
// The plugin resolves its catalogue cache from $DSH_HOME and reads models.dev
// through the ambient global fetch. Both are neutralised here, or this file's
// baseline silently becomes "whatever this machine has cached / whatever the
// network answered" — and a real cache DOES exist on the dev host, so that is
// not hypothetical.
const home = await mkdtemp(join(tmpdir(), 'dsh-opencode-free-visibility-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home

const realFetch = globalThis.fetch
// Default: every models.dev read fails fast and deterministically, so the
// catalogue stays on the D8 offline floor instead of a background sync landing
// in the middle of an assertion. `ensureFresh` is fire-and-forget from
// getModels(), so without this the first `listModels` would race the network.
const offlineFetch = async () => new Response('offline', { status: 503 })
globalThis.fetch = offlineFetch

after(async () => {
  globalThis.fetch = realFetch
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  // Windows holds a brief lock on a directory that was just written, and a
  // fire-and-forget `ensureFresh()` may still be mid-write. EBUSY here is a
  // teardown race, never a test failure, and retrying settles it.
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      return
    } catch (error) {
      if (error?.code !== 'EBUSY' || attempt >= 5) throw error
      await new Promise((r) => setTimeout(r, 100))
    }
  }
})

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * A REAL `api.json` slice. The provider record wraps the models dictionary one
 * level deeper (`body.opencode.models`); a fixture that spreads model records
 * straight onto the provider object still "works" as a JS object but derives an
 * EMPTY catalogue, because none of the provider's own keys carries a zero cost.
 * That substitution shipped a picker-empty defect once, so the nesting is
 * reproduced here exactly as models.dev serves it.
 */
const API_FIXTURE = {
  opencode: {
    id: 'opencode',
    npm: '@ai-sdk/openai-compatible',
    api: 'https://opencode.ai/zen/v1',
    models: {
      // Free + active, and known to pi-ai: exercises D6 tier 1.
      'big-pickle': {
        id: 'big-pickle',
        name: 'Big Pickle',
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        limit: { context: 200000, output: 32000 },
        modalities: { input: ['text'], output: ['text'] },
      },
      // Free + active, UNKNOWN to pi-ai: exercises D6 tiers 2-3 (effort ⇒
      // responses) and the limit/modalities mapping.
      'space-bunny-free': {
        id: 'space-bunny-free',
        name: 'Space Bunny Free',
        attachment: true,
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }],
        tool_call: true,
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        limit: { context: 1048576, output: 524288 },
        modalities: { input: ['text', 'image', 'video'], output: ['text'] },
      },
      // Free but retired upstream: it stays in the catalogue until a probe
      // judges it, then simply is not in the list.
      'deepseek-v4-flash-free': {
        id: 'deepseek-v4-flash-free',
        name: 'DeepSeek V4 Flash Free',
        status: 'deprecated',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        limit: { context: 200000, output: 128000 },
      },
      // Not free: must never reach the catalogue at all.
      'gpt-6-astra': {
        id: 'gpt-6-astra',
        name: 'GPT 6 Astra',
        cost: { input: 3, output: 15, cache_read: 0, cache_write: 0 },
        limit: { context: 400000, output: 128000 },
      },
    },
  },
}

const CATALOG_ROUTE = '/dsh-opencode-free/api/catalog'
const REFRESH_ROUTE = '/dsh-opencode-free/api/refresh'
const PROBE_ROUTE = '/dsh-opencode-free/api/probe'
/** The slot `patchGlobalFetchForZen` pins the first-seen global fetch into. */
const ZEN_FETCH_GUARD = '__dshOpenCodeFreeFetchOriginal'

// ── host harness ────────────────────────────────────────────────────────────

/**
 * A host context that satisfies everything `apply()` touches: the adapter
 * seat, the attachment lookup, AND the `webServer` inject the catalogue routes
 * register through. The `inject`/`effect` pair is not optional polish — without
 * it `registerCatalogRoutes` falls into its catch and the suite prints
 * "webServer wiring failed: ctx.inject is not a function" on every mount. The
 * host-side warn is a deliberate degradation signal and stays.
 */
function makeHost() {
  const registered = []
  const routes = new Map()
  const disposers = []
  const collect = (fn) => {
    const disposable = fn()
    if (typeof disposable === 'function') disposers.push(disposable)
  }
  const webCtx = {
    webServer: {
      register: ({ path, handler }) => {
        routes.set(path, handler)
        return () => {
          routes.delete(path)
        }
      },
    },
    effect: collect,
  }
  const ctx = {
    llm: {
      registerAdapter: (providers, adapter) => {
        registered.push([providers, adapter])
      },
    },
    get: () => undefined,
    inject: (requires, applyChild) => {
      if (requires.includes('webServer')) applyChild(webCtx)
    },
    effect: collect,
  }
  return {
    ctx,
    routes,
    registered,
    dispose: () => {
      for (const d of disposers) {
        try {
          d()
        } catch {
          /* released elsewhere */
        }
      }
    },
  }
}

function mount(config) {
  const host = makeHost()
  if (config === undefined) plugin.apply(host.ctx)
  else plugin.apply(host.ctx, config)
  assert.deepEqual(host.registered[0][0], [PROVIDER_ID])
  return host
}

async function listedIds(host) {
  return (await host.registered[0][1].listModels(PROVIDER_ID)).map((m) => m.id)
}

/** The unfiltered set of the CURRENT catalogue — never a hardcoded id list. */
async function catalogueIds(config = {}) {
  return (await listedIds(mount(config))).slice().sort()
}

/** Drive a registered route and resolve with its status + parsed body. */
function callRoute(
  host,
  path,
  method,
  headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
) {
  const handler = host.routes.get(path)
  assert.ok(typeof handler === 'function', `route ${path} must be registered`)
  return new Promise((resolve, reject) => {
    const res = {
      status: 0,
      writeHead(code) {
        this.status = code
      },
      end(body) {
        try {
          resolve({ status: this.status, body: JSON.parse(body) })
        } catch (error) {
          reject(error)
        }
      },
    }
    // The refresh route is fenced same-origin, so the headers are not optional.
    handler({ method, headers }, res)
  })
}

// ── behaviour ───────────────────────────────────────────────────────────────

test('hiddenModels filters listModels (the hidden id leaves, nothing else does)', async () => {
  const all = await catalogueIds()
  assert.ok(all.length > 1, 'catalogue must offer more than one model to tell them apart')
  const victim = all[0]
  const ids = await listedIds(mount({ hiddenModels: [victim] }))
  assert.ok(!ids.includes(victim), 'hidden model must not be listed')
  assert.deepEqual(
    ids.slice().sort(),
    all.filter((id) => id !== victim),
  )
})

test('hiddenModels parsing trims, drops empties, dedupes', async () => {
  const all = await catalogueIds()
  const victim = all[0]
  const ids = await listedIds(mount({ hiddenModels: [`  ${victim}  `, '', '   ', victim] }))
  assert.ok(!ids.includes(victim), 'whitespace/dup entries must still hide')
  assert.equal(ids.length, all.length - 1)
})

test('missing/empty hiddenModels lists the whole catalogue', async () => {
  const all = await catalogueIds()
  for (const config of [undefined, {}, { hiddenModels: [] }]) {
    const ids = await listedIds(mount(config))
    assert.deepEqual(ids.slice().sort(), all, `config ${JSON.stringify(config)} must list all`)
  }
})

test('unknown hidden id is ignored (storage retention is DSH config passthrough)', async () => {
  const all = await catalogueIds()
  const ids = await listedIds(mount({ hiddenModels: ['no-such-model'] }))
  assert.deepEqual(ids.slice().sort(), all)
  const victim = all[0]
  const mixed = await listedIds(mount({ hiddenModels: ['no-such-model', victim] }))
  assert.ok(!mixed.includes(victim), 'known hidden id still filtered alongside unknown')
  assert.equal(mixed.length, all.length - 1)
})

test('hidden model resolveModel fails, visible model resolves (no message assertion)', async () => {
  const all = await catalogueIds()
  const victim = all[0]
  const adapter = mount({ hiddenModels: [victim] }).registered[0][1]
  await assert.rejects(adapter.resolveModel(PROVIDER_ID, victim))
  const visible = all.find((id) => id !== victim)
  const resolved = await adapter.resolveModel(PROVIDER_ID, visible)
  assert.equal(resolved.id, visible)
})

test('Volatile-ref hiddenModels (DSH live shape) unwraps via get()', async () => {
  const all = await catalogueIds()
  const victim = all[0]
  const ids = await listedIds(mount({ hiddenModels: { get: () => [victim] } }))
  assert.ok(!ids.includes(victim), 'ref-wrapped hidden model must not be listed')
  assert.equal(ids.length, all.length - 1)
  const emptyRef = await listedIds(mount({ hiddenModels: { get: () => undefined } }))
  assert.deepEqual(emptyRef.slice().sort(), all)
})

test('schema marks hiddenModels volatile so DSH serves the config row', async () => {
  const { Config } = plugin
  const node = Config.dict?.hiddenModels ?? Config.inner
  assert.ok(node?.meta?.volatile === true, 'hiddenModels must be volatile (configForms row + live writes)')
})

// ── catalogue owner ─────────────────────────────────────────────────────────

test('a failed fetch leaves the pi-ai builtin floor in place (D8 offline floor)', async () => {
  // The failure mode this pins is the one that emptied the picker once: any
  // fetch trouble must degrade to the builtin set, never to an empty list.
  const ids = await catalogueIds()
  assert.ok(ids.length > 0, 'offline catalogue must never be empty')
  assert.deepEqual(
    ids,
    builtinFreeModels()
      .map((m) => m.id)
      .slice()
      .sort(),
  )
})

test('derived catalogue: deprecated stays until a probe judges it, paid drops out', async () => {
  // The Zen identity guard (zen-provider.ts) captures the FIRST global fetch it
  // ever sees into `__dshOpenCodeFreeFetchOriginal` and delegates to it for
  // every later call, re-wrapping on each apply(). Swapping `globalThis.fetch`
  // after the first mount therefore cannot redirect the catalogue sync — the
  // guard still holds the original. Moving the captured original is the only
  // honest way to drive this path, and the reset restores the floor for the
  // tests that follow.
  const servingFetch = async (url) => {
    if (String(url).includes('models.dev')) {
      return new Response(JSON.stringify(API_FIXTURE), {
        status: 200,
        headers: { 'content-type': 'application/json', etag: '"fixture"' },
      })
    }
    return new Response('{}', { status: 404 })
  }
  globalThis[ZEN_FETCH_GUARD] = servingFetch
  globalThis.fetch = servingFetch

  const host = mount({})
  try {
    // The refresh route is the documented sync point: it awaits the sync (new
    // or shared) and answers from the settled snapshot, so the catalogue is
    // adopted by the time it replies. Nothing here depends on the
    // fire-and-forget lazy revalidation having landed first.
    const refreshed = await callRoute(host, REFRESH_ROUTE, 'POST')
    assert.equal(refreshed.status, 200)
    assert.equal(refreshed.body.source, 'models.dev')

    const ids = await listedIds(host)
    assert.ok(ids.includes('space-bunny-free'), 'a newly published free model must appear')
    assert.ok(
      ids.includes('deepseek-v4-flash-free'),
      'D1: a deprecated free model stays until a probe judges it',
    )
    assert.ok(!ids.includes('gpt-6-astra'), 'a paid model must never enter the catalogue')
    // The payload names the offered models and nothing else. There is no list
    // of unavailable models, so a model that is not offered is simply absent —
    // and the panel has no second source that could disagree with the picker.
    // `models` carries one capability card per visible id, same order.
    // `unknownFree` is not a second list of offered models: it is a diagnostic
    // about ids the catalogue has never heard of, and it is empty here.
    assert.deepEqual(Object.keys(refreshed.body).sort(), [
      'gateCheckedAt',
      'models',
      'probeInconclusive',
      'probedAt',
      'refreshing',
      'source',
      'unknownFree',
      'updatedAt',
      'visible',
    ])
    assert.deepEqual(refreshed.body.unknownFree, [])
    assert.deepEqual(
      refreshed.body.models.map((m) => m.id),
      refreshed.body.visible,
    )
    const bunny = refreshed.body.models.find((m) => m.id === 'space-bunny-free')
    assert.deepEqual(bunny, { id: 'space-bunny-free', image: true, thinking: 'max' })
    const pickle = refreshed.body.models.find((m) => m.id === 'big-pickle')
    assert.deepEqual(pickle, { id: 'big-pickle', image: false, thinking: null })

    // The derived record is a real model as far as the picker is concerned.
    const adapter = host.registered[0][1]
    const derived = await adapter.resolveModel(PROVIDER_ID, 'space-bunny-free')
    assert.equal(derived.id, 'space-bunny-free')
    const deprecated = await adapter.resolveModel(PROVIDER_ID, 'deepseek-v4-flash-free')
    assert.equal(deprecated.id, 'deepseek-v4-flash-free', 'it resolves until a probe says otherwise')

    // Field-level mapping (channel + limits) is asserted on the seam that
    // actually owns it — the catalogue's own model records — not on the
    // adapter's resolved-model info, which never carried `api`.
    const record = plugin.freeModels().find((m) => m.id === 'space-bunny-free')
    assert.ok(record, 'the derived record must be in the catalogue')
    assert.equal(record.api, 'openai-responses', 'D6: reasoning effort ⇒ responses')
    assert.equal(record.name, 'Space Bunny Free')
    assert.equal(record.contextWindow, 1048576, 'limit.context is mapped')
    assert.equal(record.maxTokens, 524288, 'limit.output is mapped')
  } finally {
    delete globalThis[ZEN_FETCH_GUARD]
    globalThis.fetch = offlineFetch
    host.dispose()
  }
})

test('the panel endpoint reports exactly what the picker offers', async () => {
  const host = mount({})
  try {
    const read = await callRoute(host, CATALOG_ROUTE, 'GET')
    assert.equal(read.status, 200)
    assert.deepEqual(read.body.visible.slice().sort(), (await listedIds(host)).slice().sort())
    assert.equal(typeof read.body.source, 'string')
    // Provenance and freshness are part of the contract the panel renders.
    assert.equal(read.body.source, 'builtin-fallback')
    assert.equal(typeof read.body.updatedAt, 'number')
    assert.equal(read.body.refreshing, false)
  } finally {
    host.dispose()
  }
})

test('routes are method-guarded and disposing releases them', async () => {
  const host = mount({})
  try {
    assert.equal((await callRoute(host, CATALOG_ROUTE, 'POST')).status, 405, 'read route rejects writes')
    assert.equal((await callRoute(host, REFRESH_ROUTE, 'GET')).status, 405, 'refresh route rejects reads')
    assert.equal((await callRoute(host, PROBE_ROUTE, 'PUT')).status, 405, 'probe route rejects other methods')
    assert.equal((await callRoute(host, PROBE_ROUTE, 'DELETE')).status, 405, 'probe route rejects deletes')
  } finally {
    host.dispose()
  }
  assert.equal(host.routes.size, 0, 'unload must release both routes')
})

test('the progress reading reaches the wire with each failure reason intact', async () => {
  // The card cannot word a failure it was never told about, so the endpoint's
  // JSON is the contract: `code` and `http` must survive serialization exactly.
  const host = mount({})
  try {
    const read = await callRoute(host, PROBE_ROUTE, 'GET')
    assert.equal(read.status, 200)
    const wire = JSON.parse(JSON.stringify(read.body))
    assert.deepEqual(Object.keys(wire).sort(), [
      'current',
      'done',
      'results',
      'running',
      'startedAt',
      'targets',
      'total',
    ])
  } finally {
    host.dispose()
  }
})

test('GET on the probe route reports live progress without starting a round', async () => {
  const host = mount({})
  try {
    // No prober is wired in this mount, so forceProbes is a no-op — but the
    // progress shape must still answer, because the panel polls it blind.
    const idle = await callRoute(host, PROBE_ROUTE, 'GET')
    assert.equal(idle.status, 200)
    assert.deepEqual(idle.body, {
      running: false,
      total: 0,
      done: 0,
      current: null,
      results: {},
      targets: [],
      startedAt: 0,
    })
    // A read-only GET carries no origin fence (like the catalogue read);
    // only the POST that spends quota does.
    assert.equal(idle.body.running, false)
  } finally {
    host.dispose()
  }
})

test('the probe POST answers while the round is still running', async () => {
  // A click on "Probe now" used to hold an HTTP request open for the whole
  // round — one request per model, each able to burn its full 15s timeout.
  // Nothing needed that: the progress endpoint already reports `running` live,
  // and the panel already follows it. 202 says "accepted, not finished", and
  // the round is handed back inside the response so a caller that never polls
  // can still see that one started.
  const host = mount({})
  try {
    const read = await callRoute(host, PROBE_ROUTE, 'POST', {
      host: '127.0.0.1:3080',
      origin: 'http://127.0.0.1:3080',
    })
    assert.equal(read.status, 202, 'accepted, not waited on')
    assert.equal(
      read.body.probe,
      undefined,
      'no progress reading: one taken now would be the pre-round state',
    )
    assert.ok(Array.isArray(read.body.visible), 'the catalogue travels with it, so the card can repaint')
  } finally {
    host.dispose()
  }
})

test('a same-origin POST must still name this machine (DNS rebinding)', async () => {
  // Origin and Host agreeing is not enough: under DNS rebinding an attacker's
  // page at evil.example resolves to 127.0.0.1, so the browser sends
  // `Origin: http://evil.example` TOGETHER WITH `Host: evil.example` and the two
  // match. The check therefore has to be that the Host NAMES THE LOCAL MACHINE
  //. This is a desktop app on loopback, and a rebinding page
  // that reached it could spend the shared anonymous bucket through POST /probe.
  const host = mount({})

  const local = await callRoute(host, REFRESH_ROUTE, 'POST', {
    host: '127.0.0.1:3080',
    origin: 'http://127.0.0.1:3080',
  })
  assert.equal(local.status, 200, 'a genuine local same-origin POST is still allowed')

  for (const name of ['localhost:3080', '[::1]:3080']) {
    const ok = await callRoute(host, REFRESH_ROUTE, 'POST', { host: name, origin: `http://${name}` })
    assert.equal(ok.status, 200, `${name} is this machine and must be allowed`)
  }

  const rebound = await callRoute(host, REFRESH_ROUTE, 'POST', {
    host: 'evil.example:3080',
    origin: 'http://evil.example:3080',
  })
  assert.equal(rebound.status, 403, 'a rebound host is refused even though Origin and Host agree')
  assert.equal(rebound.body.reason, 'cross-origin')

  const reboundProbe = await callRoute(host, PROBE_ROUTE, 'POST', {
    host: 'evil.example:3080',
    origin: 'http://evil.example:3080',
  })
  assert.equal(reboundProbe.status, 403, 'and the quota-spending route is fenced the same way')

  host.dispose?.()
})
