import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import {
  BASE_URL,
  PROVIDER_ID,
  STATIC_ZEN_HEADERS,
  anonGateMarker,
  classifyZenFailure,
  describeTransportCause,
  fetchZenModelIds,
  isModelUnavailableFailure,
  OPENCODE_USER_AGENT,
  ZEN_IDENTITY_HEADERS,
  applyZenHeadersToNodeHeaders,
  applyZenIdentity,
  PROBE_MAX_TOKENS,
  patchNodeHttpForZen,
  probeModel,
  ZEN_FAILURE_GUIDANCE,
  freeModels,
  isEncryptedContentError,
  requestHeader,
  resolveZenApiKey,
  sessionHeader,
  stripStaleReasoning,
  swapCompactionPrompt,
} from '../src/zen-provider.ts'

/** Header lookup that survives Headers, plain objects and header arrays. */
function readNodeHeader(headers, name) {
  const want = String(name).toLowerCase()
  if (headers === null || headers === undefined) return undefined
  if (typeof headers.get === 'function') return headers.get(want)
  if (Array.isArray(headers)) {
    const hit = headers.find(([k]) => String(k).toLowerCase() === want)
    return hit ? hit[1] : undefined
  }
  const entry = Object.entries(headers).find(([k]) => k.toLowerCase() === want)
  return entry ? entry[1] : undefined
}

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)))
const libUrl = new URL('../lib/', import.meta.url)
const hostFiles = (await readdir(libUrl)).filter((f) => f.endsWith('.js')).sort()
const host = (await Promise.all(hostFiles.map((f) => readFile(new URL(f, libUrl), 'utf8')))).join('\n')
// The SOURCE, not the build artifact: `npx tsx --test tests/*.test.mjs` is the
// highest-frequency inner loop and it does not run `pretest`, so importing lib/
// here silently tested a stale build. `host` above still scans
// lib/ on purpose — verifying the shipped artifact carries the identity is a
// separate, legitimate check.
const plugin = await import('../src/index.ts')
const { PiAiAdapter } = await import('@deepseek-ai/dsh-llm-pi-ai')
const { resolveRetryPolicy } = await import('@deepseek-ai/dsh-llm')
const { normalizeContext, getCurrentSystemPrompt } = await import('@earendil-works/pi-ai')

