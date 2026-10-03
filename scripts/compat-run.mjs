// Compat run CLI (CONTEXT.md: compat run, not the plugin's probe).
//
//   pnpm compat --dsh <version> [--tools] [--keep] [--out <dir>]
//
// Installs the given DSH and this repo's packed plugin into a temp
// DSH_HOME, verifies every Zen free model through a real headless DSH, prints
// the matrix and exits 0 / 1 / 2 (see scripts/compat-core.mjs). Sends real
// anonymous requests; never touches ~/.dsh or a running DSH. Not run in CI
// (docs/adr/0003-compat-run-not-in-ci.md).
//
// Node's child-process API only, no shell: the same on Windows, macOS, Linux.
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { arch, platform, release, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { fetchSection } from '../lib/catalog.js'
import { builtinFreeModels, fetchZenModelIds } from '../lib/zen-provider.js'
import { CompatPreconditionError, runCompat } from './compat-core.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const USAGE = 'usage: pnpm compat --dsh <version> [--tools] [--keep] [--out <dir>]'
/** Exit code for a refused precondition: nothing was installed or sent. */
const EXIT_PRECONDITION = 3

const BOOT_TIMEOUT_MS = 120_000
const ROUND_TIMEOUT_MS = 15 * 60_000
const RUN_TIMEOUT_MS = 10 * 60_000

async function main() {
  let args
  try {
    args = parseArgs({
      options: {
        dsh: { type: 'string' },
        tools: { type: 'boolean', default: false },
        keep: { type: 'boolean', default: false },
        out: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }).values
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`)
    return EXIT_PRECONDITION
  }
  if (args.help) {
    console.log(USAGE)
    return 0
  }
  const pkg = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8'))
  const driver = createDriver({ dsh: args.dsh?.trim() ?? '', keep: args.keep })
  // Ctrl-C must not leave a DSH child running or a temp tree behind.
  process.once('SIGINT', () => {
    driver.abort()
    void driver.dispose().finally(() => process.exit(130))
  })
  try {
    const { text, files, exitCode } = await runCompat(
      { dsh: args.dsh, tools: args.tools, out: args.out === undefined ? undefined : resolve(args.out) },
      {
        pkg,
        env: process.env,
        platform: process.platform,
        osLabel: `${platform()} ${release()} ${arch()}, Node ${process.version}`,
        now: () => new Date(),
        tmpDir: join(tmpdir(), 'dsh-compat-reports'),
        catalogue,
        driver,
        sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
        writeFile: async (path, content) => {
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, content)
        },
      },
    )
    console.log(text)
    for (const file of files) console.log(`wrote ${file}`)
    return exitCode
  } catch (error) {
    if (error instanceof CompatPreconditionError) {
      console.error(`${error.message}\n${USAGE}`)
      return EXIT_PRECONDITION
    }
    throw error
  }
}

/** Zen's served ids, models.dev's opencode records, and the plugin's builtin floor. */
async function catalogue() {
  const zenIds = await fetchZenModelIds(fetch, AbortSignal.timeout(15_000))
  if (zenIds === null) throw new Error('Zen /models did not return a model list')
  const section = await fetchSection({ fetchImpl: fetch, timeoutMs: 30_000 })
  if (section.kind !== 'ok') throw new Error(`models.dev: ${section.kind === 'failed' ? section.reason : section.kind}`)
  return { zenIds, modelsDev: section.section, builtinIds: builtinFreeModels().map((model) => model.id) }
}

/**
 * The real driver: one isolated DSH install per compat run.
 *
 * Layout under a fresh temp root: `dsh/` (the DSH install), `home/` (DSH_HOME,
 * holding the headless profile with this repo's packed plugin), `ws/` (the
 * working directory the model sees) and one overlay file.
 */
function createDriver({ dsh, keep }) {
  const children = new Set()
  let root
  let dshBin
  let port
  let disposed = false

  const paths = () => ({ home: join(root, 'home'), ws: join(root, 'ws'), overlay: join(root, 'overlay.yml') })

  /** The child environment: isolated home, anonymous unless a key is passed in. */
  function childEnv(apiKey) {
    const env = { ...process.env, DSH_HOME: paths().home }
    // The plugin reads this variable itself, so an anonymous run must not inherit it.
    delete env.OPENCODE_API_KEY
    if (apiKey !== undefined) env.OPENCODE_API_KEY = apiKey
    return env
  }

  /** `argv[0]` is the executable; never a shell. */
  function start([command, ...args], { cwd, env, input }) {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    children.add(child)
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
    if (input !== undefined) child.stdin.end(input)
    const exited = new Promise((done) => {
      child.on('error', (error) => {
        stderr += `\n${error.message}`
        done(null)
      })
      child.on('close', (code) => done(code))
    }).finally(() => children.delete(child))
    return { child, exited, output: () => ({ stdout, stderr }) }
  }

  /** Run to completion; a non-zero exit is an error naming the step, not the output. */
  async function step(label, args, cwd) {
    const run = start(args, { cwd, env: childEnv(undefined), input: '' })
    const code = await run.exited
    if (code !== 0) throw new Error(`${label} exited with code ${code}: ${tail(run.output().stderr || run.output().stdout)}`)
    return run.output().stdout
  }

  function writeOverlay({ model, effort }) {
    const lines = [
      // webServer is a hard dependency of the plugin; headless has none.
      '- insert:',
      '    - id: webserver',
      "      name: '@deepseek-ai/dsh-host-webserver'",
      '      config:',
      "        host: '127.0.0.1'",
      `        port: ${port}`,
      // One request per run: the title request would double the quota spent.
      '- id: session-title-llm',
      '  disabled: true',
    ]
    if (model !== undefined) {
      lines.push('- id: agent-default-model', '  config:', '    provider: opencode-zen-free', `    model: ${JSON.stringify(model)}`)
      if (effort !== undefined) lines.push(`    reasoningEffort: ${JSON.stringify(effort)}`)
    }
    return writeFile(paths().overlay, `${lines.join('\n')}\n`)
  }

  return {
    async setup() {
      const pnpm = pnpmCommand()
      root = await mkdtemp(join(tmpdir(), 'dsh-compat-'))
      const { home, ws } = paths()
      await mkdir(join(root, 'dsh'))
      await mkdir(ws)
      await writeFile(join(root, 'dsh', 'package.json'), '{ "name": "dsh-compat-host", "private": true }\n')
      // Hoisted so DSH resolves bundle rows (e.g. dsh-host-webserver) the way
      // an npm install would; builds allowed for the same reason.
      await step(
        'installing DSH',
        [
          ...pnpm,
          'add',
          `@deepseek-ai/dsh@${dsh}`,
          '--config.node-linker=hoisted',
          '--config.dangerously-allow-all-builds=true',
        ],
        join(root, 'dsh'),
      )
      const dshPkgDir = join(root, 'dsh', 'node_modules', '@deepseek-ai', 'dsh')
      const dshPkg = JSON.parse(await readFile(join(dshPkgDir, 'package.json'), 'utf8'))
      dshBin = join(dshPkgDir, typeof dshPkg.bin === 'string' ? dshPkg.bin : dshPkg.bin.dsh)
      const version = (await step('dsh --version', [process.execPath, dshBin, '--version'], root)).trim()
      if (version !== dsh) throw new Error(`installed DSH reports ${version}, not ${dsh}`)
      // This repo, packed now (prepack builds lib/): what is about to ship.
      await step('pnpm pack', [...pnpm, 'pack', '--pack-destination', root], REPO)
      const tarball = (await readdir(root)).find((name) => name.startsWith('dsh-opencode-free-') && name.endsWith('.tgz'))
      if (tarball === undefined) throw new Error('pnpm pack produced no dsh-opencode-free tarball')
      await mkdir(home)
      await step('installing the plugin', [process.execPath, dshBin, 'plugin', '--profile', 'headless', 'add', `file:${join(root, tarball)}`], root)
      port = await freePort()
      console.error(`compat: DSH ${dsh} and ${tarball} installed under ${root}`)
    },

    /**
     * Boot DSH once with stdin held open, so it loads the plugin and waits for
     * a task that never comes, and drive the plugin's own panel routes: sync
     * the catalogue, start one probe round, wait for it, read the picker list.
     * Public behaviour only; the plugin's cache file is never read.
     */
    async warmup() {
      await writeOverlay({})
      const run = start([process.execPath, dshBin, '--profile', 'headless', '--patch', paths().overlay, '-'], {
        cwd: paths().ws,
        env: childEnv(undefined),
      })
      const base = `http://127.0.0.1:${port}/dsh-opencode-free/api`
      // The plugin refuses a state-changing POST without a same-origin header.
      const origin = { origin: `http://127.0.0.1:${port}` }
      let exitCode
      void run.exited.then((code) => (exitCode = code))
      const call = async (path, init) => {
        const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(60_000) })
        if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path} answered HTTP ${response.status}`)
        return await response.json()
      }
      try {
        const bootDeadline = Date.now() + BOOT_TIMEOUT_MS
        for (;;) {
          if (exitCode !== undefined) {
            throw new Error(`DSH exited (code ${exitCode}) before the plugin's routes answered: ${tail(run.output().stderr)}`)
          }
          try {
            await call('/catalog')
            break
          } catch {
            if (Date.now() > bootDeadline) throw new Error(`the plugin's catalogue route never answered within ${BOOT_TIMEOUT_MS / 1000}s`)
            await delay(500)
          }
        }
        console.error('compat: warmup: plugin loaded, running its probe round')
        await call('/refresh', { method: 'POST', headers: origin })
        await call('/probe', { method: 'POST', headers: origin })
        const roundDeadline = Date.now() + ROUND_TIMEOUT_MS
        let progress
        for (;;) {
          progress = await call('/probe')
          if (progress.running === false && progress.startedAt > 0) break
          if (Date.now() > roundDeadline) throw new Error(`the probe round did not finish within ${ROUND_TIMEOUT_MS / 60_000} minutes`)
          await delay(2_000)
        }
        const snapshot = await call('/catalog')
        if (snapshot.source !== 'models.dev') throw new Error(`the plugin's catalogue is ${snapshot.source}, not models.dev`)
        return { visible: snapshot.visible, probe: progress }
      } finally {
        run.child.kill()
        await run.exited
      }
    },

    async run({ model, effort, task, apiKey, files = {} }) {
      const { ws } = paths()
      // Progress only: model, step and key use, never the key or the reply.
      const what = Object.keys(files).length === 0 ? 'L1' : `L2 ${Object.keys(files).join(',')}`
      console.error(`compat: ${model} ${what}${effort === undefined ? '' : ` effort=${effort}`}${apiKey === undefined ? '' : ' (keyed)'}`)
      await writeOverlay({ model, effort })
      for (const [name, content] of Object.entries(files)) await writeFile(join(ws, name), content)
      const run = start([process.execPath, dshBin, '--profile', 'headless', '--patch', paths().overlay, '-'], {
        cwd: ws,
        env: childEnv(apiKey),
        input: task,
      })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        run.child.kill()
      }, RUN_TIMEOUT_MS)
      const exitCode = await run.exited
      clearTimeout(timer)
      for (const name of Object.keys(files)) await rm(join(ws, name), { force: true })
      return { ...run.output(), exitCode, timedOut }
    },

    abort() {
      for (const child of children) child.kill()
    },

    async dispose() {
      if (disposed || root === undefined) return
      disposed = true
      if (keep) {
        console.error(`compat: kept ${root} (DSH_HOME=${paths().home})`)
        return
      }
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
    },
  }
}

/**
 * How to call pnpm without a shell. Run as `pnpm compat`, pnpm names its own
 * entry point in npm_execpath; a JS entry runs under this Node, anything else
 * (a standalone pnpm binary) is spawned as is.
 */
function pnpmCommand() {
  const entry = process.env.npm_execpath
  if (entry === undefined || entry === '' || !/pnpm/i.test(entry)) {
    throw new Error(`run this through pnpm so it can find pnpm without a shell: ${USAGE}`)
  }
  return /\.[cm]?js$/i.test(entry) ? [process.execPath, entry] : [entry]
}

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

function delay(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

/** The last few lines of a child's output, for an error message. */
function tail(text) {
  return String(text ?? '').trim().split(/\r?\n/).slice(-5).join(' | ').slice(-800)
}

process.exitCode = await main().catch((error) => {
  console.error(`compat: ${error instanceof Error ? error.message : String(error)}`)
  return 1
})
