import assert from 'node:assert/strict'
import test from 'node:test'
import { getApiProvider, registerApiProvider } from '@earendil-works/pi-ai/compat'
import { patchCompatDirectTransport } from '../src/zen-provider.ts'

// G3: the compat patch replaces pi-ai's per-api registry entry, so unloading must
// put the previous behaviour back, and only while that entry is still ours.
// The registry re-wraps every registration, so identity cannot be compared;
// instead a Zen request shows whether the patch is in the chain: the patch adds
// the OpenCode identity headers before the previous entry runs.
const APIS = ['openai-completions', 'openai-responses']
const context = { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }

function baseFor(api, seen) {
  return {
    api,
    stream: (_model, _context, options) => { seen.push({ api, owner: 'base', headers: options?.headers }); return {} },
    streamSimple: (_model, _context, options) => { seen.push({ api, owner: 'base', headers: options?.headers }); return {} },
  }
}

const zenModel = api => ({ id: 'm', name: 'm', api, provider: 'opencode-zen-free', baseUrl: 'https://opencode.ai/inference/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 })

/** True when a Zen request through the registry entry passes the patch first. */
function patched(api, seen) {
  seen.length = 0
  getApiProvider(api).streamSimple(zenModel(api), context, { apiKey: 'public' })
  assert.equal(seen.length, 1, `${api} reached the previous entry once`)
  return new Headers(seen[0].headers).get('x-opencode-client') !== null
}

function withBases(run) {
  return async () => {
    const stashKey = '__dshOpenCodeFreeCompatOriginals'
    const savedStash = globalThis[stashKey]
    delete globalThis[stashKey]
    const saved = new Map(APIS.map(api => [api, getApiProvider(api)]))
    const seen = []
    for (const api of APIS) registerApiProvider(baseFor(api, seen), 'test-base')
    try {
      await run(seen)
    } finally {
      for (const [api, provider] of saved) if (provider) registerApiProvider(provider)
      if (savedStash === undefined) delete globalThis[stashKey]
      else globalThis[stashKey] = savedStash
    }
  }
}

test('unloading puts back the registry entries the patch replaced', withBases(seen => {
  const restore = patchCompatDirectTransport(() => undefined)
  for (const api of APIS) assert.equal(patched(api, seen), true, `${api} is patched`)
  restore()
  for (const api of APIS) assert.equal(patched(api, seen), false, `${api} is restored`)
}))

test('unloading twice, then loading again, keeps one patch over the original', withBases(seen => {
  patchCompatDirectTransport(() => undefined)()
  const restore = patchCompatDirectTransport(() => undefined)
  for (const api of APIS) assert.equal(patched(api, seen), true)
  restore()
  restore()
  for (const api of APIS) assert.equal(patched(api, seen), false)
}))

test('a registration made by another plugin after the patch survives unloading', withBases(seen => {
  const restore = patchCompatDirectTransport(() => undefined)
  const theirs = []
  registerApiProvider(baseFor('openai-completions', theirs), 'other-plugin')
  restore()
  getApiProvider('openai-completions').streamSimple(zenModel('openai-completions'), context, { apiKey: 'public' })
  assert.equal(theirs.length, 1, 'the later registration is still the one that runs')
  assert.equal(patched('openai-responses', seen), false, 'the api nobody else touched is restored')
}))