// HERMETIC SANDBOX — installed before any test body runs.
//
// `apply()` builds a Catalog whose `cachePath()` resolves from `process.env.DSH_HOME`
// and otherwise falls back to `homedir()/.dsh`; its `fetchImpl` reaches the live
// `globalThis.fetch`. Without this block these 26 cases read AND WRITE the
// developer's real ~/.dsh/dsh-opencode-free/catalog.json, and really request
// models.dev — while README promises "The unit tests … do not use the network".
// model-visibility.test.mjs already did exactly this
// correctly, so the omission was an oversight rather than a design choice.
//
// Both bindings are restored in `after`, so nothing leaks into a sibling file
// (node:test gives each file its own process, but the restore is still the
// honest contract and costs nothing).
const sandboxHome = await mkdtemp(join(tmpdir(), 'opf-hermetic-'))
const realDshHome = process.env.DSH_HOME
const realFetch = globalThis.fetch
process.env.DSH_HOME = sandboxHome
globalThis.fetch = async () => new Response('offline in unit tests', { status: 503 })
after(async () => {
  globalThis.fetch = realFetch
  if (realDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = realDshHome
  await rm(sandboxHome, { recursive: true, force: true })
})

test('targets the DSH 0.2.0-rc.2 contracts', async () => {
  // The version the plugin sends upstream must be the one package.json declares,
  // and the install guide must name that same version. Nothing here requires a
  // bump: merging unreleased work and publishing a release are separate steps,
  // and a changelog may LEAD with `## [Unreleased]` until one happens.
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'package.json carries a plain semver')
  const v = pkg.version
  const agentsDoc = await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8')
  assert.ok(agentsDoc.includes(`v${v}`), `AGENTS.md pins v${v}`)
  // The install guide must offer the version this package declares, from the
  // registry the package is published to. It used to be the opposite assertion:
  // a fork that is not on npm had to REFUSE the registry command, because
  // `dsh-opencode-free@<version>` there resolves to someone else's build.
  // Upstream, the registry command is the only correct install, so the invariant
  // flips to its presence and to naming this exact version.
  assert.ok(
    /^\s*dsh plugin .*add\s+dsh-opencode-free@/m.test(agentsDoc),
    'AGENTS.md installs from the registry: `dsh plugin … add dsh-opencode-free@<version>`',
  )
  assert.ok(
    agentsDoc.includes(`dsh-opencode-free@${v}`),
    `AGENTS.md installs ${v} specifically, not some other version`,
  )
  const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  // The changelog must account for whatever `package.json` says, and it may carry
  // an `[Unreleased]` section above it. Presence alone is not enough — a released
  // section further down the file does not make the shipped version current — so
  // POSITION is checked against whichever the file leads with.
  const firstSection = changelog.match(/^## \[(Unreleased|[^\]]+)\]/m)
  assert.ok(firstSection !== null, 'the changelog has a leading version section')
  const lead = firstSection === null ? '' : firstSection[1]
  assert.ok(
    lead === 'Unreleased' || lead === v,
    `the changelog leads with ${lead}, which is neither [Unreleased] nor the shipped ${v}`,
  )
  if (lead === v) {
    assert.ok(
      changelog.includes(`## [${v}]`),
      `the changelog says it leads with ${v} but has no ${v} section`,
    )
  }
  // Both User-Agent strings must derive from ONE definition. The provider's
  // was a hardcoded second copy and had already drifted to 0.2.0 on a branch
  // whose package.json said 0.3.0.
  const providerSrc = await readFile(new URL('../src/zen-provider.ts', import.meta.url), 'utf8')
  assert.ok(
    providerSrc.includes(`PLUGIN_VERSION = "${v}"`),
    `PLUGIN_VERSION is in step with package.json (src/zen-provider.ts)`,
  )
  assert.ok(
    providerSrc.includes('dsh-opencode-free/${PLUGIN_VERSION}'),
    'the provider User-Agent derives its version rather than repeating it',
  )
  const catalogSrc = await readFile(new URL('../src/catalog.ts', import.meta.url), 'utf8')
  assert.ok(
    catalogSrc.includes('dsh-opencode-free/${PLUGIN_VERSION}'),
    'and so does the models.dev User-Agent — one definition, both strings',
  )
  // Every scripts/ path referenced from committed prose must be a real tracked
  // file: probe-ab.mjs was cited from four committed places (source comment,
  // test-live.mjs, ADR 0002, CHANGELOG 0.3.1) while being untracked, so the only
  // reproducible evidence for PROBE_MAX_TOKENS lived outside the repository
  //.
  for (const doc of [
    await readFile(new URL('../README.md', import.meta.url), 'utf8'),
    await readFile(new URL('../src/zen-provider.ts', import.meta.url), 'utf8'),
    await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8'),
  ]) {
    for (const m of doc.matchAll(/scripts[\/]([a-z-]+\.(?:mjs|sh))/g)) {
      const tracked = execFileSync('git', ['ls-files', '--error-unmatch', `scripts/${m[1]}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      assert.ok(
        tracked.includes(m[1]),
        `scripts/${m[1]} is referenced from committed prose but is not tracked`,
      )
    }
  }

  const reverify = await readFile(new URL('../scripts/reverify.sh', import.meta.url), 'utf8')
  // The prefix that a suffix-only assertion let drift still has to be pinned.
  assert.ok(
    reverify.includes(OPENCODE_USER_AGENT.split(' dsh-opencode-free/')[0]),
    'scripts/reverify.sh keeps the provider User-Agent prefix in step with src/zen-provider.ts',
  )
  for (const [name, version] of Object.entries(pkg.peerDependencies)) {
    if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(version, '0.2.0-rc.2', name)
  }
  assert.equal(pkg.peerDependencies['@earendil-works/pi-ai'], '^0.87.1')
  assert.equal(pkg.peerDependencies['react'], undefined)
  assert.deepEqual(pkg.dsh, {
    bundle: { patch: './cordis.patch.yml' },
    client: {
      inject: [
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-locale',
        '@deepseek-ai/dsh-client-ui-slots',
        '@deepseek-ai/dsh-client-ui-settings',
      ],
      platform: 'web',
    },
  })
  assert.equal(pkg.exports['./client'], './src/client.js')
})

test('registers opencode-zen-free through the PiAiAdapter seam', async () => {
  const provider = plugin.zenProvider(
    () => 'test-session',
    () => undefined,
  )
  assert.equal(provider.id, 'opencode-zen-free')
  const models = provider.getModels()
  assert.ok(models.length > 0, 'expected at least one free model')
  for (const m of models) {
    assert.equal(m.provider, PROVIDER_ID)
    assert.ok(m.baseUrl?.includes('opencode.ai/zen'), m.id)
    assert.ok(
      Object.values(m.cost).every((c) => c === 0),
      m.id,
    )
  }
  const profile = Object.freeze({
    provider: PROVIDER_ID,
    displayName: 'OpenCode Zen Free',
    piProvider: provider,
    modelErrors: new Map(),
    configuredMaxTokens: new Map(),
    streamIdleTimeoutMs: 600000,
    maxRequestImageBytes: 20 * 1024 * 1024,
    requestImagePixelBudget: 2048 * 2048,
    requestImageMaxBytes: 1024 * 1024,
    retryPolicy: resolveRetryPolicy(undefined, 'compatibility test'),
    cacheRetention: 'short',
    transport: 'sse',
  })
  const registered = []
  // `apply()` also wires the catalogue routes through a `webServer` inject. This
  // stub keeps it on its normal path — and its "webServer wiring failed"
  // degradation warn quiet — without pretending the routes are exercised here:
  // tests/model-visibility.test.mjs is where their contract is asserted.
  const fakeCtx = {
    llm: {
      registerAdapter: (routes, adapter) => {
        registered.push([routes, adapter])
      },
    },
    get: () => undefined,
    inject: (requires, applyChild) => {
      if (!requires.includes('webServer')) return
      applyChild({ webServer: { register: () => () => {} }, effect: (fn) => fn() })
    },
    effect: (fn) => fn(),
  }
  plugin.apply(fakeCtx, {})
  assert.deepEqual(registered[0][0], [PROVIDER_ID])
  assert.ok(registered[0][1] instanceof PiAiAdapter)
  const advertised = await registered[0][1].listModels(PROVIDER_ID)
  // The same SET: the adapter offers exactly the models the provider does.
  // Order is asserted separately below, because this test builds a bare
  // provider with no catalogue behind it — in the real wiring both lists come
  // from the catalogue, which owns the order.
  assert.deepEqual(
    advertised
      .map((m) => m.id)
      .slice()
      .sort(),
    models
      .map((m) => m.id)
      .slice()
      .sort(),
    'the adapter offers exactly the models the provider does',
  )
  const ids = advertised.map((m) => m.id)
  assert.deepEqual(ids, ids.slice().sort(), 'and the advertised list is alphabetical by id')
})

test('session/request headers are structurally valid OpenCode ids', () => {
  assert.match(sessionHeader('abc'), /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  assert.equal(sessionHeader('abc'), sessionHeader('abc'), 'stable per session')
  assert.notEqual(sessionHeader('a'), sessionHeader('b'), 'distinct between sessions')
  assert.match(requestHeader(), /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
})

test('encrypted-content retry triggers only on the 400 rotation signal', () => {
  assert.equal(
    isEncryptedContentError(400, 'reasoning `encrypted_content` was not issued to this caller'),
    true,
  )
  assert.equal(isEncryptedContentError(400, 'encrypted content could not be verified'), true)
  assert.equal(isEncryptedContentError(403, 'reasoning `encrypted_content` was not issued'), false)
  assert.equal(isEncryptedContentError(400, 'FreeTierError'), false)
  const stripped = stripStaleReasoning({
    input: [
      { type: 'reasoning', id: 'rs_1' },
      { type: 'function_call', id: 'fc_1', call_id: 'c1' },
      { type: 'message', id: 'm1' },
    ],
  })
  assert.deepEqual(stripped, {
    input: [
      { type: 'function_call', call_id: 'c1' },
      { type: 'message', id: 'm1' },
    ],
  })
  assert.equal(stripStaleReasoning({ input: [{ type: 'message' }] }), null)
})

test('compaction swap only rewrites short anonymous summarization prompts', async () => {
  const piPrompt = 'You are a context summarization assistant. Summarize.'
  const swapped = swapCompactionPrompt({ systemPrompt: piPrompt, messages: [], tools: [] }, 'public')
  assert.ok(swapped.systemPrompt.includes('context summarization agent'))
  assert.equal(
    swapCompactionPrompt({ systemPrompt: piPrompt, messages: [] }, 'sk-live-key').systemPrompt,
    piPrompt,
  )
  assert.equal(
    swapCompactionPrompt({ systemPrompt: 'ordinary chat', messages: [] }, 'public').systemPrompt,
    'ordinary chat',
  )
  // pi-ai 0.87 providers receive a TranscriptContext: the prompt lives in system messages.
  const user = { role: 'user', content: 'summarize', timestamp: 1 }
  const t = swapCompactionPrompt(normalizeContext({ systemPrompt: piPrompt, messages: [user] }), 'public')
  assert.match(getCurrentSystemPrompt(t.messages), /context summarization agent/)
  const chat = normalizeContext({ systemPrompt: 'ordinary chat', messages: [user] })
  assert.equal(swapCompactionPrompt(chat, 'public'), chat)
  assert.equal((await resolveZenApiKey({ env: async () => undefined, configKey: '  ' })).apiKey, 'public')
  assert.equal(
    (await resolveZenApiKey({ env: async () => 'env-key', configKey: undefined })).apiKey,
    'env-key',
  )
  assert.equal(
    (await resolveZenApiKey({ env: async () => undefined, configKey: 'cfg-key' })).apiKey,
    'cfg-key',
  )
})

test('optional keys resolve config before env and send public when neither exists', async () => {
  const p = plugin.zenProvider()
  const model = p.getModels()[0]
  const context = { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }
  for (const [configKey, envKey, expected] of [
    [undefined, undefined, 'public'],
    ['  ', '  ', 'public'],
    [undefined, 'env-test-key', 'env-test-key'],
    ['config-test-key', 'env-test-key', 'config-test-key'],
  ]) {
    const { apiKey } = await resolveZenApiKey({ configKey, env: async () => envKey })
    let authorization
    await p
      .streamSimple(model, context, {
        apiKey,
        maxRetries: 0,
        fetch: async (_url, init) => {
          authorization = new Headers(init.headers).get('authorization')
          return new Response('{}', { status: 403, headers: { 'Content-Type': 'application/json' } })
        },
      })
      .result()
    assert.equal(authorization, `Bearer ${expected}`)
  }
})

test('a refusal names which of the three gate conditions answered', () => {
  // Three rounds of diagnosis on the 2026-09-30 failures stalled on exactly one
  // question: `anon-gated` folds FreeTierError / MissingSessionID / "only
  // OpenCode" into one code, and an `inconclusive` is never persisted — so the
  // body, the only place the answer exists, was gone before anyone could ask.
  // The folded code stays (none of the three is a verdict about the model); the
  // marker rides alongside it.
  const freetier =
    '{"type":"error","error":{"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode"}}'
  const nosession = '{"type":"error","error":{"type":"MissingSessionID","message":"..."}}'
  const onlyoc =
    '{"type":"error","error":{"type":"ForbiddenError","message":"this endpoint can only be used by the OpenCode CLI"}}'
  // Each marker must agree with the class it explains.
  assert.equal(anonGateMarker(freetier), 'FreeTierError')
  assert.equal(anonGateMarker(nosession), 'MissingSessionID')
  assert.equal(anonGateMarker(onlyoc), 'opencode-only')
  for (const body of [freetier, nosession, onlyoc]) {
    assert.equal(classifyZenFailure(403, body), 'anon-gated', 'every marker is an anon-gated refusal')
  }
  // Pattern order decides, so the marker always names the branch that decided.
  assert.equal(anonGateMarker(freetier + nosession), 'FreeTierError', 'first branch in pattern order wins')
  // A body that is not a gate refusal has no marker — the panel must not invent one.
  assert.equal(anonGateMarker('{"type":"error","error":{"type":"FreeUsageLimitError"}}'), null)
  assert.equal(anonGateMarker('something entirely new'), null)
  assert.equal(anonGateMarker(undefined), null, 'a missing body is not a marker')
})

test('upstream failures classify to actionable guidance (recorded bodies)', () => {
  // 403 body captured live 2026-09-22: the exact upstream verdict on this egress.
  assert.equal(
    classifyZenFailure(
      403,
      '{"type":"error","error":{"type":"FreeTierError","message":"Error from provider (Console): OpenCode\'s free tier can only be used from within OpenCode"}}',
    ),
    'anon-gated',
  )
  // MissingSessionID shape per opencodex provider docs.
  assert.equal(
    classifyZenFailure(
      400,
      '{"type":"error","error":{"type":"MissingSessionID","message":"OpenCode\'s free tier can only be used in OpenCode"}}',
    ),
    'anon-gated',
  )
  // 429 FreeUsageLimitError per opencode#42500.
  assert.equal(
    classifyZenFailure(429, '{"type":"error","error":{"type":"FreeUsageLimitError"}}'),
    'quota-exhausted',
  )
  assert.equal(
    classifyZenFailure(401, '{"error":{"type":"authentication_error","message":"invalid x-api-key"}}'),
    'bad-key',
  )
  assert.equal(classifyZenFailure(500, 'internal error'), 'unknown')
  assert.equal(classifyZenFailure(403, 'something entirely new'), 'unknown')
  // Guidance carries the actionable content, not just a label.
  assert.match(ZEN_FAILURE_GUIDANCE['anon-gated'], /匿名額度/)
  assert.match(ZEN_FAILURE_GUIDANCE['anon-gated'], /OPENCODE_API_KEY/)
  assert.doesNotMatch(ZEN_FAILURE_GUIDANCE['anon-gated'], /非插件問題|即解|出口 IP/)
  assert.match(ZEN_FAILURE_GUIDANCE['quota-exhausted'], /OPENCODE_API_KEY/)
  assert.match(ZEN_FAILURE_GUIDANCE['bad-key'], /key/)
})

test('catalogue refresh intersects live ids and survives failure', async () => {
  const p = plugin.zenProvider(
    () => undefined,
    () => undefined,
  )
  const before = p.getModels().map((m) => m.id)
  assert.ok(before.length > 0)
  const known = before[0]
  const ctx = (fetch, publish) => ({
    stored: undefined,
    allowNetwork: true,
    signal: AbortSignal.timeout(5000),
    publish,
  })
  const origFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => Response.json({ data: [{ id: known }, { id: 'gpt-6-astra' }] })
    let update = null
    await p.refreshModels(
      ctx(null, async (u) => {
        update = u.update
        return true
      }),
    )
    update()
    assert.deepEqual(
      p.getModels().map((m) => m.id),
      [known],
    )
    globalThis.fetch = async () => {
      throw new Error('offline')
    }
    await assert.rejects(p.refreshModels(ctx(null, async () => true)))
    assert.deepEqual(
      p.getModels().map((m) => m.id),
      [known],
    )
    let called = false
    globalThis.fetch = async () => {
      called = true
      throw new Error('must not fetch')
    }
    await p.refreshModels({ ...ctx(null, async () => true), allowNetwork: false })
    assert.equal(called, false)
  } finally {
    globalThis.fetch = origFetch
  }
})

test('request path surfaces guidance on gate failures (fixture transport)', async () => {
  const p = plugin.zenProvider(
    () => 's',
    () => undefined,
  )
  const model = p.getModels()[0]
  const ctx = { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }
  const gate = (status, body) => async () =>
    new Response(body, { status, headers: { 'Content-Type': 'application/json' } })
  // pi-ai resolves transport failures (stopReason error), it does not reject.
  const r403 = await p
    .streamSimple(model, ctx, {
      fetch: gate(
        403,
        '{"type":"error","error":{"type":"FreeTierError","message":"only be used from within OpenCode"}}',
      ),
      maxRetries: 0,
    })
    .result()
  assert.equal(r403.stopReason, 'error')
  assert.match(r403.errorMessage, /匿名額度/)
  const r429 = await p
    .streamSimple(model, ctx, { fetch: gate(429, '{"error":{"type":"FreeUsageLimitError"}}'), maxRetries: 0 })
    .result()
  assert.match(r429.errorMessage, /重置/)
  const r401 = await p
    .streamSimple(model, ctx, {
      fetch: gate(401, '{"error":{"message":"invalid x-api-key"}}'),
      maxRetries: 0,
    })
    .result()
  assert.match(r401.errorMessage, /key 無效/)
  const rUnknown = await p
    .streamSimple(model, ctx, { fetch: gate(403, 'something entirely new'), maxRetries: 0 })
    .result()
  assert.match(rUnknown.errorMessage, /403/)
  assert.doesNotMatch(rUnknown.errorMessage, /匿名額度/)
  // Responses transport formats failures differently (live-observed shape).
  const responsesModel = p.getModels().find((m) => m.api === 'openai-responses') ?? model
  const rResp = await p
    .streamSimple(responsesModel, ctx, {
      fetch: gate(403, '{"type":"FreeTierError","message":"only be used from within OpenCode"}}'),
      maxRetries: 0,
    })
    .result()
  assert.match(rResp.errorMessage, /匿名額度/)
  // The DSH session persists the streamed error event (its toStreamChunks
  // translates it to a finish chunk), not result(): iterate raw events.
  const seen = []
  for await (const ev of p.streamSimple(responsesModel, ctx, {
    fetch: gate(403, '{"type":"FreeTierError","message":"only be used from within OpenCode"}}'),
    maxRetries: 0,
  })) {
    seen.push(ev)
  }
  const errEv = seen.find((ev) => ev?.type === 'error' && typeof ev?.error?.errorMessage === 'string')
  assert.ok(errEv, 'expected a raw error event in the stream')
  assert.match(errEv.error.errorMessage, /匿名額度/)
})

test('anonymous requests satisfy the read+bash tool gate and map pwsh back', async () => {
  // Live replay 2026-09-27: Zen's anonymous tier 403s unless tools include
  // `read` and `bash` by name; DSH on Windows exposes `pwsh` instead.
  const p = plugin.zenProvider(
    () => 's',
    () => undefined,
  )
  const model = p.getModels().find((m) => m.api === 'openai-responses')
  const tool = (name) => ({ name, description: name, parameters: { type: 'object', properties: {} } })
  const ctx = {
    tools: [tool('read'), tool('pwsh')],
    messages: [
      { role: 'user', content: 'ls', timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_0|fc_0', name: 'pwsh', arguments: {} }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'toolUse',
        timestamp: 2,
      },
      {
        role: 'toolResult',
        toolCallId: 'call_0|fc_0',
        toolName: 'pwsh',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
        timestamp: 3,
      },
    ],
  }
  const sse = [
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'bash', arguments: '' },
    },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{}' },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'bash', arguments: '{}' },
    },
    {
      type: 'response.completed',
      response: {
        id: 'r1',
        status: 'completed',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]
    .map((e) => `data: ${JSON.stringify(e)}\n\n`)
    .join('')
  const run = async (context, apiKey) => {
    let body
    const events = []
    const s = p.streamSimple(model, context, {
      apiKey,
      maxRetries: 0,
      fetch: async (_url, init) => {
        body = JSON.parse(init.body)
        return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } })
      },
    })
    for await (const ev of s) events.push(ev)
    return { body, events, result: await s.result() }
  }
  const names = (body) => body.tools.map((t) => t.name).sort()

  // DSH (Models.streamSimple) hands providers a normalized transcript; direct callers may pass a legacy Context.
  for (const shape of [(c) => c, normalizeContext]) {
    const anon = await run(shape(ctx), 'public')
    assert.deepEqual(names(anon.body), ['bash', 'read'])
    assert.ok(anon.body.input.some((i) => i.type === 'function_call' && i.name === 'bash'))
    assert.ok(!JSON.stringify(anon.body.input).includes('"pwsh"'))
    assert.equal(anon.result.content.find((c) => c.type === 'toolCall').name, 'pwsh')
    const end = anon.events.find((ev) => ev.type === 'toolcall_end')
    assert.equal(end.toolCall.name, 'pwsh')
    assert.equal(ctx.tools[1].name, 'pwsh', 'caller context must not be mutated')

    const keyed = await run(shape(ctx), 'sk-test-key')
    assert.deepEqual(names(keyed.body), ['pwsh', 'read'])

    const bare = await run(shape({ messages: [{ role: 'user', content: 'title', timestamp: 1 }] }), 'public')
    assert.deepEqual(names(bare.body), ['bash', 'read'])
  }
})

test('free catalogue is non-empty and host output carries the Zen identity', () => {
  assert.ok(freeModels().length > 0)
  assert.match(host, /opencode-zen-free/)
  assert.match(host, /x-opencode-session/)
  assert.match(host, /registerAdapter/)
})

// ── availability probe (model-probe P5) ─────────────────────────────────────

/** A completions-shaped SSE reply with real text, so a probe reads `ok`. */
const okSse = [
  'data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}',
  'data: [DONE]',
  '',
].join('\n\n')

const sseReply = () => new Response(okSse, { headers: { 'Content-Type': 'text/event-stream' } })

test('GUARD: the probe request carries the read+bash gate, streams, and asks for enough tokens', async () => {
  // A tool-less probe 403s on EVERY model at the anonymous tier (measured
  // 2026-09-27), so a probe that skipped the tools would report the whole
  // catalogue dead.
  //
  // The budget is PROBE_MAX_TOKENS (1024), not the 512 this comment used to
  // claim. The value moved on 2026-09-30 after a live A/B (1024 vs 16, two runs
  // in agreement): a smaller ceiling does not make the expensive models cheaper,
  // it makes the two most expensive ones stop answering altogether. The old
  // ">= 512" assertion below could not have noticed, because 1024 passes it —
  // it is now an exact comparison against the constant, so a drift in either
  // direction is caught.
  const p = plugin.zenProvider(
    () => 'probe-session',
    () => undefined,
  )
  const model = p.getModels().find((m) => m.api === 'openai-completions')
  let body
  const outcome = await probeModel(model, {
    provider: p,
    apiKey: 'public',
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body)
      return sseReply()
    },
  })
  assert.equal(outcome.kind, 'ok')
  assert.deepEqual(body.tools.map((t) => t.function.name).sort(), ['bash', 'read'])
  assert.equal(body.stream, true)
  assert.equal(body.max_tokens, PROBE_MAX_TOKENS, `the probe budget must be the one constant, not a floor`)

  // The override exists for scripts/probe-ab.mjs to A/B the budget against the
  // live tier. Nothing pins it, so deleting the seam left every test green while
  // the A/B silently compared 1024 against 1024 and reported "no difference" —
  // the exact false conclusion docs/adr/0002 already records once (audit
  // 2026-09-30).
  let abBody
  await probeModel(model, {
    provider: p,
    apiKey: 'public',
    maxTokens: 77,
    fetchImpl: async (_url, init) => {
      abBody = JSON.parse(init.body)
      return sseReply()
    },
  })
  assert.equal(abBody.max_tokens, 77, 'a caller-supplied budget must reach the wire unchanged')
  assert.equal(body.model, model.id)

  // The usage the upstream reported rides along on an 'ok' outcome. It is
  // carried for measurement only — nothing in the round reads it — but it is the
  // only way to tell what a probe COSTS, and scripts/probe-ab.mjs gates on
  // usage.output. Deleting the field left every test green, so the A/B would have
  // silently reported n=0/0 and its failure would have been misread as "a small
  // budget is unsafe".
  assert.equal(outcome.usage?.output, 3, 'usage.output comes from the SSE usage block')
  assert.equal(outcome.usage?.input, 7, 'and usage.input with it')
})

test('a live-shaped 403 refusal carries the marker that explains it', async () => {
  // The seam the panel reads. The upstream body is the only place the three
  // anonymous-gate conditions are distinguishable, and an `inconclusive` is
  // never persisted — so before this, a refusal round left behind a code
  // (`anon-gated`) that named none of them, and three rounds of diagnosis
  // stalled on "which one was it?".
  const p = plugin.zenProvider(
    () => 'probe-session',
    () => undefined,
  )
  const model = p.getModels().find((m) => m.api === 'openai-completions')
  const body =
    '{"type":"error","error":{"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode"}}'
  const outcome = await probeModel(model, {
    provider: p,
    apiKey: 'public',
    fetchImpl: async () =>
      new Response(body, { status: 403, headers: { 'Content-Type': 'application/json' } }),
  })
  assert.equal(outcome.kind, 'inconclusive', 'a gate refusal is never a verdict about the model')
  assert.equal(outcome.code, 'anon-gated')
  assert.equal(outcome.http, 403)
  assert.equal(outcome.marker, 'FreeTierError', 'and it names which condition answered')
})

test('GUARD: the probe re-asserts its admission tools on the final payload', async () => {
  // The failure this exists for. Measured 2026-09-30 inside the DSH host: the
  // probe's outgoing body carried NO `tools`, and upstream answered
  // `403 FreeTierError: "OpenCode's free tier can only be used from within
  // OpenCode"` — the documented consequence of a tool-less request at this tier
  // (docs/reverse-engineering.md 8). The same code outside the host sent the
  // tools and was admitted, so the loss happens between the context gate and
  // the wire, somewhere this plugin does not own.
  //
  // The payload hook is the last boundary before the bytes leave, so the probe
  // guarantees its own admission there instead of trusting four layers above it.
  const p = plugin.zenProvider(
    () => 'probe-session',
    () => undefined,
  )
  const model = p.getModels().find((m) => m.api === 'openai-completions')
  // A provider that drops the tools on the way down — the host's observed shape.
  const lossy = {
    streamSimple: (m, context, options) => {
      const stripped = { ...context }
      delete stripped.tools
      return p.streamSimple(m, stripped, options)
    },
  }
  let body
  const outcome = await probeModel(model, {
    provider: lossy,
    apiKey: 'public',
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body)
      return sseReply()
    },
  })
  assert.equal(outcome.kind, 'ok', 'the probe still gets its answer')
  const names = (body.tools ?? []).map((t) => t.function?.name ?? t.name)
  assert.ok(
    names.includes('read') && names.includes('bash'),
    `admission tools must reach the wire even when a layer drops them, got ${JSON.stringify(names)}`,
  )
})

test('GUARD: a reasoning model that spends the budget thinking still counts as answered', async () => {
  // The reference implementation's issue #3010, reproduced: a reasoning model
  // can burn the whole token budget on chain-of-thought and return
  // finish_reason "length" with NO text — only a `thinking` part. That is a
  // working model, and reading it as "no reply" reported a healthy model as
  // failed. The free tier is mostly reasoning models, so this was not an edge
  // case: it was the common case.
  const p = plugin.zenProvider(
    () => 'probe-session',
    () => undefined,
  )
  const model = p.getModels().find((m) => m.api === 'openai-completions')
  const thinkingOnly = [
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"let me think about OK..."},"finish_reason":null}]}',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}',
    'data: [DONE]',
    '',
  ].join('\n\n')
  const outcome = await probeModel(model, {
    provider: p,
    apiKey: 'public',
    fetchImpl: async () => new Response(thinkingOnly, { headers: { 'Content-Type': 'text/event-stream' } }),
  })
  assert.equal(outcome.kind, 'ok', 'a thinking-only reply is a reply')
  // And the budget has to leave room for an answer at all: 512 was measured
  // against a model that thought for 60 tokens, not one that thinks like
  // muse-spark at xhigh. The reference implementation settled on 1024.
  let body
  await probeModel(model, {
    provider: p,
    apiKey: 'public',
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body)
      return sseReply()
    },
  })
  assert.ok(body.max_tokens >= 1024, `max_tokens was ${body.max_tokens}, want room for reasoning + an answer`)
})

