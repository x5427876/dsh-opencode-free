import assert from 'node:assert/strict'
import test from 'node:test'
import { childEnv } from '../scripts/replay-env.mjs'

const base = { PATH: '/bin', OPENCODE_API_KEY: 'sk-secret', NODE_OPTIONS: '--inspect', NODE_EXTRA_CA_CERTS: '/other.pem', DEBUG: '*', DSH_OPENCODE_FREE_DEBUG: '1' }
const redirect = { ca: '/ca.pem', preload: '/preload.cjs', port: 4443 }

test('the redirect variables survive the cleanup of the inherited environment', () => {
  const env = childEnv(base, { home: '/home', redirect })
  assert.equal(env.NODE_OPTIONS, '--require /preload.cjs')
  assert.equal(env.NODE_EXTRA_CA_CERTS, '/ca.pem')
  assert.equal(env.REPLAY_FAKE_PORT, '4443')
  assert.equal(env.DSH_HOME, '/home')
})

test('credentials and debug switches never reach a child', () => {
  for (const env of [childEnv(base, { home: '/home' }), childEnv(base, { home: '/home', redirect })]) {
    assert.equal(env.OPENCODE_API_KEY, undefined)
    assert.equal(env.DEBUG, undefined)
    assert.equal(env.DSH_OPENCODE_FREE_DEBUG, undefined)
    assert.equal(env.PATH, '/bin')
  }
})

test('without a redirect no inherited preload or CA is passed on', () => {
  const env = childEnv(base, { home: '/home' })
  assert.equal(env.NODE_OPTIONS, undefined)
  assert.equal(env.NODE_EXTRA_CA_CERTS, undefined)
  assert.equal(env.REPLAY_FAKE_PORT, undefined)
})
