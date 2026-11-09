// Scenarios for the headless replay run (scripts/replay-run.mjs). Each one
// installs a handler on the loopback fake, drives a real headless DSH, and
// asserts on what DSH reported and on what the plugin put on the wire.
// Requires a built plugin (`pnpm run build`) for the shared wording constants.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { CONTEXT_OVERFLOW_CLAUSE, ZEN_FAILURE_GUIDANCE } from '../lib/zen-provider.js'
import {
  completionsText,
  completionsTextWithUsage,
  completionsToolCall,
  officialModel,
  refusal,
  responsesText,
} from './replay-fixtures.mjs'

const FREE_A = officialModel('replay-free-a')
const FREE_B = officialModel('replay-free-b', { api: 'responses' })
const sorted = (list) => [...list].sort()

const textOfContent = (content) => typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : ''
const lastMessage = (body) => body?.messages?.at(-1)
const lastUserText = (body) => textOfContent([...(body?.messages ?? [])].reverse().find((m) => m.role === 'user')?.content)
const toolNames = (body) => (body?.tools ?? []).map((tool) => tool.function?.name ?? tool.name).sort()
const isResponses = (record) => record.url.endsWith('/responses')
const plainReply = (text) => (record) => (isResponses(record) ? responsesText(text) : completionsText(text))

function assertCompleted(result, expectedText) {
  assert.equal(result.exitCode, 0, `DSH exited ${result.exitCode}: ${result.stderr.slice(0, 300)}`)
  assert.equal(result.final?.reason?.kind, 'completed', JSON.stringify(result.final?.reason))
  if (expectedText !== undefined) assert.equal(result.final.text, expectedText)
}

