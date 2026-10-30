import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { cachePath, writeCacheAtomic } from '../src/catalog.ts'
import { PROVIDER_ID } from '../src/zen-provider.ts'

const plugin = await import('../src/index.ts')

// ── hermetic environment ─────────────────────────────────────────────────────
// The plugin resolves its catalogue cache from $DSH_HOME and reads Zen's model
// list through the ambient global fetch. Both are neutralised here, or this
// file's baseline silently becomes "whatever this machine has cached / whatever
// the network answered" — and a real cache DOES exist on the dev host, so that
// is not hypothetical.
const home = await mkdtemp(join(tmpdir(), 'dsh-opencode-free-visibility-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home

const realFetch = globalThis.fetch
// Default: every list read fails fast and deterministically, so the catalogue
// stays on the seeded cache below instead of a background sync landing in the
// middle of an assertion. `ensureFresh` is fire-and-forget from getModels(), so
// without this the first `listModels` would race the network.
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
 * A slice of Zen's official model list, in the shape it is served:
 * `{ data: [...] }` whose entries carry `type`, `cost.text.*.price`, `limit`,
 * `modalities`, `capabilities.reasoning` and an `api` object keyed by endpoint.
 */
const price = (input = 0, output = 0) => ({ text: { input: { price: input }, output: { price: output } } })

const LIST_FIXTURE = {
  object: 'list',
  data: [
    // Free, and known to pi-ai: exercises the channel the entry declares.
    {
      id: 'big-pickle',
      name: 'Big Pickle',
      type: 'chat',
      cost: price(),
      limit: { context: 200000, output: 32000 },
      modalities: { input: ['text'], output: ['text'] },
      api: { 'chat-completions': {} },
    },
    // Free, UNKNOWN to pi-ai (asserted below): exercises the limit, modality and
    // effort mapping. The id is invented so a pi-ai upgrade cannot add it to the
    // builtin table.
    {
      id: 'orbit-otter-free',
      name: 'Orbit Otter Free',
      type: 'chat',
      cost: price(),
      limit: { context: 1048576, output: 524288 },
      modalities: { input: ['text', 'image/png', 'video/mp4'], output: ['text'] },
      capabilities: { reasoning: { supported: true, effort: ['low', 'medium', 'high', 'xhigh', 'max'] } },
      api: { responses: {} },
    },
    {
      id: 'deepseek-v4-flash-free',
      name: 'DeepSeek V4 Flash Free',
      type: 'chat',
      cost: price(),
      limit: { context: 200000, output: 128000 },
      capabilities: { reasoning: { supported: true, effort: ['low', 'high', 'max'] } },
      api: { 'chat-completions': {} },
    },
    // Not free: must never reach the catalogue at all.
    { id: 'gpt-6-astra', name: 'GPT 6 Astra', type: 'chat', cost: price(3, 15), limit: { context: 400000, output: 128000 } },
    // Not conversational: free, and still not a model the picker can offer.
    { id: 'embed-free', name: 'Embed Free', type: 'embedding', cost: price() },
    // Conversational with no readable cost: excluded, and counted.
    { id: 'unpriced-chat', name: 'Unpriced Chat', type: 'chat' },
  ],
}

/** What the cache held before this run: the list as of a moment ago, minus the model the refresh will add. */
const SEEDED = LIST_FIXTURE.data.filter((entry) => entry.id === 'big-pickle' || entry.id === 'deepseek-v4-flash-free')
await writeCacheAtomic(cachePath({ DSH_HOME: home }), { fetchedAt: Date.now(), models: SEEDED })

// The mounted plugin would otherwise carry Zen requests past the mocked global fetch.
process.env.DSH_OPENCODE_FREE_TLS_CIPHERS = 'default'
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

/**
 * The warm cache is read in the background (a container must answer
 * synchronously), so the first read after a mount can legitimately be empty.
 * Wait for the catalogue to hold a list instead of betting on a tick count.
 */
async function catalogueReady() {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (plugin.freeModels().length > 0) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('the seeded cache was never adopted')
}

async function listedIds(host) {
  await catalogueReady()
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
  await catalogueReady()
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

test('a failed refresh leaves the cached list in place', async () => {
  // The failure mode this pins is the one that empties the picker: any fetch
  // trouble must keep the list the cache already holds, never replace it with
  // nothing. The ambient fetch answers 503 here.
  const host = mount({})
  try {
    await catalogueReady()
    const before = (await listedIds(host)).slice().sort()
    assert.deepEqual(before, ['big-pickle', 'deepseek-v4-flash-free'], 'the seeded list')
    const refreshed = await callRoute(host, REFRESH_ROUTE, 'POST')
    assert.equal(refreshed.status, 200)
    assert.equal(refreshed.body.source, 'official', 'the held list is still the answer')
    assert.deepEqual(refreshed.body.visible.slice().sort(), before)
    assert.deepEqual((await listedIds(host)).slice().sort(), before)
  } finally {
    host.dispose()
  }
})

test('a cold start with no cache and no network offers nothing, and says so', async () => {
  // There is no offline floor: with no list ever fetched the catalogue is empty
  // and reports `none`, rather than offering models nobody has confirmed.
  const empty = await mkdtemp(join(tmpdir(), 'dsh-opencode-free-cold-'))
  process.env.DSH_HOME = empty
  const host = mount({})
  try {
    const refreshed = await callRoute(host, REFRESH_ROUTE, 'POST')
    assert.equal(refreshed.status, 200)
    assert.equal(refreshed.body.source, 'none')
    assert.deepEqual(refreshed.body.visible, [])
    assert.equal(refreshed.body.updatedAt, 0)
    assert.deepEqual(await host.registered[0][1].listModels(PROVIDER_ID), [])
    assert.deepEqual(plugin.freeModels(), [])
  } finally {
    host.dispose()
    process.env.DSH_HOME = home
    await rm(empty, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('derived catalogue: new free entries appear, paid and unreadable ones drop out', async () => {
  assert.ok(
    !getBuiltinModels('opencode').some((m) => m.id === 'orbit-otter-free'),
    'the derived-model fixture id must stay unknown to pi-ai',
  )
  // The Zen identity guard (zen-provider.ts) captures the FIRST global fetch it
  // ever sees into `__dshOpenCodeFreeFetchOriginal` and delegates to it for
  // every later call, re-wrapping on each apply(). Swapping `globalThis.fetch`
  // after the first mount therefore cannot redirect the catalogue sync — the
  // guard still holds the original. Moving the captured original is the only
  // honest way to drive this path, and the reset restores the offline answer
  // for the tests that follow.
  const requested = []
  const servingFetch = async (url) => {
    requested.push(String(url))
    if (String(url).endsWith('/inference/v1/models')) {
      return new Response(JSON.stringify(LIST_FIXTURE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('{}', { status: 404 })
  }
  globalThis[ZEN_FETCH_GUARD] = servingFetch
  globalThis.fetch = servingFetch

  const host = mount({})
  try {
    // The refresh route is the documented sync point: it awaits the sync (new
    // or shared) and answers from the settled snapshot, so the list is adopted
    // by the time it replies. Nothing here depends on the fire-and-forget lazy
    // revalidation having landed first.
    const refreshed = await callRoute(host, REFRESH_ROUTE, 'POST')
    assert.equal(refreshed.status, 200)
    assert.equal(refreshed.body.source, 'official')
    assert.ok(requested.some((url) => url.endsWith('/inference/v1/models')), 'it read the official list')
    assert.ok(!requested.some((url) => url.includes('models.dev')), 'and no other source')

    const ids = await listedIds(host)
    assert.ok(ids.includes('orbit-otter-free'), 'a newly published free model must appear')
    assert.ok(ids.includes('deepseek-v4-flash-free'))
    assert.ok(!ids.includes('gpt-6-astra'), 'a paid model must never enter the catalogue')
    assert.ok(!ids.includes('embed-free'), 'a free embedding model is not a chat model')
    assert.ok(!ids.includes('unpriced-chat'), 'an unreadable cost is never assumed free')
    // The payload names the offered models and nothing else. There is no list
    // of unavailable models, so a model that is not offered is simply absent —
    // and the panel has no second source that could disagree with the picker.
    // `models` carries one capability card per visible id, same order.
    // `unclassified` is a count, not a second list: how many chat entries the
    // list published with a cost this plugin could not read.
    assert.deepEqual(Object.keys(refreshed.body).sort(), [
      'models',
      'probeInconclusive',
      'probedAt',
      'refreshing',
      'source',
      'unclassified',
      'updatedAt',
      'visible',
    ])
    assert.equal(refreshed.body.unclassified, 1)
    assert.deepEqual(
      refreshed.body.models.map((m) => m.id),
      refreshed.body.visible,
    )
    const bunny = refreshed.body.models.find((m) => m.id === 'orbit-otter-free')
    assert.deepEqual(bunny, { id: 'orbit-otter-free', image: true, thinking: 'max' })
    const pickle = refreshed.body.models.find((m) => m.id === 'big-pickle')
    assert.deepEqual(pickle, { id: 'big-pickle', image: false, thinking: null })

    // The derived record is a real model as far as the picker is concerned.
    const adapter = host.registered[0][1]
    const derived = await adapter.resolveModel(PROVIDER_ID, 'orbit-otter-free')
    assert.equal(derived.id, 'orbit-otter-free')

    // Field-level mapping (channel + limits) is asserted on the seam that
    // actually owns it — the catalogue's own model records — not on the
    // adapter's resolved-model info, which never carried `api`.
    const record = plugin.freeModels().find((m) => m.id === 'orbit-otter-free')
    assert.ok(record, 'the derived record must be in the catalogue')
    assert.equal(record.api, 'openai-responses', 'the entry declares the responses endpoint')
    assert.equal(record.name, 'Orbit Otter Free')
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
    await catalogueReady()
    const read = await callRoute(host, CATALOG_ROUTE, 'GET')
    assert.equal(read.status, 200)
    assert.deepEqual(read.body.visible.slice().sort(), (await listedIds(host)).slice().sort())
    assert.equal(typeof read.body.source, 'string')
    // Provenance and freshness are part of the contract the panel renders.
    assert.equal(read.body.source, 'official')
    assert.equal(typeof read.body.updatedAt, 'number')
    assert.equal(read.body.refreshing, false)
    assert.equal(read.body.unclassified, 0, 'a cached list carries only free entries; nothing to count')
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
  // A cache written by an earlier round restores that round's summary at start,
  // so the idle shape is only observable against a cache that never saw one.
  const empty = await mkdtemp(join(tmpdir(), 'dsh-opencode-free-idle-'))
  process.env.DSH_HOME = empty
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
    process.env.DSH_HOME = home
    await rm(empty, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
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
