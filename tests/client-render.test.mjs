import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

/**
 * Structural render smoke test for the detail-page card (src/client.js).
 *
 * The bundle cannot be mounted for real here — it needs the DSH host's
 * ModuleLoader, slots and configForms — so this file stands in a minimal
 * React (createElement/useState/useEffect) plus the host seams the card
 * touches, feeds it a fixture snapshot, and asserts on the rendered tree:
 * switches, capability badges, timestamp shape and dictionary parity.
 *
 * It does not assert pixels. It asserts that the data the backend sends
 * (`models: [{id, image, thinking}]`) is what the rows render, so a backend
 * rename or a dropped badge fails here instead of silently in the UI.
 */

const CLIENT_URL = new URL('../src/client.js', import.meta.url)
// The palette itself, read from the shipped bundle rather than restated here —
// otherwise the test would guard its own copy instead of what ships.
const CSS_TEXT = await readFile(CLIENT_URL, 'utf8')

// ── stub React ──────────────────────────────────────────────────────────────

function flat(children) {
  const out = []
  for (const child of children) {
    if (Array.isArray(child)) out.push(...flat(child))
    else if (child === null || child === undefined || child === false) continue
    else out.push(child)
  }
  return out
}

let hookCells = []
let hookIndex = 0
let pendingEffects = []
let pendingCleanups = []

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: flat(children) }),
  useState: (initial) => {
    const slot = hookIndex++
    if (hookCells[slot] === undefined) hookCells[slot] = initial
    return [
      hookCells[slot],
      (next) => {
        hookCells[slot] = typeof next === 'function' ? next(hookCells[slot]) : next
      },
    ]
  },
  useEffect: (fn) => {
    pendingEffects.push(fn)
    pendingCleanups.push(null)
  },
  // Refs must survive re-renders — that is the whole reason the poll state moved
  // into one. The stub therefore keeps the cell array across renders, exactly as
  // the hook slot does.
  useRef: (initial) => {
    const slot = hookIndex++
    if (hookCells[slot] === undefined) hookCells[slot] = { current: initial }
    return hookCells[slot]
  },
  Component: class {},
}

function expand(node, depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((c) => expand(c, depth)).filter((x) => x !== null)
  const props = { ...node.props, children: node.children }
  if (typeof node.type === 'function') {
    if (node.type.prototype && node.type.prototype.render) {
      const instance = new node.type(props)
      instance.props = props
      instance.state = instance.state ?? {}
      return expand(instance.render(), depth + 1)
    }
    return expand(node.type(props), depth + 1)
  }
  return {
    tag: node.type,
    props: node.props,
    children: (node.children ?? []).map((c) => expand(c, depth + 1)).filter((x) => x !== null),
  }
}

function* walk(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') {
    yield { text: String(node) }
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child)
    return
  }
  yield node
  for (const child of node.children ?? []) yield* walk(child)
}

// ── host stubs ──────────────────────────────────────────────────────────────

const SNAPSHOT = {
  visible: ['space-bunny-free', 'big-pickle', 'muse-spark-1.3-contributor-free'],
  models: [
    { id: 'space-bunny-free', image: true, thinking: 'max' },
    { id: 'big-pickle', image: false, thinking: null },
    { id: 'muse-spark-1.3-contributor-free', image: true, thinking: 'xhigh' },
  ],
  source: 'models.dev',
  updatedAt: 1,
  refreshing: false,
  probedAt: Date.parse('2026-09-29T23:30:17+08:00'),
  probeInconclusive: false,
}

