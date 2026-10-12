import assert from 'node:assert/strict'
import test from 'node:test'
import { isContextWindowExceededError } from '@deepseek-ai/dsh-llm'
import { isContextOverflow } from '@earendil-works/pi-ai'
import {
  CONTEXT_OVERFLOW_CLAUSE,
  appendContextOverflowClause,
  createTransportRecorder,
  mapTransportErrorToGuidance,
} from '../src/zen-provider.ts'

// What Zen returns for a request over the window (issue #7).
const GENERIC_REFUSAL =
  '400 {"error":{"type":"invalid_request_error","message":"Error from provider (Console): Upstream request failed: [invalid_request_error] invalid request"}}'

// Refusals that are not about context size. Each carries wording of its own.
const NON_OVERFLOW = [
  '400 {"error":{"type":"invalid_request_error","message":"tools[3].function.parameters: invalid schema"}}',
  '400 {"error":{"type":"invalid_request_error","message":"max_tokens: 99999 is greater than the output ceiling of this model"}}',
  '400 {"error":{"type":"invalid_request_error","message":"Unsupported parameter: reasoning.effort"}}',
  '400 {"error":{"type":"invalid_request_error","message":"Your request was rejected as a result of our content policy"}}',
]

const BOUND = { requested: 128_000, emitted: 90_000 }

const assistantError = (errorMessage) => ({
  role: 'assistant',
  stopReason: 'error',
  errorMessage,
  content: [],
})

const bothDetectors = (message) => ({
  piAi: isContextOverflow(assistantError(message)),
  host: isContextWindowExceededError(message),
})

test('the clause is recognised by pi-ai and by the host, so either detector triggers compaction', () => {
  const message = appendContextOverflowClause(GENERIC_REFUSAL, BOUND)
  assert.deepEqual(bothDetectors(message), { piAi: true, host: true })
})

test('the clause holds no bare three-digit number that DSH could re-file as a status', () => {
  assert.doesNotMatch(CONTEXT_OVERFLOW_CLAUSE, /\b\d{3}\b/)
})

test('the upstream wording is kept and the clause is appended after it', () => {
  const message = appendContextOverflowClause(GENERIC_REFUSAL, BOUND)
  assert.ok(message.startsWith(GENERIC_REFUSAL))
  assert.ok(message.endsWith(CONTEXT_OVERFLOW_CLAUSE))
})

test('the unmodified refusal matches neither detector (drop the translation if this ever fails)', () => {
  assert.deepEqual(bothDetectors(GENERIC_REFUSAL), { piAi: false, host: false })
})

test('a refusal that is not the generic one is never translated, even when max_tokens was lowered', () => {
  for (const message of NON_OVERFLOW) {
    assert.equal(appendContextOverflowClause(message, BOUND), message)
  }
})

test('the shapes that are not overflows stay non-overflows', () => {
  for (const message of NON_OVERFLOW) {
    assert.deepEqual(bothDetectors(message), { piAi: false, host: false }, message)
  }
})

test('without a lowered max_tokens the generic refusal is left alone', () => {
  for (const tokens of [
    undefined,
    {},
    { requested: 128_000 },
    { emitted: 90_000 },
    { requested: 128_000, emitted: 128_000 },
    { requested: 90_000, emitted: 128_000 },
  ]) {
    assert.equal(appendContextOverflowClause(GENERIC_REFUSAL, tokens), GENERIC_REFUSAL)
  }
})

test('a generic refusal followed by more detail is not the bare one', () => {
  const detailed = `${GENERIC_REFUSAL.slice(0, -4)}: messages.4 is malformed"}}`
  assert.equal(appendContextOverflowClause(detailed, BOUND), detailed)
})

test('a recorder that saw a lowered max_tokens makes the mapped error name the overflow', () => {
  for (const field of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) {
    const recorder = createTransportRecorder(undefined, 128_000)
    recorder.notePayload({ [field]: 90_000, input: [] })
    const mapped = mapTransportErrorToGuidance(
      { stopReason: 'error', errorMessage: GENERIC_REFUSAL },
      recorder,
    )
    assert.deepEqual(bothDetectors(mapped.errorMessage), { piAi: true, host: true }, field)
  }
})

test('a recorder that saw the requested max_tokens leaves the error as it was', () => {
  const recorder = createTransportRecorder(undefined, 128_000)
  recorder.notePayload({ max_tokens: 128_000 })
  const result = { stopReason: 'error', errorMessage: GENERIC_REFUSAL }
  assert.deepEqual(mapTransportErrorToGuidance(result, recorder), result)
})

test('a recorder that saw no payload leaves the error as it was', () => {
  const recorder = createTransportRecorder(undefined, 128_000)
  const result = { stopReason: 'error', errorMessage: GENERIC_REFUSAL }
  assert.deepEqual(mapTransportErrorToGuidance(result, recorder), result)
})
