// Acceptance targets come from the official model list alone, read by code that is
// independent of the plugin's catalogue (ADR 0004, ADR 0005). The documentation
// page is only a cross-check: disagreement is a warning, never a target.
import { createHash } from 'node:crypto'
import { OPENCODE_USER_AGENT } from '../lib/zen-provider.js'

export const OFFICIAL_MODELS = 'https://opencode.ai/inference/v1/models'
export const OFFICIAL_DOCS = 'https://opencode.ai/v2/docs/console/models/'

/** Official `api` keys the plugin can drive, mapped to its transport names. */
const TRANSPORTS = { 'chat-completions': 'openai-completions', responses: 'openai-responses' }

async function fetchOfficialEntries(fetchImpl) {
  const response = await fetchImpl(OFFICIAL_MODELS, {
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Bearer public', 'User-Agent': OPENCODE_USER_AGENT, 'x-opencode-client': 'cli' },
  })
  if (!response.ok) throw new Error('official model list unavailable')
  const body = await response.json()
  const entries = body?.data
  if (!Array.isArray(entries) || entries.some(entry => typeof entry?.id !== 'string' || !entry.id.trim() || entry.id !== entry.id.trim())) throw new Error('official model list schema changed')
  return entries
}

const rate = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null)

/** One official entry → free target, paid/non-conversational exclusion, or an unresolved answer. */
function classifyEntry(entry) {
  if (entry.type !== 'chat') return { excluded: { id: entry.id, reason: 'non-conversational', source: OFFICIAL_MODELS } }
  const text = entry.cost?.text
  const required = [rate(text?.input?.price), rate(text?.output?.price)]
  const cache = [text?.input?.cache?.read, text?.input?.cache?.write].filter(value => value !== undefined).map(rate)
  if (required.includes(null) || cache.includes(null)) return { unresolved: { id: entry.id, reason: 'official price missing' } }
  if ([...required, ...cache].some(value => value > 0)) return { excluded: { id: entry.id, reason: 'paid', source: OFFICIAL_MODELS } }
  const api = entry.api ?? {}
  const key = Object.keys(TRANSPORTS).find(name => api[name] !== undefined)
  const levels = entry.capabilities?.reasoning?.effort
  return {
    target: {
      id: entry.id,
      api: key === undefined ? null : TRANSPORTS[key],
      endpoint: key === undefined ? null : api[key]?.base_url ?? null,
      efforts: Array.isArray(levels) ? levels.filter(level => typeof level === 'string') : undefined,
    },
  }
}

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

/** Ids the documentation page prices at zero for input and output. */
function docsFreeIds(html) {
  const endpoints = table(html, 'endpoints', ['Model', 'Model ID', 'Endpoint', 'AI SDK Package'])
  const pricing = table(html, 'pricing', ['Model', 'Input', 'Output', 'Cached Read', 'Cached Write'])
  const free = new Set(pricing.filter(row => row[1] === 'Free' && row[2] === 'Free').map(row => labelOf(row[0])))
  return new Set(endpoints.filter(row => free.has(labelOf(row[0]))).map(row => row[1]))
}

/** Warnings where the documentation page and the official list disagree on what is free. */
function crossCheck(html, freeIds) {
  const docs = docsFreeIds(html)
  const warnings = []
  const inDocsOnly = [...docs].filter(id => !freeIds.has(id)).sort()
  const inListOnly = [...freeIds].filter(id => !docs.has(id)).sort()
  if (inDocsOnly.length > 0) warnings.push(`documentation lists as free, official list does not: ${inDocsOnly.join(', ')}`)
  if (inListOnly.length > 0) warnings.push(`official list has as free, documentation does not: ${inListOnly.join(', ')}`)
  return warnings
}

export async function fetchCompatCatalogue({ fetchImpl = fetch, now = () => new Date() } = {}) {
  const entries = await fetchOfficialEntries(fetchImpl)
  const at = now().toISOString()
  const targets = [], excluded = [], unresolved = []
  for (const entry of new Map(entries.map(entry => [entry.id, entry])).values()) {
    const result = classifyEntry(entry)
    if (result.target) targets.push(result.target)
    else if (result.excluded) excluded.push(result.excluded)
    else unresolved.push(result.unresolved)
  }
  const free = targets.map(target => target.id).sort()
  // Volatile fields (`created`) are left out, so the digest names the free set itself.
  const digest = createHash('sha256').update(JSON.stringify(targets.map(target => entries.find(entry => entry.id === target.id)).sort((a, b) => (a.id < b.id ? -1 : 1)).map(({ id, cost, api }) => ({ id, cost, api: Object.keys(api ?? {}).sort() })))).digest('hex')
  const warnings = []
  let docsStatus = 'ok'
  try {
    const response = await fetchImpl(OFFICIAL_DOCS, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    warnings.push(...crossCheck(await response.text(), new Set(free)))
  } catch (error) {
    docsStatus = 'unavailable'
    warnings.push(`documentation cross-check unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  return {
    zenIds: [...new Set(entries.map(entry => entry.id))],
    targets,
    selection: {
      excluded,
      unresolved,
      targets: free,
      warnings,
      snapshot: { at, total: entries.length, free, digest },
      sources: [
        { url: OFFICIAL_MODELS, at, status: 'ok' },
        { url: OFFICIAL_DOCS, at, status: docsStatus },
      ],
    },
  }
}
