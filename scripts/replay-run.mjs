// Headless replay run (tier B2 of docs/offline-replay-design.md).
//
//   pnpm replay --dsh <version> [--scenario <id>] [--keep]
//
// Installs the given DSH and this repo's packed plugin into a temp DSH_HOME,
// points opencode.ai at a loopback fake (scripts/replay-preload.cjs), and runs
// scripted scenarios through a real headless DSH. No request reaches Zen, so it
// spends no anonymous quota. Installing DSH needs the npm registry; the scenarios
// themselves need no network. Unlike the compat run it is not tied to a shared
// bucket, so it may run in CI. It never touches ~/.dsh or a running DSH.
//
// Exit codes: 0 every scenario passed, 1 a scenario failed or setup failed,
// 3 a precondition was refused and nothing was installed.
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { childEnv } from './replay-env.mjs'
import { completionsText, responsesText } from './replay-fixtures.mjs'
import { SCENARIOS } from './replay-scenarios.mjs'
import { startUpstream } from './replay-upstream.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PRELOAD = join(REPO, 'scripts', 'replay-preload.cjs')
const USAGE = 'usage: pnpm replay --dsh <version> [--scenario <id>] [--keep]'
const EXIT_PRECONDITION = 3
const BOOT_TIMEOUT_MS = 120_000
const ROUND_TIMEOUT_MS = 60_000
const RUN_TIMEOUT_MS = 120_000

const delay = (ms) => new Promise((done) => setTimeout(done, ms))

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer()
    server.on('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })
}

/** How to call pnpm without a shell; run as `pnpm replay`, pnpm names its entry point. */
function pnpmCommand() {
  const entry = process.env.npm_execpath
  if (entry === undefined || entry === '' || !/pnpm/i.test(entry)) throw new Error(`run this through pnpm so it can find pnpm without a shell: ${USAGE}`)
  return /\.[cm]?js$/i.test(entry) ? [process.execPath, entry] : [entry]
}

async function main() {
  let args
  try {
    args = parseArgs({ options: { dsh: { type: 'string' }, scenario: { type: 'string' }, keep: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false } } }).values
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`)
    return EXIT_PRECONDITION
  }
  if (args.help) { console.log(USAGE); return 0 }
  const pkg = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8'))
  const pins = [pkg.peerDependencies?.['@deepseek-ai/dsh-llm'], pkg.peerDependencies?.['@deepseek-ai/dsh-llm-pi-ai']]
  if (args.dsh === undefined || pins.some((pin) => pin !== args.dsh)) {
    console.error(`--dsh must equal both exact peer pins in package.json (${pins.join(', ')})\n${USAGE}`)
    return EXIT_PRECONDITION
  }
  const selected = args.scenario === undefined ? SCENARIOS : SCENARIOS.filter((s) => s.id === args.scenario)
  if (selected.length === 0) {
    console.error(`unknown scenario ${args.scenario}; known: ${SCENARIOS.map((s) => s.id).join(', ')}\n${USAGE}`)
    return EXIT_PRECONDITION
  }

  const host = await installHost({ dsh: args.dsh })
  const results = []
  try {
    await preflight(host)
    for (const scenario of selected) {
      console.error(`replay: ${scenario.id} ${scenario.title}`)
      host.upstream.reset()
      const started = Date.now()
      try {
        await scenario.run(host.context())
        results.push({ id: scenario.id, title: scenario.title, ok: true, ms: Date.now() - started })
      } catch (error) {
        results.push({ id: scenario.id, title: scenario.title, ok: false, ms: Date.now() - started, reason: error instanceof Error ? error.message : String(error) })
      }
    }
  } finally {
    await host.dispose(args.keep)
  }

  console.log(`\nReplay run: DSH ${args.dsh}, plugin ${pkg.version}, ${host.versions}\n`)
  console.log('| scenario | result | ms | detail |\n| --- | --- | --- | --- |')
  for (const r of results) console.log(`| ${r.id} ${r.title} | ${r.ok ? 'pass' : 'FAIL'} | ${r.ms} | ${r.ok ? '-' : r.reason.split('\n')[0]} |`)
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${failed.length === 0 ? 'All scenarios passed.' : `${failed.length} scenario(s) failed.`} Offline: no request reached Zen.`)
  return failed.length === 0 ? 0 : 1
}

