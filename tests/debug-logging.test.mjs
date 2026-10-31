import assert from 'node:assert/strict'
import test from 'node:test'
import { probeModel, zenProvider } from '../src/zen-provider.ts'

// G1: debug output may name a credential's state, never its content, and an
// upstream error payload contributes only allowlisted fields.
const KEY = 'sk-live-FAKEKEY0123456789abcdef'
const PROMPT = 'CONFIDENTIAL-CONVERSATION-TEXT'
const context = { messages: [{ role: 'user', content: PROMPT, timestamp: 1 }] }

async function captureDebug(run) {
  const lines = []
  const original = console.error
  const previous = process.env.DSH_OPENCODE_FREE_DEBUG
  console.error = (...args) => lines.push(args.join(' '))
  process.env.DSH_OPENCODE_FREE_DEBUG = '1'
  try {
    await run()
  } finally {
    console.error = original
    if (previous === undefined) delete process.env.DSH_OPENCODE_FREE_DEBUG
    else process.env.DSH_OPENCODE_FREE_DEBUG = previous
  }
  return lines.join('\n')
}

const leaks = text => [KEY, KEY.slice(0, 8), PROMPT, 'Bearer sk'].filter(piece => text.includes(piece))

test('request debug lines state the credential kind without any of its content', async () => {
  const provider = zenProvider()
  const model = provider.getModels().find(m => m.api === 'openai-completions')
  const output = await captureDebug(async () => {
    for (const apiKey of [KEY, 'public']) {
      await provider.streamSimple(model, context, {
        apiKey, maxRetries: 0,
        fetch: async () => Response.json({ error: { type: 'diagnostic_stop' } }, { status: 403 }),
      }).result()
    }
  })
  assert.match(output, /auth=key/)
  assert.match(output, /auth=anonymous/)
  assert.deepEqual(leaks(output), [])
})

test('probe refusals log the status, marker and error code, never the payload text', async () => {
  const provider = zenProvider()
  const model = provider.getModels().find(m => m.api === 'openai-completions')
  const body = {
    error: {
      type: 'FreeTierError',
      code: 'free_tier_limit',
      message: `Bearer ${KEY} rejected while reading: ${PROMPT}`,
    },
  }
  const output = await captureDebug(() =>
    probeModel(model, { provider, apiKey: KEY, fetchImpl: async () => Response.json(body, { status: 403 }) }),
  )
  assert.match(output, /probe <- 403 marker=FreeTierError code=free_tier_limit/)
  assert.deepEqual(leaks(output), [])
})

test('probe refusals with a non-JSON body log only its size', async () => {
  const provider = zenProvider()
  const model = provider.getModels().find(m => m.api === 'openai-completions')
  const output = await captureDebug(() =>
    probeModel(model, { provider, apiKey: KEY, fetchImpl: async () => new Response(`${KEY} ${PROMPT}`, { status: 502 }) }),
  )
  assert.match(output, /probe <- 502 marker=null/)
  assert.deepEqual(leaks(output), [])
})
