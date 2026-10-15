import assert from 'node:assert/strict'
import test from 'node:test'
import { getApiProvider, registerApiProvider } from '@earendil-works/pi-ai/compat'
import { patchCompatDirectTransport, PROVIDER_ID } from '../src/zen-provider.ts'

test('compat stream methods preserve delegation, binding, and reasoning options', async t => {
  const apis = ['openai-completions', 'openai-responses']
  const calls = []
  const result = { role: 'assistant', content: [], stopReason: 'stop' }
  const stream = { result: async () => result }
  for (const api of apis) {
    registerApiProvider({ api, stream: () => stream, streamSimple: () => stream }, 'compat-test')
    const original = getApiProvider(api)
    for (const method of ['stream', 'streamSimple']) {
      t.mock.method(original, method, function (model, context, options) {
        assert.equal(this, original, 'the original method keeps its receiver')
        calls.push({ api, method, model, context, options })
        return stream
      })
    }
  }
  patchCompatDirectTransport(() => 'compat-test-session')

  for (const api of apis) for (const method of ['stream', 'streamSimple']) {
    const compat = getApiProvider(api)
    const foreignModel = { id: 'fixture', api, provider: 'another-provider', maxTokens: 1024 }
    const context = { messages: [{ role: 'user', content: 'OK', timestamp: 1 }] }
    const foreignOptions = { headers: { 'x-fixture': 'preserved' } }
    for (const options of [undefined, foreignOptions]) {
      assert.equal(compat[method](foreignModel, context, options), stream)
      const call = calls.at(-1)
      assert.equal(call.api, api)
      assert.equal(call.method, method)
      assert.equal(call.model, foreignModel)
      assert.equal(call.context, context)
      assert.equal(call.options, options, 'foreign options pass through unchanged')
    }

    const model = { ...foreignModel, id: 'muse-spark-fixture-free', provider: PROVIDER_ID }
    for (const options of [undefined, { apiKey: 'public', reasoning: 'low' }]) {
      const before = structuredClone(context)
      assert.equal(await compat[method](model, context, options).result(), result)
      const call = calls.at(-1)
      assert.equal(call.api, api)
      assert.equal(call.method, method)
      assert.equal(call.model, model)
      assert.equal(call.options.reasoning, options?.reasoning, 'compat adds no reasoning default')
      assert.equal(Object.hasOwn(call.options, 'reasoning'), options !== undefined)
      assert.deepEqual(context, before, 'request preparation leaves caller context unchanged')
    }
  }
  assert.equal(calls.length, 16, 'each request delegates exactly once')
})