/** Install DSH and the packed plugin in a fresh temp root and start the fake. */
async function installHost({ dsh }) {
  const pnpm = pnpmCommand()
  const root = await mkdtemp(join(tmpdir(), 'dsh-replay-'))
  const home = join(root, 'home')
  const ws = join(root, 'ws')
  const children = new Set()
  let upstream
  let disposed = false

  // Install steps run without the redirect; every DSH process gets it (replayEnv).
  const installEnv = () => childEnv(process.env, { home })
  const start = ([command, ...argv], { cwd, env, input }) => {
    const child = spawn(command, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    children.add(child)
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (c) => (stdout += c))
    child.stderr.setEncoding('utf8').on('data', (c) => (stderr += c))
    if (input !== undefined) child.stdin.end(input)
    const exited = new Promise((done) => {
      child.on('error', (e) => { stderr += `\n${e.message}`; done(null) })
      child.on('close', (code) => done(code))
    }).finally(() => children.delete(child))
    return { child, exited, output: () => ({ stdout, stderr }) }
  }
  const step = async (label, argv, cwd) => {
    const run = start(argv, { cwd, env: installEnv(), input: '' })
    const code = await run.exited
    if (code !== 0) throw new Error(`${label} exited with code ${code}`)
    return run.output().stdout
  }

  try {
    await mkdir(join(root, 'dsh'))
    await mkdir(ws)
    await writeFile(join(root, 'dsh', 'package.json'), '{ "name": "dsh-replay-host", "private": true }\n')
    await step('installing DSH', [...pnpm, 'add', `@deepseek-ai/dsh@${dsh}`, '--config.node-linker=hoisted', '--config.dangerously-allow-all-builds=true'], join(root, 'dsh'))
    const dshPkgDir = join(root, 'dsh', 'node_modules', '@deepseek-ai', 'dsh')
    const dshPkg = JSON.parse(await readFile(join(dshPkgDir, 'package.json'), 'utf8'))
    const dshBin = join(dshPkgDir, typeof dshPkg.bin === 'string' ? dshPkg.bin : dshPkg.bin.dsh)
    const version = (await step('dsh --version', [process.execPath, dshBin, '--version'], root)).trim()
    if (version !== dsh) throw new Error(`installed DSH reports ${version}, not ${dsh}`)
    await step('pnpm pack', [...pnpm, 'pack', '--pack-destination', root], REPO)
    const tarball = (await readdir(root)).find((name) => name.startsWith('dsh-opencode-free-') && name.endsWith('.tgz'))
    if (tarball === undefined) throw new Error('pnpm pack produced no dsh-opencode-free tarball')
    await mkdir(home)
    await step('installing the plugin', [process.execPath, dshBin, 'plugin', '--profile', 'headless', 'add', `file:${join(root, tarball)}`], root)
    upstream = await startUpstream({ dir: root })
    console.error(`replay: DSH ${dsh} and ${tarball} installed under ${root}`)
  } catch (error) {
    await cleanup()
    throw error
  }

  const replayEnv = () => childEnv(process.env, { home, redirect: { ca: upstream.ca, preload: PRELOAD, port: upstream.port } })

  async function cleanup(keep = false) {
    for (const child of children) child.kill()
    if (upstream !== undefined) await upstream.close()
    if (disposed) return
    disposed = true
    if (keep) { console.error(`replay: kept ${root} (DSH_HOME=${home})`); return }
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('dsh-replay-')) throw new Error('refusing cleanup outside the replay temporary directory')
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  }

  const versions = []
  for (const name of ['@deepseek-ai/dsh-llm', '@earendil-works/pi-ai']) {
    versions.push(`${name.split('/').pop()} ${JSON.parse(await readFile(join(root, 'dsh', 'node_modules', name, 'package.json'), 'utf8')).version}`)
  }

  function writeOverlay({ port, model, effort, headroomTokens }) {
    const lines = [
      '- insert:',
      '    - id: webserver',
      "      name: '@deepseek-ai/dsh-host-webserver'",
      '      config:',
      "        host: '127.0.0.1'",
      `        port: ${port}`,
      '- id: session-title-llm',
      '  disabled: true',
    ]
    if (model !== undefined) {
      lines.push('- id: agent-default-model', '  config:', '    provider: opencode-zen-free', `    model: ${JSON.stringify(model)}`)
      if (effort !== undefined) lines.push(`    reasoningEffort: ${JSON.stringify(effort)}`)
    }
    if (headroomTokens !== undefined) lines.push('- id: compaction-basic', '  config:', `    headroomTokens: ${headroomTokens}`)
    return writeFile(join(root, 'overlay.yml'), `${lines.join('\n')}\n`)
  }

  return {
    upstream,
    replayEnv,
    versions: versions.join(', '),
    dispose: cleanup,

    /** Boot DSH once, drive the plugin's refresh and probe routes, return its catalogue. */
    async prepare({ models, model, headroomTokens }) {
      upstream.setModels(models)
      const port = await freePort()
      await writeOverlay({ port, model, headroomTokens })
      const run = start([process.execPath, join(root, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '--profile', 'headless', '--patch', join(root, 'overlay.yml'), '-'], { cwd: ws, env: replayEnv() })
      const base = `http://127.0.0.1:${port}/dsh-opencode-free/api`
      const origin = { origin: `http://127.0.0.1:${port}` }
      let exitCode
      void run.exited.then((code) => (exitCode = code))
      const call = async (path, init) => {
        const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(ROUND_TIMEOUT_MS) })
        if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path} answered HTTP ${response.status}`)
        return await response.json()
      }
      try {
        const deadline = Date.now() + BOOT_TIMEOUT_MS
        for (;;) {
          if (exitCode !== undefined) throw new Error(`DSH exited (code ${exitCode}) before the plugin's routes answered: ${run.output().stderr.slice(0, 300)}`)
          try { await call('/catalog'); break } catch {
            if (Date.now() > deadline) throw new Error('the plugin catalogue route never answered')
            await delay(300)
          }
        }
        await call('/refresh', { method: 'POST', headers: origin })
        // Safety: the probe sends real inference requests if the redirect is missing.
        // The plugin's own model-list fetch is the witness; without it, stop here.
        const listed = () => upstream.requests.some((r) => r.method === 'GET' && r.url?.startsWith('/inference/v1/models'))
        for (let waited = 0; !listed() && waited < 10_000; waited += 250) await delay(250)
        if (!listed()) throw new Error('the plugin never reached the fake model list; refusing to probe')
        // The probe asks each offered model one short question; a plain reply passes it.
        upstream.use(probeHandler)
        await call('/probe', { method: 'POST', headers: origin })
        const until = Date.now() + ROUND_TIMEOUT_MS
        for (;;) {
          const progress = await call('/probe')
          if (progress.running === false && progress.startedAt > 0) break
          if (Date.now() > until) throw new Error('the probe round did not finish')
          await delay(300)
        }
        return await call('/catalog')
      } finally {
        run.child.kill()
        await run.exited
        upstream.requests.length = 0
      }
    },

    /** One headless task; `--json` events are parsed into `events`. */
    async ask(task, { model, headroomTokens, sessionId, files = {} } = {}) {
      const port = await freePort()
      await writeOverlay({ port, model, headroomTokens })
      for (const [name, content] of Object.entries(files)) await writeFile(join(ws, name), content)
      const argv = [process.execPath, join(root, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '--profile', 'headless', '--patch', join(root, 'overlay.yml'), '--json']
      if (sessionId !== undefined) argv.push('--session-id', sessionId)
      argv.push('-')
      const run = start(argv, { cwd: ws, env: replayEnv(), input: task })
      const timer = setTimeout(() => run.child.kill(), RUN_TIMEOUT_MS)
      const exitCode = await run.exited
      clearTimeout(timer)
      const { stdout, stderr } = run.output()
      const events = stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => { try { return JSON.parse(line) } catch { return undefined } }).filter(Boolean)
      const final = events.find((event) => event.type === 'final')
      return { exitCode, events, final, sessionId: final?.sessionId ?? events.find((e) => e.type === 'session')?.sessionId, stderr }
    },

    context() { return { host: this, upstream, ws } },
  }
}

const probeHandler = (record) => (record.url.endsWith('/responses') ? responsesText('OK') : completionsText('OK'))

/** Refuse to run scenarios unless a child's opencode.ai traffic provably reaches the fake. */
async function preflight(host) {
  host.upstream.setModels([])
  const script = "const r = await fetch('https://opencode.ai/inference/v1/models'); await r.text()"
  const run = spawn(process.execPath, ['--input-type=module', '-e', script], { env: host.replayEnv(), stdio: 'ignore' })
  const code = await new Promise((done) => run.on('close', done))
  if (code !== 0 || host.upstream.requests.length !== 1) throw new Error('preflight failed: the redirect did not reach the fake, so no scenario was run')
  host.upstream.requests.length = 0
}

process.exitCode = await main().catch((error) => {
  console.error(`replay: ${error instanceof Error ? error.message : String(error)}`)
  return 1
})