test('GUARD: every probe in a round shares one session instead of minting a new one', async () => {
  // Zen accounts free-tier quota PER SESSION and routes a session to a sticky
  // backend. A probe that mints a fresh session per model therefore (a) burns
  // one bucket per model instead of one per round, which is how you talk
  // yourself into the very 429 you are probing for, and (b) measures different
  // backends, so the per-model latency the panel shows is partly a measurement
  // of backend selection rather than of the model.
  const p = plugin.zenProvider(
    () => undefined,
    () => undefined,
  ) // as index.ts wires it
  const model = p.getModels().find((m) => m.api === 'openai-completions')
  const seen = []
  for (let i = 0; i < 3; i += 1) {
    await probeModel(model, {
      provider: p,
      apiKey: 'public',
      fetchImpl: async (_url, init) => {
        seen.push(readNodeHeader(init.headers, 'x-opencode-session'))
        return sseReply()
      },
    })
  }
  assert.equal(seen.length, 3)
  const distinct = new Set(seen)
  assert.equal(
    distinct.size,
    1,
    `three probes produced ${distinct.size} sessions: ${[...distinct].join(', ')}`,
  )
  for (const value of seen) {
    assert.match(String(value), /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/, 'and the shared one is canonical')
  }
})

test("GUARD: the availability check is one cheap catalogue GET, in 9router's shape", async () => {
  // This is the request that decides availability, so its shape is a contract:
  // it must be free of inference quota, and it must carry the identity the
  // free tier accepts. Without `Bearer public` and a versioned opencode UA the
  // same GET answers 403 FreeTierError — which is how a cheap check turns into
  // a wrong one.
  const seen = []
  const ids = await fetchZenModelIds(async (url, init) => {
    seen.push({ url: String(url), init })
    return new Response(JSON.stringify({ data: [{ id: 'big-pickle' }, { id: 'space-bunny-free' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  assert.equal(seen.length, 1, 'one request, and it is a GET of the catalogue')
  assert.equal(seen[0].url, 'https://opencode.ai/zen/v1/models')
  assert.equal(seen[0].init.method, undefined, 'no body, no method override: a plain GET')
  const headers = readNodeHeader(seen[0].init.headers, 'authorization')
  assert.equal(headers, 'Bearer public', 'the free tier runs on the literal "public" key')
  assert.match(
    String(readNodeHeader(seen[0].init.headers, 'user-agent')),
    /^opencode\/1\.\d+\.\d+/,
    'versioned opencode UA',
  )
  assert.equal(readNodeHeader(seen[0].init.headers, 'x-opencode-client'), 'cli')
  assert.deepEqual([...ids], ['big-pickle', 'space-bunny-free'])
  // A failure must read as "unknown", never as "nothing is available": this
  // value narrows the catalogue, so an empty answer here would empty the picker.
  for (const bad of [
    async () => new Response('nope', { status: 403 }),
    async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    async () => new Response(JSON.stringify({ models: [{ id: 'big-pickle' }] }), { status: 200 }),
    async () => new Response('not json', { status: 200 }),
    async () => {
      throw new Error('socket died')
    },
  ]) {
    assert.equal(await fetchZenModelIds(bad), null, 'resolves null instead of narrowing')
  }
  // Non-string entries are not ids to gate on and must not become `undefined`.
  const mixed = await fetchZenModelIds(
    async () =>
      new Response(JSON.stringify({ data: [{ id: 'big-pickle' }, { id: 42 }, null, {}, { id: '' }] }), {
        status: 200,
      }),
  )
  assert.deepEqual([...mixed], ['big-pickle'])
})

test('GUARD: a model that only answers on another channel is alive, not dead', async () => {
  // The bug this whole change exists for. Our channel comes from the
  // models.dev record, and Zen publishes no way to look up which endpoint a
  // model is served on — 9router hard-codes it, we infer it. A wrong inference
  // is answered with "model not supported", the same sentence a dead model
  // produces, so one wrong guess did not report a routing mistake: it removed a
  // working model from the picker PERMANENTLY. A liveness check that can be
  // defeated by its own routing is not a liveness check.
  //
  // A stub prober, deliberately: this asserts the ROUTING DECISION, and
  // hand-writing fixtures for different SDK stream parsers would test the
  // SDKs instead. The error classification is covered by the real-wire tests
  // below.
  const model = { id: 'mystery-free', api: 'openai-completions' }
  const asked = []
  const provider = {
    streamSimple: (m) => {
      asked.push(m.api)
      return {
        result: async () =>
          m.api === 'openai-completions'
            ? { stopReason: 'error', content: [] } // refused here
            : { stopReason: 'stop', content: [{ type: 'text', text: 'OK' }] },
      }
    },
  }
  const outcome = await probeModel(model, { provider, apiKey: 'public' })
  assert.equal(outcome.kind, 'ok', 'a model alive on another channel is ok')
  assert.equal(asked[0], 'openai-completions', 'the inferred channel is tried first')
  assert.ok(asked.length >= 2, `an unanswered channel does not end the sweep (asked ${asked.length})`)
  assert.ok(new Set(asked).size === asked.length, 'no channel is asked twice')
  // A channel swap must not carry the previous channel's transport overrides.
  const swapped = asked.slice(1)
  assert.ok(swapped.length > 0 && !swapped.includes('openai-completions'))
})

test('GUARD: dead is only concluded after every channel has refused', async () => {
  // The other half of the guarantee: the retry must not become a loophole that
  // makes a genuinely gone model immortal. A refusal on every implemented
  // channel, then gone.
  const p = plugin.zenProvider(
    () => 'probe-session',
    () => undefined,
  )
  const model = p.getModels().find((m) => m.api === 'openai-completions')
  let calls = 0
  const outcome = await probeModel(model, {
    provider: p,
    apiKey: 'public',
    fetchImpl: async () => {
      calls += 1
      return new Response(JSON.stringify({ error: { message: 'model not found' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })
  assert.equal(outcome.kind, 'dead', 'a model no channel serves is dead')
  assert.equal(outcome.code, 'dead')
  assert.equal(outcome.http, 404)
  assert.ok(calls >= 2, `all channels were asked (asked ${calls})`)
})

test('GUARD: a gate or a quota wall is never retried on another channel', async () => {
  // Both are properties of the caller, not the model, and retrying would spend
  // the very quota that is already exhausted — twice over.
  for (const [status, body, expect] of [
    [403, '{"error":{"type":"FreeTierError","message":"only be used in OpenCode"}}', 'anon-gated'],
    [429, '{"error":{"type":"FreeUsageLimitError"}}', 'quota-exhausted'],
    [401, '{"error":{"message":"Invalid API key provided"}}', 'bad-key'],
  ]) {
    const p = plugin.zenProvider(
      () => 'probe-session',
      () => undefined,
    )
    const model = p.getModels().find((m) => m.api === 'openai-completions')
    let calls = 0
    const outcome = await probeModel(model, {
      provider: p,
      apiKey: 'public',
      fetchImpl: async () => {
        calls += 1
        return new Response(body, { status, headers: { 'Content-Type': 'application/json' } })
      },
    })
    assert.equal(outcome.code, expect, `HTTP ${status}`)
    assert.equal(calls, 1, `HTTP ${status} costs exactly one request, not one per channel`)
  }
})

test('GUARD: dead is only concluded when every channel that was asked finished', async () => {
  // A 404 down the wrong channel reads exactly like a dead model — that is why
  // the sweep exists at all. But a channel that never FINISHED has said nothing
  // about the model, and "this request did not complete" is not "this model is
  // gone". Ranking `dead` above that silence (which is what the old strength
  // comparison did) meant one dropped socket on the second channel turned a
  // wrong-channel 404 into a permanent removal.
  //
  // Silence vetoes; it does not merely lose an argument.
  const GONE = () =>
    new Response(JSON.stringify({ error: { message: 'Model does not exist' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  const TRANSPORT = () => {
    const e = new TypeError('fetch failed')
    e.cause = Object.assign(new Error('socket disconnected'), { code: 'ECONNRESET' })
    throw e
  }
  // Never answers. It rejects past the probe's own deadline with the error that
  // deadline produces, so the row says "timeout" for the reason a real timeout
  // does — rather than this test asserting a classification nothing can reach.
  const TIMEOUT = () =>
    new Promise((_, reject) => {
      setTimeout(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), 30)
    })

  const p = plugin.zenProvider(
    () => 'probe-session',
    () => undefined,
  )
  const model = p.getModels().find((m) => m.api === 'openai-completions')

  for (const [label, silent] of [
    ['transport', TRANSPORT],
    ['timeout', TIMEOUT],
  ]) {
    for (const order of ['dead-first', 'silent-first']) {
      let calls = 0
      const outcome = await probeModel(model, {
        provider: p,
        apiKey: 'public',
        timeoutMs: 5,
        fetchImpl: async () => {
          calls += 1
          const silentNow = order === 'dead-first' ? calls === 2 : calls === 1
          return silentNow ? silent() : GONE()
        },
      })
      // The OUTCOME is the assertion, and it is strictly stronger than counting
      // requests: a sweep that asked only the first channel would answer `dead`
      // here and fail this. Counting fetch calls instead proved to depend on how
      // many times pi-ai issues one per probe, which is not this test's business
      // — and on a Linux runner it read 1 where the veto had clearly still
      // happened, hiding the outcome behind a bookkeeping failure.
      assert.equal(
        outcome.kind,
        'inconclusive',
        `${label}/${order}: the removal is vetoed (calls=${calls}, kind=${outcome.kind})`,
      )
      assert.equal(outcome.code, label, `${label}/${order}: the row says why it could not tell`)
    }
  }
})

test('GUARD: every channel saying dead still removes the model', async () => {
  // The other half of the veto. Silence blocking a conclusion must not become a
  // way to never conclude one: when both channels positively refuse, that is a
  // real verdict and it still removes the model.
  const p = plugin.zenProvider(
    () => 'probe-session',
    () => undefined,
  )
  const model = p.getModels().find((m) => m.api === 'openai-completions')
  let calls = 0
  const outcome = await probeModel(model, {
    provider: p,
    apiKey: 'public',
    fetchImpl: async () => {
      calls += 1
      return new Response(JSON.stringify({ error: { message: 'Model does not exist' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })
  assert.ok(calls >= 2, 'both channels were asked')
  assert.equal(outcome.kind, 'dead', 'a positive refusal on every channel is conclusive')
  assert.equal(outcome.http, 404)
})

test('GUARD: placeholder efforts never reach the wire', async () => {
  // "off" is offered as an explicit level, but pi-ai renders it as
  // `reasoning: { effort: "none" }` when nothing is chosen and as
  // `effort: "off"` when it is explicitly chosen on the responses channel.
  // Neither value is ever sent by pi-ai's own records or by OpenCode, so the
  // request path strips exactly those two back to "no reasoning object".
  // Real levels pass through untouched.
  const p = plugin.zenProvider(
    () => 's',
    () => undefined,
  )
  const base = p.getModels().find((m) => m.api === 'openai-responses')
  // A map with `off` absent (offered), like every derived record carries —
  // and an id outside the muse-spark xhigh default, so nothing is chosen.
  const { off: _dropped, ...rest } = base.thinkingLevelMap ?? {}
  const model = { ...base, id: 'probe-responses-free', thinkingLevelMap: rest }
  const ctx = { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }
  // Run each case and read the captured body. The stub answers 400 so the
  // stream settles immediately; onPayload has already run by then.
  const bodies = {}
  for (const [key, opts] of [
    ['default', {}],
    ['explicit-off', { reasoning: 'off' }],
    ['real-level', { reasoning: 'low' }],
  ]) {
    let body
    await p
      .streamSimple(model, ctx, {
        ...opts,
        maxRetries: 0,
        fetch: async (_url, init) => {
          body = JSON.parse(init.body)
          return new Response('{"error":{"message":"stop here"}}', { status: 400 })
        },
      })
      .result()
    bodies[key] = body
  }
  assert.equal(bodies.default.reasoning, undefined, 'no effort chosen sends no reasoning object')
  assert.equal(bodies['explicit-off'].reasoning, undefined, 'explicit "off" sends no reasoning object')
  assert.equal(bodies['real-level'].reasoning?.effort, 'low', 'a real level passes through')
})

test('probe verdicts: a text reply is ok, only a positive signal is dead', async () => {
  const p = plugin.zenProvider(
    () => 'probe-session',
    () => undefined,
  )
  const model = p.getModels().find((m) => m.api === 'openai-completions')
  const run = (fetchImpl) => probeModel(model, { provider: p, apiKey: 'public', fetchImpl })

  assert.equal((await run(async () => sseReply())).kind, 'ok')

  // dead requires positive evidence about THIS model.
  for (const [status, text] of [
    [404, '{"error":{"message":"model not found"}}'],
    [410, '{"error":{"message":"no longer available"}}'],
    [400, '{"error":{"message":"The model has been retired"}}'],
  ]) {
    const outcome = await run(async () => new Response(text, { status }))
    assert.equal(outcome.kind, 'dead', `${status} ${text}`)
  }

  // Everything the request path already understands is inconclusive: none of
  // it is evidence about the model.
  for (const [status, text] of [
    [403, '{"type":"error","error":{"type":"FreeTierError","message":"only be used from within OpenCode"}}'],
    [429, '{"error":{"type":"FreeUsageLimitError"}}'],
    [401, '{"error":{"message":"invalid x-api-key"}}'],
    [500, 'internal error'],
    [403, 'something entirely new'],
    // A body carrying BOTH a quota marker and model wording must resolve to
    // the safe side, or one throttled minute could empty the picker.
    [429, '{"error":{"message":"usage limit exceeded; model not found"}}'],
  ]) {
    const outcome = await run(async () => new Response(text, { status }))
    assert.equal(outcome.kind, 'inconclusive', `${status} ${text}`)
  }
  assert.equal(isModelUnavailableFailure(429, 'usage limit exceeded; model not found'), false)

  // Calibrated against real Zen bodies, 2026-09-29. These three are one word
  // apart from each other, and reading any of them wrong empties the picker.
  const DEAD_400 =
    '{"error":{"type":"server_error","message":"Error from provider (Console): Upstream request failed: Model is unavailable."}}'
  const ENDPOINT_400 =
    '{"error":{"type":"server_error","message":"Error from provider (Console): Upstream request failed: Endpoint is unavailable."}}'
  // The free route declining to serve a model models.dev still lists free.
  const UNSUPPORTED_401 =
    '{"type":"error","error":{"type":"ModelError","message":"Model kimi-k2.5-free is not supported"}}'
  // The SAME sentence about the request instead of the model: a healthy model
  // sent down the wrong channel. Never a death notice.
  const FORMAT_401 =
    '{"type":"error","error":{"type":"ModelError","message":"Model space-bunny-free is not supported for format openai"}}'
  assert.equal(isModelUnavailableFailure(400, DEAD_400), true, 'the model is gone')
  assert.equal(isModelUnavailableFailure(400, ENDPOINT_400), false, 'the ENDPOINT is gone, not the model')
  assert.equal(isModelUnavailableFailure(401, UNSUPPORTED_401), true, 'the free route will not serve it')
  assert.equal(isModelUnavailableFailure(401, FORMAT_401), false, 'wrong channel, healthy model')
  assert.equal((await run(async () => new Response(DEAD_400, { status: 400 }))).kind, 'dead')
  assert.equal((await run(async () => new Response(ENDPOINT_400, { status: 400 }))).kind, 'inconclusive')
  assert.equal((await run(async () => new Response(UNSUPPORTED_401, { status: 401 }))).kind, 'dead')
  assert.equal((await run(async () => new Response(FORMAT_401, { status: 401 }))).kind, 'inconclusive')

  // A bad key must never empty the picker, however it is phrased.
  for (const body of [
    '{"error":{"message":"Invalid API key provided"}}',
    '{"detail":"Unauthorized"}',
    '{"error":{"type":"authentication_error","message":"bad credentials"}}',
  ]) {
    assert.equal(isModelUnavailableFailure(401, body), false, body)
    assert.equal((await run(async () => new Response(body, { status: 401 }))).kind, 'inconclusive', body)
  }

  // A thrown transport error concludes nothing, and never rejects.
  const thrown = await run(async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') })
  })
  assert.equal(thrown.kind, 'inconclusive')
  assert.match(thrown.reason, /transport failure/)
  assert.match(thrown.reason, /ECONNRESET/)

  // An empty completion is not a reply: no text means no conclusion.
  const empty = await run(
    async () =>
      new Response('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
  )
  assert.equal(empty.kind, 'inconclusive')
})

test('GUARD: every inconclusive outcome carries a code and a status the card can word', async () => {
  // The panel localizes the failure itself, so the outcome must hand it
  // something structured. A red badge that can only read "failed" is exactly
  // the report this test exists to prevent — the prober is the only place
  // that still knows WHY.
  const p = plugin.zenProvider(
    () => 's',
    () => undefined,
  )
  const model = p.getModels().find((m) => m.api === 'openai-completions')
  const run = (fetchImpl) => probeModel(model, { provider: p, apiKey: 'public', fetchImpl })
  const CODES = new Set(['anon-gated', 'quota-exhausted', 'bad-key', 'unknown', 'timeout', 'transport'])

  // A gated anonymous request, a quota wall, a bad key, an empty completion and
  // a thrown socket: five different situations, five different sentences.
  const bodies = [
    { status: 403, text: '{"error":{"type":"FreeTierError","message":"only be used in OpenCode"}}' },
    { status: 429, text: '{"error":{"type":"FreeUsageLimitError"}}' },
    { status: 401, text: '{"error":{"message":"Invalid API key provided"}}' },
    {
      status: 200,
      text: 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      sse: true,
    },
  ]
  for (const { status, text, sse } of bodies) {
    const outcome = await run(
      async () =>
        new Response(text, {
          status,
          headers: sse ? { 'Content-Type': 'text/event-stream' } : undefined,
        }),
    )
    assert.equal(outcome.kind, 'inconclusive', `HTTP ${status}`)
    assert.ok(CODES.has(outcome.code), `HTTP ${status} produced code ${outcome.code}`)
    assert.equal(typeof outcome.http, 'number', `HTTP ${status} carries a status`)
    if (status !== 0) assert.equal(outcome.http, status, `HTTP ${status} is reported as itself`)
  }

  const thrown = await run(async () => {
    throw new TypeError('fetch failed')
  })
  assert.equal(thrown.kind, 'inconclusive')
  assert.ok(CODES.has(thrown.code), `a thrown socket produced code ${thrown.code}`)
  assert.equal(thrown.http, 0, 'no response means no status, not a fake one')

  // A timeout is its own code: "the model sat there" and "the socket broke"
  // need different things from the reader, and an AbortError is the only
  // evidence that separates them.
  const aborted = await run(async () => {
    throw Object.assign(new Error('aborted'), { name: 'AbortError' })
  })
  assert.equal(aborted.code, 'timeout', 'a blown AbortSignal is reported as a timeout')

  // And a genuinely dead model says dead, with the status that proved it.
  const dead = await run(
    async () => new Response('{"error":{"message":"The model does not exist"}}', { status: 404 }),
  )
  assert.equal(dead.kind, 'dead')
  assert.equal(dead.code, 'dead')
  assert.equal(dead.http, 404)
})

test('a socket failure reports its cause instead of a bare "Connection error."', async () => {
  // The chain this exists for, recorded live 2026-09-29: undici rejects, the
  // OpenAI SDK flattens it to `APIConnectionError { message: 'Connection
  // error.' }` and keeps the reason in `cause`, and pi-ai reads only
  // `error.message`. Without the recorder the user saw those four words for
  // 45 minutes with no way to act on them.
  const socket = () => {
    const err = new TypeError('fetch failed')
    err.cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
    throw err
  }
  assert.equal(
    describeTransportCause(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
      }),
    ),
    'TypeError: fetch failed <- Error/UND_ERR_SOCKET: other side closed',
  )
  // A cause carrying its own three-digit run must not be able to re-file a
  // socket kill as an upstream status error: the host reads 4xx/5xx literals
  // off this message before it ever reaches the transport rule.
  assert.doesNotMatch(
    describeTransportCause(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('read ECONNRESET after 500 bytes'), { code: 'ECONNRESET' }),
      }),
    ),
    /\b\d{3}\b/,
  )
  assert.equal(describeTransportCause('not an error'), 'string')

  const p = plugin.zenProvider(
    () => 's',
    () => undefined,
  )
  const model = p.getModels().find((m) => m.api === 'openai-completions')
  const ctx = { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }
  const r = await p.streamSimple(model, ctx, { fetch: socket, maxRetries: 0 }).result()
  assert.equal(r.stopReason, 'error')
  assert.match(r.errorMessage, /Connection error\./)
  assert.match(r.errorMessage, /UND_ERR_SOCKET/)
  assert.match(r.errorMessage, /other side closed/)
  assert.match(r.errorMessage, /網路層/)
  // APPENDED, not substituted: the host classifies from this message, and the
  // original wording is what still carries the transport class.
  assert.ok(r.errorMessage.startsWith('Connection error.'), r.errorMessage)

  // A healthy request records nothing and is left exactly as it was.
  const sse =
    'data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  const ok = await p
    .streamSimple(model, ctx, {
      maxRetries: 0,
      fetch: async () => new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }),
    })
    .result()
  assert.equal(ok.stopReason, 'stop')
  assert.equal(ok.errorMessage, undefined)
})

test('every Zen-bound path sends the same identity header names', async () => {
  // The set was written out in four places and a comment was
  // the only thing holding them together. Upstream gates admission on exactly
  // these headers, so one missed edit is a silent total 403 on the path that was
  // missed — reported as "the anonymous tier refused", i.e. diagnosed backwards.
  //
  // Both remaining shapes are exercised through the SAME function the fetch guard
  // calls, so the guard is covered too: the guard's job here is precisely to
  // delegate, and the delegation is what this asserts. (It cannot be re-patched
  // inside this file: apply() already installed it, and the pristine original is
  // stashed on globalThis.)
  const expected = new Set(ZEN_IDENTITY_HEADERS)
  assert.equal(expected.size, 7, 'the owned list is the full identity')

  // The `Headers` shape — what applyZenIdentity stamps.
  const headers = applyZenIdentity(new Headers(), {
    session: 'ses_0123456789abAbCdEfGhIjKlMn',
    apiKey: 'public',
  })
  for (const name of expected) {
    assert.ok(headers.get(name), `Headers shape must send ${name}`)
  }
  assert.equal(
    headers.get('x-opencode-session'),
    headers.get('x-client-request-id'),
    'the affinity pair must be the same value',
  )
  assert.equal(headers.get('authorization'), 'Bearer public')
  assert.equal(headers.get('user-agent'), OPENCODE_USER_AGENT)

  // Idempotence: a caller who set a real key must never be downgraded.
  const keyed = applyZenIdentity(new Headers({ authorization: 'Bearer sk-real-key' }), {
    session: 'ses_0123456789abAbCdEfGhIjKlMn',
    apiKey: 'public',
  })
  assert.equal(keyed.get('authorization'), 'Bearer sk-real-key', 'an explicit key survives')

  // The node:http shape — plain objects and header arrays.
  for (const shape of ['object', 'array']) {
    const out = applyZenHeadersToNodeHeaders(shape === 'array' ? [] : undefined, () => 'session-a')
    const lower =
      shape === 'array'
        ? Object.fromEntries(out.map(([k, v]) => [String(k).toLowerCase(), v]))
        : Object.fromEntries(Object.entries(out ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    for (const name of expected) {
      assert.ok(lower[name.toLowerCase()] !== undefined, `node:http (${shape}) must send ${name}`)
    }
    assert.equal(
      lower['x-opencode-session'],
      lower['x-client-request-id'],
      `node:http (${shape}): the affinity pair must agree`,
    )
  }

  // The static set the provider advertises is a SUBSET of the owned list — a
  // header in one and not the other is exactly the drift being guarded against.
  for (const name of Object.keys(STATIC_ZEN_HEADERS)) {
    assert.ok(expected.has(name), `STATIC_ZEN_HEADERS carries ${name}, which the owned list does not`)
  }
})

test("disposing the node:http patch leaves another plugin's wrapper alone", async () => {
  // node:http/https is a process-wide object that every other plugin and the
  // host itself shares. Cleanup restored our replacement unconditionally, so a
  // plugin that wrapped `http.request` AFTER us had its wrapper removed the
  // moment this plugin was disabled — silently, with nothing to show for it.
  // The fetch guard has made this ownership check since the start; the two
  // paths now agree.
  const req = createRequire(import.meta.url)
  const http = req('node:http')
  const before = http.request
  const restore = patchNodeHttpForZen()
  try {
    assert.notEqual(http.request, before, 'the patch installed its wrapper')

    function laterPlugin(...args) {
      return http.request(...args)
    }
    http.request = laterPlugin
    restore()
    assert.equal(http.request, laterPlugin, 'a later plugin keeps its wrapper')
    // Repeated disposal and a reload are both no-ops now, rather than stripping
    // whatever is on top and leaving the process unwrapped.
    restore()
    assert.equal(http.request, laterPlugin, 'and disposing twice changes nothing')
  } finally {
    http.request = before
    restore()
  }
})

test('disposing the node:http patch unwraps it when nothing wrapped after', async () => {
  // The other half: the ownership check must not turn disposal into a no-op.
  //
  // "Unwrapped" is asserted as "our wrapper is gone" rather than "the function
  // object is the one from before this test": the stash is process-wide and
  // holds the first pristine value any test ever saw, so an earlier test in
  // this file may have left a different one in place. What matters is that
  // unloading removes what we installed.
  const req = createRequire(import.meta.url)
  const http = req('node:http')
  const before = http.request
  try {
    const restore = patchNodeHttpForZen()
    const ours = http.request
    assert.notEqual(ours, before, 'the patch installed its wrapper')
    restore()
    assert.notEqual(http.request, ours, 'unloading removes it')
    const restoreAgain = patchNodeHttpForZen()
    assert.notEqual(http.request, ours, 'and reloading installs a fresh one')
    restoreAgain()
    assert.notEqual(http.request, ours, 'which unloading removes in turn')
  } finally {
    http.request = before
  }
})