async function renderCard({ hidden = [], locale = 'zh', snapshot = SNAPSHOT, routes = null } = {}) {
  hookCells = []
  const scope = {
    getSnapshot: () => ({ status: 'ready', value: { hiddenModels: hidden } }),
    set: async () => true,
    subscribe: () => () => {},
  }
  const registered = []
  const ctx = {
    get: (key) =>
      key === 'locale' ? { getSnapshot: () => ({ active: locale }), subscribe: () => () => {} } : undefined,
    inject: (deps, fn) => {
      if (deps.includes('configForms')) fn({ configForms: { get: () => scope } })
    },
    effect: (fn) => {
      try {
        fn()
      } catch {
        /* host-side */
      }
      return () => {}
    },
    slots: {
      inject: (_name, fn) => {
        fn()
      },
      register: (opts, comp) => {
        registered.push([opts, comp])
      },
    },
    locale: { register: () => () => {} },
  }
  // The bundle reads bare `window` and `fetch` like a browser would. The
  // factory's return value is the plugin surface; the harness keeps it.
  const stashWindow = globalThis.window
  const stashFetch = globalThis.fetch
  const stubRequire = (name) => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected require ${name}`)
  }
  globalThis.window = {
    __ModuleLoader__: {
      load: (entry) => {
        globalThis.__opfPlugin = entry.factory(stubRequire)
      },
    },
  }
  const calls = []
  globalThis.fetch = async (url, init) => {
    const method = (init && init.method) || 'GET'
    calls.push({ url: String(url), method })
    if (routes !== null) return routes({ url: String(url), method })
    return { ok: true, json: async () => snapshot }
  }
  // Timers are captured so polling is deterministic: the test fires them.
  const stashTimeout = globalThis.setTimeout
  const stashClear = globalThis.clearTimeout
  const timers = new Map()
  let timerSeq = 0
  globalThis.setTimeout = (fn) => {
    timerSeq += 1
    timers.set(timerSeq, fn)
    return timerSeq
  }
  globalThis.clearTimeout = (id) => {
    timers.delete(id)
  }
  // The bundle calls the ModuleLoader facade, which the harness answers.
  // `?render=` busts the module cache so each mount gets a fresh bundle.
  try {
    await import(`${CLIENT_URL.href}?render=${locale}-${hidden.join(',')}-${Date.now()}-${Math.random()}`)
    const plugin = globalThis.__opfPlugin
    assert.ok(plugin, 'the bundle must register through the ModuleLoader')
    plugin.apply(ctx)
    assert.equal(registered.length, 1, 'one card seat is registered')
    const [opts, Comp] = registered[0]
    // No `t` is passed on purpose: ModelsCard falls back to the identity
    // lookup, so the tree carries dictionary KEYS. That pins which key each
    // slot uses; the real wording in each language is covered by the parity
    // test below and by reading the dictionaries, not by rendering.
    const root = { type: Comp, props: { ...opts.inject() }, children: [] }
    // Render until the stubbed catalogue fetch settles into state. Flushes
    // use the REAL timer; the stub only captures the card's own polling.
    let tree = null
    for (let pass = 0; pass < 8; pass++) {
      hookIndex = 0
      pendingEffects = []
      pendingCleanups = []
      tree = expand(root)
      const effects = pendingEffects
      pendingEffects = []
      for (let i = 0; i < effects.length; i++) {
        try {
          const cleanup = effects[i]()
          if (typeof cleanup === 'function') pendingCleanups[i] = cleanup
        } catch {
          /* a failing effect must not fail the harness */
        }
      }
      await new Promise((resolve) => stashTimeout(resolve, 0))
      await new Promise((resolve) => stashTimeout(resolve, 0))
    }
    hookIndex = 0
    pendingEffects = []
    tree = expand(root)
    const rerender = () => {
      hookIndex = 0
      pendingEffects = []
      for (const fn of pendingEffects) {
        try {
          fn()
        } catch {
          /* host-side */
        }
      }
      return expand(root)
    }
    const fireTimers = async () => {
      const fns = [...timers.values()]
      timers.clear()
      for (const fn of fns) {
        try {
          fn()
        } catch {
          /* a failing timer must not fail the harness */
        }
      }
      await new Promise((resolve) => stashTimeout(resolve, 0))
      await new Promise((resolve) => stashTimeout(resolve, 0))
    }
    const api = {
      tree,
      rerender,
      fireTimers,
      calls,
      findButton: (label) => {
        const current = rerender()
        return [...walk(current)].find(
          (n) => n.tag === 'button' && [...walk(n)].some((d) => d.text === label),
        )
      },
      // Stubs stay alive until the test is done driving; only then restore.
      // Unmount, not just teardown: run the effect cleanups the way React
      // does when the component leaves the tree. Without this the harness has no
      // way to reach a useEffect cleanup at all, which is why no test could see
      // the poll timer surviving a close.
      unmount: () => {
        for (const cleanup of pendingCleanups) {
          if (typeof cleanup !== 'function') continue
          try {
            cleanup()
          } catch {
            /* best effort, like React */
          }
        }
        pendingCleanups = []
        // Deliberately NOT clearing the harness timer map here. Doing so would
        // mask the very thing under test: a test that passes whether or not the
        // useEffect cleanup works proves nothing. fireTimers() drains the map,
        // and the component's own cleanup is what must prevent a NEW entry."
      },
      dispose: () => {
        if (stashWindow === undefined) delete globalThis.window
        else globalThis.window = stashWindow
        globalThis.fetch = stashFetch
        globalThis.setTimeout = stashTimeout
        globalThis.clearTimeout = stashClear
        delete globalThis.__opfPlugin
      },
    }
    return api
  } catch (error) {
    if (stashWindow === undefined) delete globalThis.window
    else globalThis.window = stashWindow
    globalThis.fetch = stashFetch
    globalThis.setTimeout = stashTimeout
    globalThis.clearTimeout = stashClear
    delete globalThis.__opfPlugin
    throw error
  }
}

function collect(tree) {
  const nodes = [...walk(tree)]
  return {
    texts: nodes.filter((n) => n.text).map((n) => n.text),
    classes: nodes.filter((n) => n.props?.className).flatMap((n) => String(n.props.className).split(' ')),
    tags: nodes.filter((n) => n.tag).map((n) => n.tag),
    inputs: nodes.filter((n) => n.tag === 'input'),
  }
}

test('the card renders rows, switches, badges and toolbar from the snapshot', async () => {
  // The wrapper supplies the real zh translator, so assertions read the
  // resolved wording — which also proves the dictionary keys resolve.
  const mounted = await renderCard({ hidden: ['big-pickle'] })
  try {
    const { texts, classes, tags, inputs } = collect(mounted.tree)
    const has = (cls) => classes.includes(cls)
    // Rows: ids, status words, switches honouring hiddenModels.
    for (const id of ['space-bunny-free', 'big-pickle', 'muse-spark-1.3-contributor-free']) {
      assert.ok(texts.includes(id), `row for ${id} renders`)
    }
    assert.ok(texts.includes('显示') && texts.includes('已隐藏'), 'both status words render')
    assert.ok(has('opf-switch') && has('opf-track') && has('opf-thumb'), 'iOS-style switches render')
    // Shown models lead, each group keeping the catalogue's alphabetical order.
    const ids = ['space-bunny-free', 'big-pickle', 'muse-spark-1.3-contributor-free']
    assert.deepEqual(
      texts.filter((t) => ids.includes(t)),
      ['space-bunny-free', 'muse-spark-1.3-contributor-free', 'big-pickle'],
      'shown models come first, alphabetical within each group',
    )
    assert.deepEqual(
      inputs.map((i) => i.props.checked),
      [true, true, false],
      'switch states follow hiddenModels, in the new row order',
    )
    // Badges: image + top thinking level, display-capitalized, per model.
    assert.ok(has('opf-badge-vision') && has('opf-badge-think'), 'both badge kinds render')
    assert.ok(
      texts.some((t) => t.includes('Max')),
      'space-bunny shows its top level',
    )
    assert.ok(
      texts.some((t) => t.includes('XHigh')),
      'muse-spark shows its top level',
    )
    assert.ok(!texts.some((t) => /(^| )xhigh($| )/.test(t)), 'no raw lowercase level leaks')
    assert.ok(texts.includes('视觉'), 'the vision badge word renders')
    assert.ok(
      texts.some((t) => t.includes('思考')),
      'the thinking badge word renders',
    )
    assert.ok(texts.includes('多模态视觉') && texts.includes('思考推理'), 'the footer legend renders')
    // Toolbar: pill buttons with icons, timestamp with green dot.
    assert.ok(texts.includes('立即刷新') && texts.includes('立即探测'), 'both actions render')
    assert.ok(tags.filter((t) => t === 'svg').length >= 4, 'buttons and badges carry icons')
    assert.ok(
      texts.some((t) => /20\d\d\/\d{1,2}\/\d{1,2} \d{2}:\d{2}:\d{2}/.test(t)),
      'timestamp renders as YYYY/M/D H:mm:ss',
    )
    assert.ok(has('opf-dot'), 'the probe timestamp carries the green dot')
    assert.ok(
      has('opf-toolbar') && has('opf-foot') && has('opf-head') && has('opf-body'),
      'card sections render',
    )
  } finally {
    mounted.dispose()
  }
})

test('a probe round paints the capsule, the counter and a badge per row', async () => {
  // The (2) mock's live state, driven end to end: clicking the probe button
  // starts the POST, the captured timers fire the polls, and the rows repaint
  // from each reading until the POST answers.
  let postResolve = null
  const progress = {
    running: true,
    total: 3,
    done: 1,
    current: 'big-pickle',
    results: { 'space-bunny-free': { status: 'ok', ms: 142 } },
    startedAt: 1,
  }
  const mounted = await renderCard({
    hidden: [],
    routes: ({ url, method }) => {
      if (url.endsWith('/api/probe') && method === 'POST') {
        return new Promise((resolve) => {
          postResolve = () => resolve({ ok: true, json: async () => SNAPSHOT })
        })
      }
      if (url.endsWith('/api/probe') && method === 'GET') {
        return { ok: true, json: async () => ({ ...progress, results: { ...progress.results } }) }
      }
      return { ok: true, json: async () => SNAPSHOT }
    },
  })
  try {
    const button = mounted.findButton('立即探测')
    assert.ok(button, 'the probe button renders')
    // Clicking starts the POST (which hangs) and the first poll.
    button.props.onClick()
    await mounted.fireTimers()
    const mid = collect(mounted.rerender())
    const midHas = (cls) => mid.classes.includes(cls)
    assert.ok(midHas('opf-capsule'), 'the progress capsule renders')
    assert.ok(
      mid.texts.some((t) => t.includes('正在探测')),
      'the capsule names the action',
    )
    assert.ok(
      mid.texts.some((t) => t.includes('1/3')),
      'the capsule counts done/total',
    )
    assert.ok(midHas('opf-bar') && midHas('opf-fill'), 'the mini progress bar renders')
    // The finished row reports its latency, the current row spins, the queued
    // row waits.
    assert.ok(
      mid.texts.some((t) => t.includes('142ms')),
      'a finished row shows its latency',
    )
    assert.ok(
      mid.texts.some((t) => t.includes('探测中')),
      'the current row spins',
    )
    assert.ok(
      mid.texts.some((t) => t.includes('等待中')),
      'queued rows wait',
    )
    // Capability badges stay on screen mid-round. They used to step aside and
    // come back at the end, so every row lost its identity exactly while the
    // reader waited to find out what it was — and came back looking different
    // for reasons that had nothing to do with the model.
    const rowLabels = (tree) =>
      [...walk(tree)].filter(
        (n) => n.tag === 'label' && String(n.props?.className).split(' ').includes('opf-row'),
      )
    const rowHasBadge = (row) =>
      [...walk(row)].some((d) =>
        String(d.props?.className ?? '')
          .split(' ')
          .some((c) => c === 'opf-badge-vision' || c === 'opf-badge-think'),
      )
    assert.ok(rowLabels(mounted.rerender()).some(rowHasBadge), 'capability badges stay on screen mid-round')
    assert.ok(midHas('opf-row-probing'), 'the active row highlights')
    assert.ok(midHas('opf-row-waiting'), 'queued rows dim')
    // The probe button shows its loading state and refresh is fenced off.
    const busyBtn = mounted.findButton('探测中…')
    assert.ok(busyBtn, 'the probe button shows its loading state')
    // Let the POST answer: polling stops, and the card keeps the round as a
    // report instead of blinking back to a bare list. The stubbed GET is still
    // `running: true`, so the pill stays live here — the finished-state
    // assertions live in the test below, which is where the reading is frozen.
    postResolve()
    await mounted.fireTimers()
    const end = collect(mounted.rerender())
    assert.ok(
      end.texts.some((t) => t.includes('视觉')),
      'capability badges return',
    )
  } finally {
    mounted.dispose()
  }
})

test('a finished round stays on screen: tally, per-row reasons, and the dead model named', async () => {
  // The reported bug, end to end: the POST answers, the progress is wiped, and
  // a card that says nothing looks like a probe that never ran. The host's own
  // frozen reading is the source of truth here — the card re-reads it after the
  // POST precisely so the report cannot be a half-polled guess.
  let postResolve = null
  const finished = {
    running: false,
    // The round's COST, which is not its model tally: a round may take several
    // samples of one model, and someone who presses "Probe now" is spending the
    // shared anonymous bucket.
    requests: 11,
    pending: ['longcat-2.5-preview-free'],
    total: 3,
    done: 3,
    current: null,
    results: {
      'space-bunny-free': { status: 'ok', ms: 218 },
      'big-pickle': { status: 'failed', ms: 5000, code: 'timeout', http: 0 },
      'deepseek-v4-flash-free': { status: 'failed', ms: 41, code: 'dead', http: 404 },
    },
    startedAt: 1,
  }
  let live = true
  const mounted = await renderCard({
    hidden: [],
    routes: ({ url, method }) => {
      if (url.endsWith('/api/probe') && method === 'POST') {
        return new Promise((resolve) => {
          postResolve = () =>
            resolve({
              ok: true,
              // The POST hands back a catalogue WITHOUT the dead model: that is
              // the whole reason the report has to survive on its own.
              json: async () => ({
                ...SNAPSHOT,
                visible: ['space-bunny-free', 'big-pickle', 'muse-spark-1.3-contributor-free'],
              }),
            })
        })
      }
      if (url.endsWith('/api/probe') && method === 'GET') {
        return {
          ok: true,
          json: async () =>
            live
              ? { ...finished, running: true, done: 0, current: 'space-bunny-free', results: {} }
              : finished,
        }
      }
      return { ok: true, json: async () => SNAPSHOT }
    },
  })
  try {
    mounted.findButton('立即探测').props.onClick()
    await mounted.fireTimers()
    live = false
    postResolve()
    await mounted.fireTimers()
    const end = collect(mounted.rerender())
    const endHas = (cls) => end.classes.includes(cls)
    // The round is still a fact on screen, with its tally.
    assert.ok(endHas('opf-capsule'), 'the finished round keeps its capsule')
    assert.ok(endHas('opf-capsule-mixed'), 'a round with failures is tinted as one')
    assert.ok(
      end.texts.some((t) => t.includes('探测完成')),
      'the capsule reads as finished',
    )
    // The COST, beside the tally: `done/total` counts models, this counts what
    // the shared bucket paid. The card's own translator is in play here, so the
    // tree carries real wording with the numbers interpolated — which is what a
    // user actually reads.
    assert.ok(
      end.texts.some((x) => String(x).includes('11') && String(x).includes('次请求')),
      "the round's bill is rendered with the request count: " + JSON.stringify(end.texts),
    )
    assert.ok(
      end.texts.some((x) => String(x).includes('1 个待测')),
      'and how many models still owe samples',
    )
    assert.ok(
      end.texts.some((t) => t.includes('1')),
      'the tally renders',
    )
    // Per-row: the success keeps its latency, the failure NAMES its reason.
    assert.ok(
      end.texts.some((t) => t.includes('218ms')),
      'the answered row keeps its latency',
    )
    assert.ok(
      end.texts.some((t) => t.includes('探测超时')),
      'the timed-out row says so, not just "failed"',
    )
    // The dead model has no row left to speak for itself, so it is named.
    assert.ok(
      end.texts.some((t) => t.includes('本轮下架')),
      'the removed model is announced',
    )
    assert.ok(
      end.texts.some((t) => t.includes('deepseek-v4-flash-free')),
      'and named by id',
    )
    assert.ok(!end.texts.includes('等待中'), 'a finished round leaves no row waiting')
    // The tooltip carries the full story, not just the word on the badge.
    const failBadges = [...walk(mounted.rerender())].filter((n) =>
      String(n.props?.className ?? '')
        .split(' ')
        .includes('opf-probe-fail'),
    )
    assert.equal(failBadges.length, 1, 'one failed row in this catalogue')
    assert.match(String(failBadges[0].props.title), /探测超时/, 'the badge explains itself on hover')
  } finally {
    mounted.dispose()
  }
})

test('a refused round accuses no model: grey rows, one banner, separate count', async () => {
  // The reported bug. A round that ran into a gated window learned nothing
  // about any model, and for a while the card painted exactly that ignorance
  // red on every row — so a model that works in DSH wore a failure badge. The
  // refusal is a fact about the round, and it renders as one banner plus grey
  // "unmeasured" rows, never as red verdicts.
  const refused = {
    running: false,
    total: 3,
    done: 3,
    current: null,
    results: {
      'space-bunny-free': { status: 'ok', ms: 218 },
      'big-pickle': { status: 'failed', ms: 12, code: 'anon-gated', http: 403 },
      'muse-spark-1.3-contributor-free': { status: 'failed', ms: 9, code: 'quota-exhausted', http: 429 },
    },
    startedAt: 1759146617000,
  }
  const mounted = await renderCard({
    hidden: [],
    routes: ({ url, method }) => {
      if (url.endsWith('/api/probe') && method === 'GET') return { ok: true, json: async () => refused }
      return { ok: true, json: async () => SNAPSHOT }
    },
  })
  try {
    await mounted.fireTimers()
    const end = collect(mounted.rerender())
    const endHas = (cls) => end.classes.includes(cls)
    // The banner says what happened and, crucially, what it does NOT mean.
    assert.ok(
      end.texts.some((t) => t.includes('本轮没能测到')),
      'the round-level refusal is announced',
    )
    assert.ok(
      end.texts.some((t) => t.includes('不是该模型的结论')),
      'and disowned as a verdict',
    )
    // And WHEN, so a retained refusal cannot read as a current fact.
    assert.ok(
      end.texts.some((t) => /20\d\d\/\d{1,2}\/\d{1,2}/.test(t)),
      'the banner names the round time',
    )
    // The refused rows are grey "unmeasured", never red.
    assert.ok(
      end.texts.some((t) => t.includes('未测到')),
      'refused rows read as unmeasured',
    )
    const failBadges = [...walk(mounted.rerender())].filter((n) =>
      String(n.props?.className ?? '')
        .split(' ')
        .includes('opf-probe-fail'),
    )
    assert.equal(failBadges.length, 0, 'no row wears red for a refusal')
    // The answered row still shows its latency; the tally keeps the categories apart.
    assert.ok(
      end.texts.some((t) => t.includes('218ms')),
      'the answered row is unaffected',
    )
    assert.ok(endHas('opf-capsule'), 'the capsule still reports the round')
  } finally {
    mounted.dispose()
  }
})

test('a re-confirmed death is not announced as a removal that just happened', async () => {
  // The reported bug, verbatim from the 2026-09-30 03:31:17 round:
  // `deepseek-v4-flash-free` had been judged dead four hours earlier (23:30:17)
  // and had already left the list. The round re-asked it, upstream said the
  // same thing, and the card filed that under "本轮下架" — telling the reader a
  // model had just been taken away when nothing had changed since the night
  // before. The backend now says which kind of dead it is; the card must keep
  // the two apart.
  const round = {
    running: false,
    total: 2,
    done: 2,
    current: null,
    results: {
      'space-bunny-free': { status: 'ok', ms: 1196 },
      // Re-asked, re-confirmed: already dead before the round, so `removed:false`.
      'deepseek-v4-flash-free': { status: 'failed', ms: 682, code: 'dead', http: 400, removed: false },
      // Freshly removed: it was visible when the round started.
      'big-pickle': { status: 'failed', ms: 41, code: 'not-listed', http: 0, removed: true },
    },
    startedAt: 1759146617000,
  }
  const mounted = await renderCard({
    hidden: [],
    snapshot: { ...SNAPSHOT, visible: ['space-bunny-free'] },
    routes: ({ url }) => {
      if (url.endsWith('/api/probe')) return { ok: true, json: async () => round }
      return { ok: true, json: async () => SNAPSHOT }
    },
  })
  try {
    await mounted.fireTimers()
    const end = collect(mounted.rerender())
    const summary = end.texts.filter((t) => t.includes('下架') || t.includes('复核'))
    // The fresh removal is still announced — that one is real.
    assert.ok(
      end.texts.some((t) => t.includes('本轮下架：big-pickle')),
      'a real removal is still announced, by id',
    )
    // The re-confirmation is reported as exactly that, and never as a removal.
    // The two receipts share one line, so this checks the id is not filed
    // under 本轮下架 rather than that the words are absent from the line.
    assert.ok(
      summary.some((t) => t.includes('复核仍不可用：deepseek-v4-flash-free')),
      'the re-confirmation is labelled and named by id',
    )
    assert.ok(
      !summary.some((t) => t.includes('下架：deepseek-v4-flash-free')),
      'never filed under 本轮下架, which removed nothing',
    )
    // The capsule keeps the two counts apart too.
    assert.ok(
      end.texts.some((t) => /本轮下架\s*1/.test(t)),
      'the capsule counts one removal, not two',
    )
  } finally {
    mounted.dispose()
  }
})

test("a refused round names the upstream, never the reader's network", async () => {
  // The 03:31:17 round recorded eleven HTTP statuses and zero transport
  // failures: nothing reached the network layer. The banner called it "当时的
  // 网络状况", which sent the reader to debug a proxy/VPN/DNS path that was
  // never broken — and the repo's own reverse-engineering notes forbid reading a
  // FreeTierError body as a verdict about the IP. Same for the per-row advice:
  // "匿名额度被闸" claims the cause the evidence does not support.
  const refused = {
    running: false,
    total: 2,
    done: 2,
    current: null,
    results: {
      'space-bunny-free': { status: 'ok', ms: 1196 },
      'big-pickle': { status: 'failed', ms: 347, code: 'anon-gated', http: 403 },
    },
    startedAt: 1759146617000,
  }
  const mounted = await renderCard({
    hidden: [],
    routes: ({ url }) => {
      if (url.endsWith('/api/probe')) return { ok: true, json: async () => refused }
      return { ok: true, json: async () => SNAPSHOT }
    },
  })
  try {
    await mounted.fireTimers()
    const end = collect(mounted.rerender())
    const banner = end.texts.filter((t) => t.includes('本轮没能测到'))
    assert.equal(banner.length, 1, 'the refusal is announced once')
    assert.match(banner[0], /上游/, 'the banner blames the upstream answer')
    assert.doesNotMatch(banner[0], /网络状况/, "not the reader's network, which never failed")
    // The per-row tooltip must not claim the anonymous bucket was gated either:
    // a FreeTierError body is one upstream response to several conditions, and
    // a key is not guaranteed to lift it.
    const failBadges = [...walk(mounted.rerender())].filter((n) =>
      String(n.props?.className ?? '')
        .split(' ')
        .includes('opf-probe-fail'),
    )
    assert.equal(failBadges.length, 0, 'a refusal is never a red row')
    assert.ok(
      !end.texts.some((t) => t.includes('匿名额度被闸')),
      'the row advice does not assert the bucket was gated',
    )
  } finally {
    mounted.dispose()
  }
})

test('the untrusted-round note promises only what the code enforces', async () => {
  // The round-level note used to end "模型显示保持不变" — a global claim about
  // every model. What the catalogue actually enforces (src/catalog.ts) is
  // narrower and specific: an inconclusive outcome writes no verdict, so THOSE
  // models keep their visibility; a `dead` earned by sweeping both channels is
  // still recorded inside the very same round. The note now says the enforced
  // half, so it cannot be caught out by a mixed round.
  const untrusted = { ...SNAPSHOT, probeInconclusive: true }
  const mounted = await renderCard({
    hidden: [],
    // `routes` answers every fetch, so the untrusted snapshot has to come from
    // here — the `snapshot` option is only the fallback when no route is given.
    routes: () => ({ ok: true, json: async () => untrusted }),
  })
  try {
    await mounted.fireTimers()
    const end = collect(mounted.rerender())
    const note = end.texts.find((t) => t.includes('没能测到'))
    assert.ok(note !== undefined, 'the untrusted round is announced')
    assert.match(note, /这些模型的显示保持不变/, 'it names the models whose visibility is kept')
    assert.doesNotMatch(note, /结论不可信/, 'and stops claiming the whole round concluded nothing')
  } finally {
    mounted.dispose()
  }
})

test('a refusal names which upstream condition answered, not just "refused"', async () => {
  // `anon-gated` deliberately folds three upstream conditions into one code,
  // because none of them is a verdict about the model. But the reader's next
  // move differs for each: an exhausted tier, a request that failed to carry a
  // session id, and a route that only answers the OpenCode client. Three rounds
  // of diagnosis stalled on this being unanswerable, so the round now carries
  // the marker and the card shows it.
  const round = {
    running: false,
    total: 2,
    done: 2,
    current: null,
    results: {
      'space-bunny-free': { status: 'ok', ms: 1209 },
      'big-pickle': { status: 'failed', ms: 354, code: 'anon-gated', http: 403, marker: 'FreeTierError' },
    },
    startedAt: 1759146617000,
  }
  const mounted = await renderCard({
    hidden: [],
    routes: ({ url }) => {
      if (url.endsWith('/api/probe')) return { ok: true, json: async () => round }
      return { ok: true, json: async () => SNAPSHOT }
    },
  })
  try {
    await mounted.fireTimers()
    const end = collect(mounted.rerender())
    const banner = end.texts.find((t) => t.includes('本轮没能测到'))
    assert.ok(banner !== undefined, 'the refusal is announced')
    assert.match(banner, /FreeTierError/, 'the banner names the condition that answered')
    // Still hedged: knowing the marker is not a verdict about the model.
    assert.match(banner, /不是该模型的结论/, 'and still disowned as a verdict on the model')
    // A result with no marker (an older backend) must not invent one.
    assert.ok(
      !end.texts.some((t) => t.includes('MissingSessionID')),
      'a refusal without a marker does not borrow another one',
    )
  } finally {
    mounted.dispose()
  }
})

test('a live round is followed: the pill counts down and rows report progress', async () => {
  // The live view never worked. The poll timer outlives the render that created
  // it, and that render captured `probing` as it was BEFORE the click — still
  // false — so the chain returned after one tick and the pill froze while the
  // round ran on. What the reader saw was no process at all, only the final
  // report the POST reads back. Driven here across several poll ticks.
  //
  // The catalogue POST is left pending, as it is in the host: the round blocks
  // it, which is the whole time window the live view has to live in.
  const first = {
    running: true,
    total: 3,
    done: 1,
    current: 'big-pickle',
    results: { 'space-bunny-free': { status: 'ok', ms: 218 } },
    startedAt: 1759146617000,
  }
  const second = {
    running: true,
    total: 3,
    done: 2,
    current: 'muse-spark-1.3-contributor-free',
    results: {
      'space-bunny-free': { status: 'ok', ms: 218 },
      'big-pickle': { status: 'ok', ms: 402 },
    },
    startedAt: 1759146617000,
  }
  // Flipped by the test, not by a read count: how many reads happen before an
  // assertion is a property of the harness, not of the behaviour under test.
  let advance = false
  const mounted = await renderCard({
    hidden: [],
    routes: ({ url, method }) => {
      if (url.endsWith('/api/probe') && method === 'POST') return new Promise(() => {})
      if (url.endsWith('/api/probe') && method === 'GET') {
        return { ok: true, json: async () => (advance ? second : first) }
      }
      return { ok: true, json: async () => SNAPSHOT }
    },
  })
  try {
    mounted.findButton('立即探测').props.onClick()
    await mounted.fireTimers()
    const opening = collect(mounted.rerender())
    assert.ok(
      opening.texts.some((t) => t.includes('正在探测')),
      'the pill says a round is running',
    )
    assert.ok(opening.classes.includes('opf-bar'), 'with a bar to fill')
    assert.ok(
      opening.texts.some((t) => t.includes('1/3')),
      'and a count for this round',
    )
    assert.ok(
      opening.texts.some((t) => t.includes('218ms')),
      'the answered row keeps its latency',
    )
    assert.ok(
      opening.texts.some((t) => t.includes('探测中')),
      'the model being asked says so',
    )
    assert.ok(
      opening.texts.some((t) => t.includes('等待中')),
      'and the ones not asked yet are queued',
    )
    // Capability badges stay put. A round used to take them away and hand them
    // back, so every row lost its identity exactly while the reader waited to
    // find out what it was, then came back looking different for reasons that
    // had nothing to do with the model.
    assert.ok(
      opening.texts.some((t) => t.includes('视觉')),
      'the vision badge survives the round',
    )
    assert.ok(
      opening.texts.some((t) => t.includes('Max')),
      'and so does the thinking level',
    )

    // The chain must survive past the first tick — that is the whole defect:
    // the round moves on, and the pill must move with it.
    advance = true
    await mounted.fireTimers()
    const later = collect(mounted.rerender())
    assert.ok(
      later.texts.some((t) => t.includes('402ms')),
      'a later poll is still applied',
    )
    assert.ok(
      later.texts.some((t) => t.includes('2/3')),
      'and the count advanced',
    )
    assert.ok(
      later.texts.some((t) => t.includes('探测中')),
      'still following the round',
    )
  } finally {
    mounted.dispose()
  }
})

test('switched-on models are pinned to the top, each group still alphabetical', async () => {
  // Someone reading this panel is looking for "what can I use", so what they
  // can use leads. The order WITHIN each group is the catalogue's — the card
  // partitions, it does not re-sort, so there is one owner for the order.
  const shown = ['apple-free', 'mango-free', 'zebra-free']
  const off = ['banana-free', 'cherry-free']
  const ids = [...shown, ...off]
  const mounted = await renderCard({
    hidden: ['banana-free', 'cherry-free'],
    snapshot: {
      ...SNAPSHOT,
      visible: ids,
      models: ids.map((id) => ({ id, image: false, thinking: null })),
    },
  })
  try {
    const { texts } = collect(mounted.rerender())
    assert.deepEqual(
      texts.filter((t) => ids.includes(t)),
      [...shown, ...off],
      'the on-switch group leads, the off-switch group follows, both alphabetical',
    )
  } finally {
    mounted.dispose()
  }
})

test('a model outside the round wears no probe badge at all', async () => {
  // A round only asks about the models the user has switched ON. The panel used
  // to call every untouched row "waiting", which promises a round that will
  // never reach it — a model the user deliberately switched off was announced
  // as queued. Only the server knows the round's scope, so it sends it.
  const live = {
    running: true,
    total: 1,
    done: 0,
    current: 'big-pickle',
    // Only one of the two models is in this round.
    targets: ['big-pickle'],
    results: {},
    startedAt: 1759146617000,
  }
  const mounted = await renderCard({
    hidden: [],
    routes: ({ url, method }) => {
      if (url.endsWith('/api/probe') && method === 'POST') return new Promise(() => {})
      if (url.endsWith('/api/probe') && method === 'GET') return { ok: true, json: async () => live }
      return { ok: true, json: async () => SNAPSHOT }
    },
  })
  try {
    mounted.findButton('立即探测').props.onClick()
    await mounted.fireTimers()
    const mid = collect(mounted.rerender())
    // The covered model is in flight and says so.
    assert.ok(
      mid.texts.some((t) => t.includes('探测中')),
      'the covered row spins',
    )
    // The uncovered one says nothing at all — no badge, and not dimmed either.
    const rows = [...walk(mounted.rerender())].filter(
      (n) => n.tag === 'label' && String(n.props?.className).split(' ').includes('opf-row'),
    )
    const byId = (needle) => rows.find((r) => [...walk(r)].some((d) => d.text === needle))
    const coveredRow = byId('big-pickle')
    const skippedRow = byId('space-bunny-free')
    assert.ok(coveredRow, 'the covered row renders')
    assert.ok(skippedRow, 'the skipped row still renders')
    const hasProbeBadge = (row) =>
      [...walk(row)].some((d) =>
        String(d.props?.className ?? '')
          .split(' ')
          .some((c) => c.startsWith('opf-probe')),
      )
    assert.ok(hasProbeBadge(coveredRow), 'the covered row wears a probe badge')
    assert.ok(!hasProbeBadge(skippedRow), 'the skipped row wears none')
    assert.ok(
      !String(skippedRow.props?.className).includes('opf-row-waiting'),
      'and is not dimmed as if queued',
    )
  } finally {
    mounted.dispose()
  }
})

test('zh and en dictionaries carry the same key set', async () => {
  const src = await readFile(CLIENT_URL, 'utf8')
  const grab = (tag) => {
    const start = src.indexOf(`var ${tag} = {`)
    const end = src.indexOf('\n\t\t};', start)
    const body = src.slice(start, end)
    return [...body.matchAll(/"([a-zA-Z.]+)":/g)].map((m) => m[1]).sort()
  }
  const zh = grab('zh')
  const en = grab('en')
  assert.ok(zh.length > 0 && en.length > 0, 'both dictionaries exist')
  assert.deepEqual(zh, en, 'a key in one language but not the other renders half-translated')
})

// ── the blind-spot note ─────────────────────────────────────────────────────
//
// Zen sometimes serves a free-tier id before models.dev publishes metadata for
// it. The panel reports that as a fact and offers nothing: listing the id would
// mean claiming a context length this plugin cannot know, and a wrong number is
// acted on, not merely displayed.

const noteText = (mounted) => collect(mounted.tree).texts.join(' ')

test('an empty unknownFree renders no note at all', async () => {
  const mounted = await renderCard({ snapshot: { ...SNAPSHOT, unknownFree: [] } })
  try {
    const { texts } = collect(mounted.tree)
    assert.equal(
      texts.some((t) => t.includes('models.dev')),
      false,
      'nothing to report, nothing to say',
    )
  } finally {
    mounted.dispose()
  }
})

test('a host that predates the report degrades to no note', async () => {
  const legacy = { ...SNAPSHOT }
  delete legacy.unknownFree
  const mounted = await renderCard({ snapshot: legacy })
  try {
    const { texts } = collect(mounted.tree)
    assert.equal(
      texts.some((t) => t.includes('models.dev')),
      false,
      'an absent field is not an empty list to complain about',
    )
    assert.equal(texts.length > 0, true, 'and the card still renders its rows')
  } finally {
    mounted.dispose()
  }
})

test('an unknown free id is named, and never becomes a row', async () => {
  const mounted = await renderCard({ snapshot: { ...SNAPSHOT, unknownFree: ['jev-1.13-free'] } })
  try {
    const { texts } = collect(mounted.tree)
    const note = texts.find((t) => t.includes('models.dev'))
    assert.ok(note !== undefined, 'the note explains why the list is short')
    assert.ok(note.includes('jev-1.13-free'), 'and names what is missing')
    // The decisive half: an id with no metadata must not be selectable.
    const offered = ['space-bunny-free', 'big-pickle', 'muse-spark-1.3-contributor-free']
    assert.equal(texts.filter((t) => offered.includes(t)).length, 3, 'the offered set is unchanged')
    // Split-and-includes, matching this file's convention (see the class
    // assertions above): a round in progress adds `opf-row-probing`, and a
    // strict equality would under-count exactly when an extra row is likeliest.
    const rowNodes = [...walk(mounted.tree)].filter((n) =>
      String(n.props?.className ?? '')
        .split(' ')
        .includes('opf-row'),
    )
    assert.equal(rowNodes.length, 3, 'three rows, not four')
    assert.equal(
      rowNodes.some((row) => [...walk(row)].some((d) => d.text === 'jev-1.13-free')),
      false,
      'the reported id is not inside any row',
    )
  } finally {
    mounted.dispose()
  }
})

test('the note caps the id list and counts the rest', async () => {
  const mounted = await renderCard({
    snapshot: { ...SNAPSHOT, unknownFree: ['a-free', 'b-free', 'c-free', 'd-free', 'e-free'] },
  })
  try {
    const { texts } = collect(mounted.tree)
    const note = texts.find((t) => t.includes('models.dev'))
    assert.ok(note.includes('a-free, b-free, c-free'), 'the first three are shown')
    assert.ok(note.includes('(+2)'), 'and the remainder is counted, not listed')
    assert.equal(note.includes('e-free'), false, 'the tail is a count, not a second inventory')
  } finally {
    mounted.dispose()
  }
})

test('the note is localised like every other string on the card', async () => {
  const mounted = await renderCard({
    locale: 'en',
    snapshot: { ...SNAPSHOT, unknownFree: ['jev-1.13-free'] },
  })
  try {
    const { texts } = collect(mounted.tree)
    const note = texts.find((t) => t.includes('carries no metadata for'))
    assert.ok(note !== undefined, 'an English host gets the English note')
    assert.equal(
      texts.some((t) => t.includes('却没有它们的资料')),
      false,
    )
  } finally {
    mounted.dispose()
  }
})

test('the manual round closes on the poll, not on the POST that started it', async () => {
  // The POST used to stay open for the whole round. It now answers as soon as
  // the round is accepted, which moves two jobs onto the poll chain: noticing
  // that the round ENDED, and releasing the busy button. The trap is the first
  // poll — the host reports `running: false` until the round has actually
  // started, and a client that reads that as "finished" ends the round it just
  // asked for, freezing the progress area and leaving a live round invisible.
  //
  // Phases are set by the test rather than counted: how many reads land before
  // an assertion is a property of the harness, not of the behaviour.
  const preRound = {
    running: false,
    total: 0,
    done: 0,
    current: null,
    results: {},
    targets: null,
    startedAt: 0,
  }
  const live = {
    running: true,
    total: 3,
    done: 1,
    current: 'big-pickle',
    results: { 'space-bunny-free': { status: 'ok', ms: 218 } },
    startedAt: 1759146617000,
  }
  const done = {
    running: false,
    total: 3,
    done: 3,
    current: null,
    results: {
      'space-bunny-free': { status: 'ok', ms: 218 },
      'big-pickle': { status: 'ok', ms: 402 },
      'muse-spark-1.3-contributor-free': { status: 'failed', ms: 15003, code: 'timeout', http: 0 },
    },
    startedAt: 1759146617000,
  }
  let phase = 'preRound'
  const mounted = await renderCard({
    hidden: [],
    routes: ({ url, method }) => {
      if (url.endsWith('/api/probe') && method === 'POST') {
        return { ok: true, status: 202, json: async () => SNAPSHOT }
      }
      if (url.endsWith('/api/probe') && method === 'GET') {
        return { ok: true, json: async () => (phase === 'live' ? live : phase === 'done' ? done : preRound) }
      }
      return { ok: true, json: async () => SNAPSHOT }
    },
  })
  try {
    mounted.findButton('立即探测').props.onClick()
    await mounted.fireTimers()
    assert.ok(
      collect(mounted.rerender()).texts.some((t) => t.includes('探测中')),
      'a pre-round reading is not a finished round: the button stays busy',
    )

    phase = 'live'
    await mounted.fireTimers()
    assert.ok(
      collect(mounted.rerender()).texts.some((t) => t.includes('1/3')),
      'the live round is followed',
    )

    phase = 'done'
    await mounted.fireTimers()
    const settled = collect(mounted.rerender())
    assert.ok(
      settled.texts.some((t) => t.includes('探测完成')),
      'and the finished report is shown',
    )
    assert.equal(
      [...walk(mounted.rerender())].some(
        (n) => n.tag === 'button' && [...walk(n)].some((d) => d.text === '立即探测'),
      ),
      true,
      'the button is released when the poll sees the round end, not when the POST returns',
    )
  } finally {
    mounted.dispose()
  }
})

test('a throttled click says so, with the number, instead of spinning', async () => {
  // The route used to answer 202 to a click that never started a round, so the
  // card waited out AWAIT_GRACE_MS (30s) with nothing on screen — the exact
  // "I clicked probe and nothing happened" report. 429 is a real answer with a
  // real number in it, and the card must show that number rather than a spinner.
  const mounted = await renderCard({
    hidden: [],
    routes: ({ url, method }) => {
      if (url.endsWith('/api/probe') && method === 'POST') {
        return { ok: false, status: 429, json: async () => ({ error: 'cooldown', retryAfterMs: 243_000 }) }
      }
      return { ok: true, json: async () => SNAPSHOT }
    },
  })
  try {
    mounted.findButton('立即探测').props.onClick()
    await mounted.fireTimers()
    const texts = collect(mounted.rerender()).texts
    assert.ok(
      texts.some((t) => t.includes('分钟')),
      'the card names the remaining wait, rounded up to whole minutes',
    )
    assert.equal(
      texts.some((t) => t.includes('探测中')),
      false,
      'and it does NOT sit in the probing state for a round that never started',
    )
    assert.equal(
      [...walk(mounted.rerender())].some(
        (n) => n.tag === 'button' && [...walk(n)].some((d) => d.text === '立即探测'),
      ),
      true,
      'the button is released immediately',
    )
  } finally {
    mounted.dispose()
  }
})

test('every palette colour meets WCAG AA against the card', async () => {
  // Audit 2026-09-30: all 26 text colours were measured with the WCAG 2.1
  // relative-luminance formula and NONE reached 4.5:1 — including the probe
  // outcome badges and the "these models could not be measured" banner, i.e.
  // exactly the dense, must-read part of the panel. Colours were darkened; this
  // test exists so a future theme change cannot silently regress them.
  const css = String(CSS_TEXT)
  const rules = [...css.matchAll(/\.(opf-[a-z-]+)\{[^}]*color:(#[0-9A-Fa-f]{6})/g)]
  assert.ok(rules.length > 20, `the palette is actually being read (${rules.length} rules)`)

  const luminance = (hex) => {
    const c = [0, 2, 4]
      .map((i) => parseInt(hex.substr(i, 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }

  const offenders = []
  for (const [, selector, colour] of rules) {
    const r = ratio(colour.slice(1), 'FFFFFF')
    if (r < 4.5) offenders.push(`${selector} ${colour} = ${r.toFixed(2)}:1`)
  }
  assert.deepEqual(
    offenders,
    [],
    `every text colour must reach AA 4.5:1 on the white card: ${offenders.join(', ')}`,
  )

  // The switch input is 0x0 and fully transparent, so the browser's own focus
  // ring disappears with it — the visible indicator has to be re-declared or a
  // keyboard user gets no focus feedback at all.
  assert.match(css, /:focus-visible\+/, 'the switch re-declares a focus indicator')
  assert.match(css, /:focus-within/, 'and the active row is marked too')
})

test('unmounting mid-round stops the poll chain', async () => {
  // Audit 2026-09-30: `pollTimer` / `pollActive` / `awaitingRound` were function
  // body `var`s. Every render produced fresh ones, while the `useEffect([])`
  // cleanup captured the FIRST render's copy — so unmounting cleared a variable
  // that was always null, and the timer the click had actually created kept
  // firing `GET /api/probe` every 800ms against a component that no longer
  // existed. React 18 discards a setState on an unmounted tree without even a
  // warning, so it produced no symptom at all.
  //
  // The old suite could not see this: every test disposed AFTER the round had
  // finished, never while `running: true`. Mutating the cleanup into a no-op
  // left 18/18 green.
  const live = {
    running: true,
    total: 2,
    done: 0,
    current: 'big-pickle',
    results: {},
    startedAt: 1759146617000,
  }
  let probeGets = 0
  const mounted = await renderCard({
    hidden: [],
    routes: ({ url, method }) => {
      if (url.endsWith('/api/probe') && method === 'POST') return new Promise(() => {})
      if (url.endsWith('/api/probe') && method === 'GET') {
        probeGets += 1
        return { ok: true, json: async () => live }
      }
      return { ok: true, json: async () => SNAPSHOT }
    },
  })

  mounted.findButton('立即探测').props.onClick()
  await mounted.fireTimers()
  assert.ok(probeGets > 0, 'the chain is running while the card is mounted')

  // The card goes away mid-round — the case that used to leak. unmount() runs the
  // useEffect cleanups (dispose() only restores the global stubs, and calling it
  // while the chain is live would hand the chain the REAL setTimeout back).
  mounted.unmount()
  const atUnmount = probeGets
  await mounted.fireTimers()
  await mounted.fireTimers()

  assert.equal(probeGets, atUnmount, 'no further polls after unmount — the timer was really cleared')
  mounted.dispose()
})

test('a watched automatic round re-reads the catalogue when it ends', async () => {
  // The reload after a finished round used to run only for a round a click had
  // awaited. An automatic round — the daily one, or the lazy read that starts
  // one — left the card holding the metadata it loaded at mount: a stale "last
  // probed" time and stale inconclusive wording, until the page was reopened
  //.
  //
  // The card is mounted while the round is ALREADY running, which is how a page
  // opened during the daily round meets it. The catalogue answers differently
  // before and after the round ends, so what the card SHOWS is the evidence —
  // counting requests would only measure this harness's own mount loop.
  const live = {
    running: true,
    total: 3,
    done: 1,
    current: 'big-pickle',
    results: { 'big-pickle': { status: 'ok', ms: 90 } },
    startedAt: 1759146617000,
  }
  const done = {
    running: false,
    total: 3,
    done: 3,
    current: null,
    results: {
      'big-pickle': { status: 'ok', ms: 90 },
      'space-bunny-free': { status: 'failed', ms: 15003, code: 'timeout', http: 0 },
      'muse-spark-1.3-contributor-free': { status: 'ok', ms: 210 },
    },
    startedAt: 1759146617000,
  }
  // Never probed, so there is no time to show, and nothing was measured. This is
  // what the reader was looking at instead of the round they had just watched.
  const STALE = { ...SNAPSHOT, probedAt: 0, probeInconclusive: false }
  const FRESH = { ...SNAPSHOT, probeInconclusive: true }
  let phase = 'live'
  const mounted = await renderCard({
    hidden: [],
    routes: ({ url, method }) => {
      if (url.endsWith('/api/probe') && method === 'GET') {
        return { ok: true, json: async () => (phase === 'done' ? done : live) }
      }
      return { ok: true, json: async () => (phase === 'done' ? FRESH : STALE) }
    },
  })
  try {
    await mounted.fireTimers()
    const before = collect(mounted.rerender()).texts
    assert.ok(
      before.some((t) => t.includes('1/3')),
      'the automatic round is followed',
    )
    assert.equal(
      before.some((t) => t.includes('本轮有模型没能测到')),
      false,
      'and nothing has been measured yet',
    )
    assert.equal(
      before.some((t) => t.includes('1970')),
      false,
      'a catalogue that has never been probed shows no 1970 stamp at all',
    )

    phase = 'done'
    await mounted.fireTimers()
    await mounted.fireTimers()
    const after = collect(mounted.rerender()).texts
    assert.ok(
      after.some((t) => t.includes('探测完成')),
      'the finished report is shown',
    )
    assert.ok(
      after.some((t) => t.includes('本轮有模型没能测到')),
      'and the card re-read the catalogue: the inconclusive notice is the round that just ran',
    )
  } finally {
    mounted.dispose()
  }
})

test('the probe timestamp needs a real time, not the epoch', async () => {
  // `0` is what a catalogue that has never been probed reports, and rendering it
  // as a date put a 1970 stamp on the card. Pinned here
  // because the stamp is the only place the value reaches the reader.
  const mounted = await renderCard({ hidden: [], snapshot: { ...SNAPSHOT, probedAt: 0 } })
  try {
    await mounted.fireTimers()
    const texts = collect(mounted.rerender()).texts
    assert.equal(
      texts.some((t) => t.includes('1970')),
      false,
      'never probed shows no stamp',
    )
    assert.equal(
      texts.some((t) => t.includes('上次探测')),
      false,
      'and no "last probed" line at all',
    )
  } finally {
    mounted.dispose()
  }
})

test('a slow catalogue gate does not end the poll before the requested round starts', async () => {
  // The backend publishes `running: true` only after the Zen catalogue gate
  // answers, and that gate costs one cheap GET. A round slower than the poll
  // interval therefore hands the card the PREVIOUS round's report — which reads
  // as complete. `awaiting` existed to cover exactly this and did so on the
  // first read, but the poll chain consumed it on the next one: the button came
  // back, the panel settled, and the round that really did start was never seen
  //. Every round carries a `startedAt`, so the stamp on
  // screen when the button was pressed is what tells the two apart.
  const OLD = 1759146617000
  const previous = {
    running: false,
    total: 2,
    done: 2,
    current: null,
    results: {
      'big-pickle': { status: 'ok', ms: 90 },
      'space-bunny-free': { status: 'failed', ms: 15003, code: 'timeout', http: 0 },
    },
    targets: null,
    startedAt: OLD,
  }
  const live = {
    running: true,
    total: 3,
    done: 1,
    current: 'muse-spark-1.3-contributor-free',
    results: { 'muse-spark-1.3-contributor-free': { status: 'ok', ms: 140 } },
    startedAt: OLD + 5000,
  }
  const done = {
    running: false,
    total: 3,
    done: 3,
    current: null,
    results: {
      'big-pickle': { status: 'ok', ms: 90 },
      'space-bunny-free': { status: 'failed', ms: 15003, code: 'timeout', http: 0 },
      'muse-spark-1.3-contributor-free': { status: 'ok', ms: 140 },
    },
    targets: null,
    startedAt: OLD + 5000,
  }
  let phase = 'previous'
  let polls = 0
  const mounted = await renderCard({
    hidden: [],
    routes: ({ url, method }) => {
      if (url.endsWith('/api/probe') && method === 'POST') {
        return { ok: true, status: 202, json: async () => SNAPSHOT }
      }
      if (url.endsWith('/api/probe') && method === 'GET') {
        polls += 1
        if (phase === 'previous') return { ok: true, json: async () => previous }
        if (phase === 'live') return { ok: true, json: async () => live }
        return { ok: true, json: async () => done }
      }
      return { ok: true, json: async () => SNAPSHOT }
    },
  })
  try {
    // The card finishes its first read first, as a reader's would: the previous
    // round is ON SCREEN when the button is pressed, which is the state the
    // stamp is captured from.
    await mounted.fireTimers()
    mounted.findButton('立即探测').props.onClick()
    await mounted.fireTimers()
    // The gate has not answered, so every read is still the previous round.
    await mounted.fireTimers()
    await mounted.fireTimers()
    assert.ok(polls >= 2, 'the chain kept polling through the stale readings')
    // The harm was the panel settling and the button coming back while the
    // round the reader asked for had not even started. It stays busy.
    assert.ok(
      collect(mounted.rerender()).texts.some((t) => t.includes('探测中')),
      'and the button stays busy: the requested round has not reported yet',
    )
    const pollsBeforeLive = polls
    assert.ok(polls > 2, 'the chain is still asking, not just idle-but-busy')

    phase = 'live'
    await mounted.fireTimers()
    assert.ok(
      collect(mounted.rerender()).texts.some((t) => t.includes('1/3')),
      'the round that really started is followed',
    )

    phase = 'done'
    await mounted.fireTimers()
    await mounted.fireTimers()
    const settled = collect(mounted.rerender()).texts
    assert.ok(
      settled.some((t) => t.includes('探测完成')),
      'and its report is shown',
    )
    assert.ok(
      [...walk(mounted.rerender())].some(
        (n) => n.tag === 'button' && [...walk(n)].some((d) => d.text === '立即探测'),
      ),
      'the button is released when THAT round ends, not when the stale one did',
    )
  } finally {
    mounted.dispose()
  }
})

test('GUARD: a click whose first progress read FAILS still waits for the round', async () => {
  // Right after a restart is the case that breaks it. The card mounts and issues
  // its first read; the plugin's route is not answering yet (or the read fails),
  // so `loadProgress()` resolves to null and `pollRef.current.last` stays null.
  // The reader clicks in that window, `saw` is null, and the click handler's own
  // read takes the same branch:
  //
  //     if (reading === null || reading.running === true) { adopt(reading); return; }
  //
  // `adopt(null)` returns immediately, so the POLL CHAIN IS NEVER ARMED. Nothing
  // is watching, the POST answers only when the round is over (29s measured), and
  // the panel shows a button that blinked once and then nothing at all.
  //
  // No identity on screen means nothing can be ruled out, which is an argument for
  // arming the poll, not for concluding. The grace still bounds it, so a backend
  // that never starts the round still releases the button.
  const OLD = 1759146617000
  const previous = {
    running: false,
    total: 2,
    done: 2,
    current: null,
    results: { 'big-pickle': { status: 'ok', ms: 90 } },
    targets: null,
    startedAt: OLD,
  }
  const live = {
    running: true,
    total: 3,
    done: 1,
    current: 'muse-spark-1.3-contributor-free',
    results: { 'muse-spark-1.3-contributor-free': { status: 'ok', ms: 140 } },
    startedAt: OLD + 5000,
  }
  let polls = 0
  let clicked = false
  const mounted = await renderCard({
    hidden: [],
    routes: ({ url, method }) => {
      if (url.endsWith('/api/probe') && method === 'POST') {
        clicked = true
        return { ok: true, status: 202, json: async () => SNAPSHOT }
      }
      if (url.endsWith('/api/probe') && method === 'GET') {
        // EVERY read before the click fails — the route is not up yet, which is
        // what the window right after a restart looks like.
        if (!clicked) return { ok: false, status: 503, json: async () => null }
        polls += 1
        return { ok: true, json: async () => (polls <= 1 ? previous : live) }
      }
      return { ok: true, json: async () => SNAPSHOT }
    },
  })
  try {
    mounted.findButton('立即探测').props.onClick()
    // Each flush runs the promises armed by the previous one, so the chain needs
    // a few ticks to reach the round that is really running.
    await mounted.fireTimers()
    await mounted.fireTimers()
    await mounted.fireTimers()
    await mounted.fireTimers()
    assert.ok(polls >= 3, 'the poll chain is armed even though the first read failed')
    assert.ok(
      collect(mounted.rerender()).texts.some((t) => t.includes('探测中')),
      'and the button stays busy, because nothing observed rules the stale reading out',
    )
  } finally {
    mounted.dispose()
  }
})

test('GUARD: the row states the limits that are IN EFFECT, and hides the provenance', async () => {
  // Asked directly: "当前配置的最大输出大小是多少，没看懂". The row answered with
  // four figures and two arrows — `输出预算 131,072 → 262,144`, `路由自述上限
  // 262,144`, `实测产出 ≥64,000` — and every one of them was true, and the
  // reader still could not say what the plugin SENDS. A line cannot be made true
  // enough to be readable; it has to be shortened.
  //
  // So the line carries the effective values only, and everything about where
  // they came from is one hover away. The declared value is NOT struck through in
  // the open any more: a strikethrough next to the live number reads as "this is
  // what you get" to anyone who has not internalised the convention.
  const mounted = await renderCard({
    hidden: [],
    snapshot: {
      ...SNAPSHOT,
      visible: ['longcat-2.5-preview-free'],
      models: [
        {
          id: 'longcat-2.5-preview-free',
          image: true,
          thinking: 'high',
          contextWindow: 1000000,
          outputBudget: 262144,
          declaredContext: 1000000,
          declaredOutput: 131072,
          observedOutput: 64000,
          stated: { output: 262144, at: 1759146617000 },
          evidence: { context: 'declared', output: 'witnessed', vision: 'route', tools: 'route' },
        },
      ],
    },
  })
  // The two limits are sibling spans, so the row is read as one line of text.
  // Titles are attributes, not text — which is the whole point: the provenance is
  // present on the row without being IN the row.
  const line = collect(mounted.rerender()).texts.join(' ')
  assert.match(line, /1,000,000/, 'the context window is on the row')
  assert.match(line, /262,144/, 'the number that is actually SENT is on the row')
  assert.doesNotMatch(line, /131,072/, 'the replaced declaration is not competing for the eye')
  assert.doesNotMatch(line, /64,000/, 'nor is what the model was watched writing')
  const titled = [...walk(mounted.rerender())].filter((n) => typeof n.props?.title === 'string' && n.props.title.length > 0)
  const outputNode = titled.find((n) => n.props.title.includes('262,144'))
  assert.ok(outputNode !== undefined, 'and the provenance is one hover away')
  assert.match(outputNode.props.title, /131,072/, 'the declaration it replaced')
  assert.match(outputNode.props.title, /64,000/, 'what the model was actually watched writing')
  // The harness swaps `setTimeout` for a capturing stub and only puts it back on
  // dispose. A test that leaves it installed makes the NEXT test's render loop
  // wait on a timer that is never fired — a hang with no error anywhere, which is
  // what this file did to itself twice today.
  mounted.dispose()
})

