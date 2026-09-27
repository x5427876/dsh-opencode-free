// Opt-in: sends one short anonymous request per selected free model.
// Run after building: node scripts/test-live.mjs [model-id ...]
import { zenProvider } from '../lib/zen-provider.js'

const provider = zenProvider()
const requested = process.argv.slice(2)
const available = provider.getModels()
if (requested.some((id) => !available.some((model) => model.id === id))) {
  throw new Error('Only model IDs from the free catalogue are allowed')
}
const models = available.filter((model) => !requested.length || requested.includes(model.id))
if (!models.length) throw new Error('No free models available')

for (const model of models) {
  let status
  let errorType
  try {
    const result = await provider.streamSimple(model, {
      messages: [{ role: 'user', content: 'Reply with OK only.', timestamp: Date.now() }],
    }, {
      apiKey: 'public',
      maxRetries: 0,
      maxTokens: 512, // reasoning models can spend 64+ tokens thinking before any text
      signal: AbortSignal.timeout(30000),
      fetch: async (...args) => {
        const response = await fetch(...args)
        status = response.status
        if (!response.ok) {
          const body = await response.clone().json().catch(() => ({}))
          const kind = body.error?.type ?? body.type
          if (typeof kind === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(kind)) errorType = kind
        }
        return response
      },
    }).result()
    const replied = result.stopReason !== 'error' && result.content.some(
      (part) => part.type === 'text' && part.text.trim(),
    )
    console.log(JSON.stringify({ model: model.id, status, errorType, replied }))
    if (!replied) process.exitCode = 1
  } catch {
    console.log(JSON.stringify({ model: model.id, status, errorType, replied: false, failed: true }))
    process.exitCode = 1
  }
}