export const SCENARIOS = [
  {
    id: 'R1',
    title: 'the picker follows the official list (S10)',
    async run({ host }) {
      const paid = officialModel('replay-paid', { price: 1 })
      let catalog = await host.prepare({ models: [FREE_A, FREE_B, paid] })
      assert.equal(catalog.source, 'official')
      assert.deepEqual(sorted(catalog.visible), ['replay-free-a', 'replay-free-b'], `the paid model is not offered: ${JSON.stringify(catalog)}`)
      catalog = await host.prepare({ models: [FREE_A, officialModel('replay-free-d')] })
      assert.deepEqual(sorted(catalog.visible), ['replay-free-a', 'replay-free-d'], 'an added model appears and a removed one goes')
    },
  },
  {
    id: 'R2',
    title: 'a plain reply on both channels (S1)',
    async run({ host, upstream }) {
      await host.prepare({ models: [FREE_A, FREE_B] })
      for (const [model, path] of [['replay-free-a', '/chat/completions'], ['replay-free-b', '/responses']]) {
        upstream.requests.length = 0
        upstream.use(plainReply('REPLAY-OK'))
        const result = await host.ask('say hi', { model })
        assertCompleted(result, 'REPLAY-OK')
        const [request] = upstream.inference()
        assert.equal(request.url, `/inference/v1${path}`)
        assert.equal(request.headers.get('authorization'), 'Bearer public')
        assert.equal(request.headers.get('x-opencode-client'), 'cli')
        assert.match(request.headers.get('x-opencode-session') ?? '', /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/, `${model}: session identity`)
        const system = JSON.stringify(request.body.messages?.filter((m) => m.role === 'system' || m.role === 'developer') ?? request.body.input ?? '')
        assert.equal(system.split('Working directory:').length - 1, 1, `${model}: the gate's environment block appears once`)
      }
    },
  },
  {
    id: 'R3',
    title: 'a tool loop and a follow-up turn (S2)',
    async run({ host, upstream }) {
      await host.prepare({ models: [FREE_A] })
      const nonce = `NONCE-${randomBytes(6).toString('hex')}`
      upstream.use((record) => lastMessage(record.body)?.role === 'tool'
        ? completionsText('TOOL-RESULT-SEEN')
        : completionsToolCall('read', { file_path: 'note.txt' }))
      const first = await host.ask('read note.txt', { model: 'replay-free-a', files: { 'note.txt': nonce } })
      assertCompleted(first, 'TOOL-RESULT-SEEN')
      const result = first.events.find((event) => event.type === 'tool_result')
      assert.ok(result, 'DSH ran the tool')
      assert.ok(JSON.stringify(result).includes(nonce), 'the tool result holds the file content')
      const [call, replay] = upstream.inference()
      assert.equal(toolNames(call.body).includes('read'), true)
      assert.equal(lastMessage(replay.body).role, 'tool', 'the second request ends with the tool result')
      assert.ok(JSON.stringify(lastMessage(replay.body)).includes(nonce))

      upstream.requests.length = 0
      upstream.use(plainReply('FOLLOW-UP-OK'))
      const second = await host.ask('and then?', { model: 'replay-free-a', sessionId: first.sessionId })
      assertCompleted(second, 'FOLLOW-UP-OK')
      const [followUp] = upstream.inference()
      assert.ok(JSON.stringify(followUp.body.messages).includes(nonce), 'the earlier tool exchange is replayed')
      assert.equal(lastUserText(followUp.body), 'and then?')
    },
  },
  {
    id: 'R4',
    title: 'a generic refusal over the window becomes a context overflow (S3)',
    async run({ host, upstream }) {
      await host.prepare({ models: [officialModel('replay-free-a', { context: 4000, output: 500 })] })
      upstream.use(() => refusal(400, { type: 'invalid_request_error', message: 'Error from provider (Console): Upstream request failed: [invalid_request_error] invalid request' }))
      const result = await host.ask('hello', { model: 'replay-free-a' })
      assert.notEqual(result.exitCode, 0)
      const error = result.final?.reason?.error
      assert.equal(error?.code, 'CONTEXT_WINDOW_EXCEEDED', JSON.stringify(result.final?.reason))
      assert.ok(error.message.includes(CONTEXT_OVERFLOW_CLAUSE))
    },
  },
  {
    id: 'R5',
    title: 'compaction replaces old turns with the summary (S4)',
    async run({ host, upstream }) {
      const options = { model: 'replay-free-a', headroomTokens: 1000 }
      await host.prepare({ models: [officialModel('replay-free-a', { context: 40_000, output: 4000 })], ...options })
      const isCompaction = (record) => lastUserText(record.body).startsWith('You are now acting as a compaction engine')
      upstream.use((record) => isCompaction(record)
        ? completionsText('CHECKPOINT-SUMMARY-MARKER')
        : completionsTextWithUsage('ok', 33_000))
      const filler = 'lorem ipsum dolor sit amet '.repeat(300)
      let sessionId
      for (const [index, label] of ['FIRST-TURN-UNIQUE', 'two', 'three', 'four', 'five', 'six'].entries()) {
        const result = await host.ask(`${label} ${filler}`, { ...options, sessionId })
        assertCompleted(result)
        sessionId = result.sessionId
        assert.ok(sessionId, `turn ${index + 1} has a session id`)
      }
      const requests = upstream.inference()
      const at = requests.findIndex(isCompaction)
      assert.ok(at >= 0, 'a compaction request was sent')
      assert.equal(requests[at].body.max_tokens ?? requests[at].body.max_completion_tokens, 1000, 'the summary is capped at headroomTokens')
      const after = requests.slice(at + 1).find((record) => !isCompaction(record))
      assert.ok(after, 'a request follows the compaction')
      const replayed = JSON.stringify(after.body.messages)
      assert.ok(replayed.includes('CHECKPOINT-SUMMARY-MARKER'), 'the summary is replayed')
      assert.ok(!replayed.includes('FIRST-TURN-UNIQUE'), 'the shadowed turn is no longer replayed')
    },
  },
  {
    id: 'R6',
    title: 'a free-tier refusal reaches the user as guidance (S6)',
    async run({ host, upstream }) {
      await host.prepare({ models: [FREE_A] })
      upstream.use(() => refusal(403, { type: 'FreeTierError', message: 'blocked' }))
      const result = await host.ask('hello', { model: 'replay-free-a' })
      assert.notEqual(result.exitCode, 0)
      const message = result.final?.reason?.error?.message ?? ''
      assert.ok(message.includes(ZEN_FAILURE_GUIDANCE['anon-gated']), message)
    },
  },
]