test('GUARD: a badge that is on every row is not a badge', async () => {
  // Asked, correctly: tool calling works on every model here, so what is the
  // badge telling me? Measured over the live set — 9 rows carried the tool badge,
  // two were unmeasured, and NOT ONE ever lacked it. A mark that appears on every
  // row asserts nothing a reader would not have assumed, and it takes space that
  // a varying capability should have.
  //
  // Vision is the contrast that keeps the other two: 7 rows declare image input
  // and 5 do not, so that badge carries a decision — DSH refuses to attach a
  // screenshot to a model that does not take one. Thinking never says "cannot"
  // either, but it names the LEVEL you will be offered, which is a setting rather
  // than a claim.
  //
  // So the tool badge is gone and the measurement moved to the model name, which
  // is the one element that means "this model". The measurement must survive: if
  // a model ever refuses to call a tool, that is the fact that earns the badge
  // back, and nothing here may throw the evidence away.
  const mounted = await renderCard({
    hidden: [],
    snapshot: {
      ...SNAPSHOT,
      visible: ['space-bunny-free', 'big-pickle'],
      models: [
        { id: 'space-bunny-free', image: true, thinking: 'max', contextWindow: 1048576, outputBudget: 524288, declaredContext: 1048576, declaredOutput: 524288, evidence: { context: 'declared', output: 'declared', vision: 'route', tools: 'route' } },
        { id: 'big-pickle', image: false, thinking: 'high', contextWindow: 200000, outputBudget: 48000, declaredContext: 200000, declaredOutput: 32000, evidence: { context: 'route', output: 'witnessed', vision: 'none', tools: 'route' } },
      ],
    },
  })
  const nodes = [...walk(mounted.rerender())]
  const badges = nodes.filter((n) => String(n.props?.className ?? '').includes('opf-badge'))
  // The card's footer legend keeps one, because the free tier's admission rule is
  // a fact about THIS PLUGIN rather than about any model, and it is worth saying
  // once. What must not survive is the per-row one.
  const toolBadges = badges.filter((n) => String(n.props.className).includes('opf-badge-tools'))
  assert.equal(toolBadges.length, 1, 'exactly one tools badge, and it is the legend')
  assert.match(
    [...walk(toolBadges[0])].filter((n) => n.text).map((n) => n.text).join(''),
    /read/,
    'the legend states the admission rule instead of a per-model claim',
  )
  assert.match(String(toolBadges[0].props.title ?? ''), /read|bash/, 'and explains it on hover')
  assert.ok(
    badges.some((n) => String(n.props.className).includes('opf-badge-vision')),
    'the vision badge stays: it is the capability that actually varies',
  )
  // The evidence is not discarded with the badge: it moves to the model name,
  // which is the one element on the row that means "this model".
  const idNodes = nodes.filter((n) => String(n.props?.className ?? '') === 'opf-id')
  assert.equal(idNodes.length, 2, 'one per row')
  for (const node of idNodes) assert.match(String(node.props.title ?? ''), /工具/, 'tools stay listed where they were verified')
})
