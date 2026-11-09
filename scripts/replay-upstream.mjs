// Loopback HTTPS stand-in for the Zen inference endpoint, used by the
// headless replay run (docs/offline-replay-design.md). It lives in the same
// process as the driver, so a scenario installs a handler and reads the
// recorded requests directly.
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { modelList } from './replay-fixtures.mjs'

const run = promisify(execFile)

/** A throwaway CA and an opencode.ai leaf, valid for two days. Needs the `openssl` CLI. */
export async function makeCertificates(dir) {
  const path = (name) => join(dir, name)
  const openssl = (...args) => run('openssl', args, { cwd: dir })
  try {
    await openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=replay-ca')
    await openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=opencode.ai')
    await writeFile(path('san.ext'), 'subjectAltName=DNS:opencode.ai\n')
    await openssl('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '2', '-extfile', 'san.ext')
  } catch (error) {
    throw new Error(`creating the replay certificates needs the openssl CLI: ${error.message}`)
  }
  return { ca: path('ca.pem'), key: path('leaf.key'), cert: path('leaf.pem') }
}

/**
 * Start the fake. `handler(request)` answers each POST with a web `Response`;
 * `GET /inference/v1/models` serves the current model list.
 */
export async function startUpstream({ dir, models = [] }) {
  const certs = await makeCertificates(dir)
  const requests = []
  let list = models
  let handler = () => new Response('no scenario handler installed', { status: 500 })

  const server = createServer({ key: await readFile(certs.key), cert: await readFile(certs.cert) }, (req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', async () => {
      const text = Buffer.concat(chunks).toString('utf8')
      let body
      try { body = text === '' ? undefined : JSON.parse(text) } catch { body = undefined }
      const headers = new Headers()
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value)
      const record = { method: req.method, url: req.url, headers, body }
      requests.push(record)
      let response
      try {
        response = req.method === 'GET' && req.url?.startsWith('/inference/v1/models')
          ? Response.json(modelList(list))
          : req.method === 'POST' ? await handler(record) : new Response('{}', { status: 404 })
      } catch (error) {
        response = new Response(String(error?.message ?? error), { status: 500 })
      }
      res.writeHead(response.status, Object.fromEntries(response.headers))
      if (response.body === null) res.end()
      else Readable.fromWeb(response.body).pipe(res)
    })
  })
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })

  return {
    port: server.address().port,
    ca: certs.ca,
    requests,
    /** Inference requests only (not the model list). */
    inference: () => requests.filter((r) => r.method === 'POST'),
    use(next) { handler = next },
    setModels(next) { list = next },
    reset() { requests.length = 0; handler = () => new Response('no scenario handler installed', { status: 500 }) },
    close: () => new Promise((done) => { server.close(() => done()); server.closeAllConnections() }),
  }
}
