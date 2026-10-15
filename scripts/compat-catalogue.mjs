// Acceptance targets are independent of the plugin's current catalogue (ADR 0004).
import { fetchSection } from '../lib/catalog.js'
import { builtinFreeModels, fetchZenModelIds } from '../lib/zen-provider.js'

export const OFFICIAL_MODELS = 'https://opencode.ai/inference/v1/models'
export const OFFICIAL_DOCS = 'https://opencode.ai/v2/docs/console/models/'
const SUPPLEMENT = 'https://models.dev/api.json'

const textOf = html => html.replace(/<[^>]*>/g, '').replace(/&(?:nbsp|amp|lt|gt|quot);/g, entity => ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' })[entity]).replace(/\s+/g, ' ').trim()
const labelOf = name => name.replace(/\s+\([^)]*\).*$/, '').toLowerCase()

function table(html, section, expected) {
  const start = html.indexOf(`id="${section}"`)
  const content = start < 0 ? '' : html.slice(start).split(/<h2\b/)[0]
  const body = /<table\b[^>]*>([\s\S]*?)<\/table>/.exec(content)?.[1]
  if (!body) throw new Error('official documentation table missing')
  const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(row => [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map(cell => textOf(cell[1])))
  if (JSON.stringify(rows[0]) !== JSON.stringify(expected) || rows.length < 2 || rows.some(row => row.length !== expected.length)) throw new Error('official documentation table schema changed')
  return rows.slice(1)
}

function classify(zenIds, html) {
  const endpoints = table(html, 'endpoints', ['Model', 'Model ID', 'Endpoint', 'AI SDK Package'])
  const pricing = table(html, 'pricing', ['Model', 'Input', 'Output', 'Cached Read', 'Cached Write'])
  const targets = [], excluded = [], unresolved = []
  for (const id of zenIds) {
    const matches = endpoints.filter(row => row[1] === id)
    if (matches.length !== 1) { unresolved.push({ id, reason: 'official endpoint missing or ambiguous' }); continue }
    const [name, , endpoint] = matches[0]
    const rates = pricing.filter(row => labelOf(row[0]) === labelOf(name))
    if (rates.length === 0) { unresolved.push({ id, reason: 'official price missing' }); continue }
    const free = rates.map(row => row.slice(1).every(value => value === 'Free' || value === '-') && row[1] === 'Free' && row[2] === 'Free')
    const paid = rates.every(row => row.slice(1).some(value => /^\$\d/.test(value)))
    if (paid && !free.some(Boolean)) { excluded.push({ id, reason: 'paid', source: OFFICIAL_DOCS }); continue }
    if (!free.every(Boolean)) { unresolved.push({ id, reason: 'official price ambiguous' }); continue }
    let url
    try { url = new URL(endpoint) } catch { unresolved.push({ id, reason: 'official endpoint invalid' }); continue }
    if (url.origin !== 'https://opencode.ai' || !url.pathname.startsWith('/inference/v1/')) { unresolved.push({ id, reason: 'official endpoint invalid' }); continue }
    if (url.pathname === '/inference/v1/systemone') { excluded.push({ id, reason: 'non-conversational', source: OFFICIAL_DOCS }); continue }
    const api = url.pathname === '/inference/v1/responses' ? 'openai-responses' : url.pathname === '/inference/v1/chat/completions' ? 'openai-completions' : null
    targets.push({ id, api, endpoint })
  }
  return { targets, excluded, unresolved }
}

export async function fetchCompatCatalogue({ fetchImpl = fetch, now = () => new Date() } = {}) {
  const results = await Promise.allSettled([
    fetchZenModelIds(fetchImpl, AbortSignal.timeout(15000)),
    (async () => {
      const response = await fetchImpl(OFFICIAL_DOCS, { signal: AbortSignal.timeout(30000) })
      if (!response.ok) throw new Error(`official documentation HTTP ${response.status}`)
      return await response.text()
    })(),
    fetchSection({ fetchImpl, timeoutMs: 30000 }),
  ])
  const [list, docs, supplement] = results
  if (list.status !== 'fulfilled' || list.value === null) throw new Error('official model list unavailable')
  if (docs.status !== 'fulfilled') throw new Error('official model documentation unavailable')
  const zenIds = [...new Set(list.value)]
  const { targets, excluded, unresolved } = classify(zenIds, docs.value)
  const supplementary = supplement.status === 'fulfilled' && supplement.value.kind === 'ok'
  const at = now().toISOString()
  return {
    zenIds, targets,
    modelsDev: supplementary ? supplement.value.section : {},
    builtinIds: builtinFreeModels().map(model => model.id),
    selection: { excluded, unresolved, targets: targets.map(model => model.id), sources: [
      { url: OFFICIAL_MODELS, at, status: 'ok' },
      { url: OFFICIAL_DOCS, at, status: 'ok' },
      { url: SUPPLEMENT, at, status: supplementary ? 'ok' : 'unavailable' },
    ] },
  }
}
