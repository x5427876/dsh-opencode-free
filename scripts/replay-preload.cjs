// Test-only redirect for the headless replay run (docs/offline-replay-design.md).
//
// Loaded with `node --require` into the DSH child process. Every TLS
// connection aimed at opencode.ai goes to the loopback fake instead, with the
// server name unchanged so certificate checks still run against the throwaway
// CA in NODE_EXTRA_CA_CERTS. Production code keeps its single fixed endpoint;
// this file is never shipped (it is not in package.json "files").
'use strict'
const tls = require('node:tls')

const port = Number(process.env.REPLAY_FAKE_PORT)
if (!Number.isInteger(port) || port <= 0) {
  throw new Error('replay-preload: REPLAY_FAKE_PORT must name the loopback fake; refusing to run without a redirect')
}

const isZen = (options) => options !== null && typeof options === 'object' &&
  [options.host, options.hostname, options.servername].includes('opencode.ai')

const connect = tls.connect
tls.connect = function replayConnect(...args) {
  const options = args.find((arg) => arg !== null && typeof arg === 'object')
  if (isZen(options)) {
    options.servername = 'opencode.ai'
    options.host = '127.0.0.1'
    if (options.hostname !== undefined) options.hostname = '127.0.0.1'
    options.port = port
  }
  return connect.apply(this, args)
}
