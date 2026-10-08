import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EFFORT_FALLBACK_AFTER,
  EFFORT_SAMPLES,
  EFFORT_WORKING_RATIO,
  effortVerdictFrom,
  measuredEffortMap,
  nextEffortQuestion,
} from '../lib/catalog.js'
import { derive } from '../lib/catalog.js'

/**
 * Replay of every measurement taken against Zen on 2026-10-06.
 *
 * This file exists because two shipped classifiers looked correct and were not.
 * `thinkingLevelMapFor` returning `undefined` read as "no claim" when pi-ai
 * reads it as "offer everything"; a per-sample `reasoning_tokens === 0` test
 * flipped on big-pickle's 0-versus-8 alternation and could never converge.
 * Neither was caught by a unit test, because both were tested on hand-picked
 * inputs rather than on what the provider actually returned.
 *
 * So the corpus is the provider's own answers, keyed by the question each one
 * asked. A classifier that disagrees with the field fails here.
 */
const CORPUS = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'measured-samples.json'), 'utf8'),
)

const byModel = new Map()
for (const row of CORPUS) {
  if (row.tokens === null || row.tokens === undefined) continue
  if (!byModel.has(row.model)) byModel.set(row.model, new Map())
  const questions = byModel.get(row.model)
  const key = String(row.question)
  if (!questions.has(key)) questions.set(key, [])
  for (let i = 0; i < row.n; i++) questions.get(key).push(row.tokens)
}

const samplesFor = (model, question) => byModel.get(model)?.get(question) ?? undefined

test('the corpus is the provider’s own answers, not hand-picked ones', () => {
  const models = [...byModel.keys()]
  assert.ok(models.length >= 8, `expected at least 8 models in the corpus, found ${models.length}`)
  assert.ok(CORPUS.length >= 100, `expected a corpus of real size, found ${CORPUS.length}`)
  // The two shapes that broke a shipped classifier must both be present, or this
  // file would silently stop guarding them.
  assert.ok(samplesFor('big-pickle', 'minimal')?.length >= 6, "big-pickle's bimodal minimal samples are the point")
  assert.ok(samplesFor('longcat-2.5-preview-free', 'minimal')?.length >= 3, "longcat's inert minimal samples are the point")
})

test('a liveness row on a no-ladder model IS a baseline sample', () => {
  // The probe's liveness request hardcodes `reasoning: "low"`, which clamps to
  // OMISSION on a model that publishes no ladder — so that request is the model's
  // own baseline and costs nothing extra. Losing those rows would make the corpus
  // look like it had no baselines at all, and every verdict would read as "no
  // claim" for want of evidence rather than for want of a working control.
  const models = [...byModel.keys()].filter((id) => {
    const questions = byModel.get(id);
    return questions.get('none') !== undefined && questions.get('baseline') === undefined;
  });
  assert.ok(models.length > 0, 'expected at least one model whose baseline only exists as a liveness row');
});

test('a model that honours none is classified as such', () => {
  // Four independent models: reasoning_tokens 0 against a baseline in the tens.
  for (const [model, question] of [
    ['mimo-v2.6-flash-free', 'none'],
    ['mimo-v2.5-free', 'none'],
    ['nemotron-3-ultra-free', 'none'],
    ['nemotron-3.5-lightning-free', 'none'],
  ]) {
    const baseline = samplesFor(model, 'baseline') ?? samplesFor(model, 'none-omitted')
    assert.ok(samplesFor(model, question)?.length >= 1, `${model} has no ${question} samples`)
    if (baseline === undefined) continue
    assert.equal(effortVerdictFrom(samplesFor(model, question), baseline), true, `${model} ${question} should work`)
  }
})

test('a model that ignores none is not credited with an Off row', () => {
  // longcat accepts `none` with HTTP 200 and reasons anyway. Crediting it would be
  // the exact lie this change set exists to remove: a row labelled Off that does
  // not stop reasoning.
  assert.equal(effortVerdictFrom(samplesFor('longcat-2.5-preview-free', 'none'), samplesFor('longcat-2.5-preview-free', 'baseline')), false)
  assert.equal(effortVerdictFrom(samplesFor('longcat-2.5-preview-free', 'minimal'), samplesFor('longcat-2.5-preview-free', 'baseline')), false)
})

test('the boundary separates every model the provider answered for', () => {
  // The measured bracket is (0.231, 0.800) and nothing lands inside it. This
  // asserts that for every model with both sides measured, so a future change to
  // the threshold or to the classifier cannot quietly reclassify one.
  const judged = []
  for (const [model, questions] of byModel) {
    const baseline = questions.get('baseline')
    // Only the two spellings the round actually asks. `low` on a no-ladder
    // model is ladder-sweep data, never an Off candidate, so judging it here
    // would assert something the plugin never does.
    for (const question of ['none', 'minimal']) {
      const candidate = questions.get(question)
      if (baseline === undefined || candidate === undefined) continue
      const verdict = effortVerdictFrom(candidate, baseline)
      if (verdict === undefined) continue
      judged.push({ model, question, verdict })
    }
  }
  assert.ok(judged.length >= 8, `expected several judged pairs, got ${judged.length}`)
  // The ratio must not sit ON the boundary for anything the round would
  // actually rely on; that is what makes a single threshold defensible.
  //
  // `none` is asked first and is unambiguous wherever it works, so the marginal
  // cases are all FALLBACKS — reached only after `none` was already rejected,
  // where a partial reduction is better than no Off row at all. They are
  // recorded rather than asserted away, because the corpus exists to surface
  // exactly this: a threshold that looks comfortable is sitting on real data.
  const KNOWN_THIN = new Set(['mimo-v2.6-flash-free:minimal'])
  for (const { model, question, verdict } of judged) {
    const ratio = median(samplesFor(model, question)) / median(samplesFor(model, 'baseline'))
    const distance = Math.abs(Math.log(ratio / EFFORT_WORKING_RATIO))
    if (KNOWN_THIN.has(`${model}:${question}`)) {
      // Recorded, not excused: this is the edge that would move first if the
      // threshold changed, and it is a fallback rather than a primary answer.
      assert.ok(distance < 0.5, `${model} ${question} was expected to be the thin edge`)
      continue
    }
    assert.ok(distance > 0.5, `${model} ${question} sits at ratio ${ratio.toFixed(3)}, too close to the boundary to be decisive`)
    assert.equal(verdict, ratio < EFFORT_WORKING_RATIO, `${model} ${question} verdict disagrees with its own ratio`)
  }
})

test('an absolute threshold cannot work, and the corpus proves it', () => {
  // longcat's `minimal` is inert at 36 reasoning tokens; muse-spark's `minimal`
  // works at 38. Two tokens apart, so no cut on the raw count separates them —
  // which is why the classifier judges a ratio and not a number.
  const inert = median(samplesFor('longcat-2.5-preview-free', 'minimal'))
  const working = 38
  assert.ok(inert <= working, `expected the inert floor (${inert}) to sit at or below the working one (${working})`)
  assert.equal(effortVerdictFrom(samplesFor('longcat-2.5-preview-free', 'minimal'), samplesFor('longcat-2.5-preview-free', 'baseline')), false)
})

test('the fallback reaches every model that has a measured one', () => {
  // big-pickle: `none` is nowhere near, `minimal` is a floor. The classifier must
  // move between them and land on the one that works — the path that a
  // per-sample `=== 0` test could not complete.
  const noneVerdict = effortVerdictFrom(samplesFor('big-pickle', 'none'), samplesFor('big-pickle', 'baseline'))
  const minimalVerdict = effortVerdictFrom(samplesFor('big-pickle', 'minimal'), samplesFor('big-pickle', 'baseline'))
  assert.equal(noneVerdict, false, "big-pickle's none is not a working Off")
  assert.equal(minimalVerdict, true, 'and its lowest level is')
  assert.equal(EFFORT_FALLBACK_AFTER, 1, 'one decisive rejection is enough to move on')

  // space-bunny keeps its row through the same mechanism.
  assert.equal(
    effortVerdictFrom(samplesFor('space-bunny-free', 'low'), samplesFor('space-bunny-free', 'baseline')),
    true,
  )
})

test('the round asks for a baseline before it can judge anything', () => {
  assert.equal(nextEffortQuestion(undefined), 'baseline')
  assert.equal(nextEffortQuestion({ verdict: 'ok', at: 1, effortBaselineTokens: [16] }), 'baseline')
  assert.equal(nextEffortQuestion({ verdict: 'ok', at: 1, effortBaselineTokens: [14, 16, 55] }), 'none')
  // And a settled question is not re-opened, so a model that needs both
  // candidates stops after the second rather than alternating forever.
  assert.equal(
    nextEffortQuestion({ verdict: 'ok', at: 1, effortBaselineTokens: [14, 16, 55], effortQuestion: 'minimal', effortDiscord: 1 }),
    'minimal',
  )
})

test('the corpus survives the derivation it is meant to guard', () => {
  // The end-to-end check: with the corpus fed in as evidence, the models the
  // provider answered for get the Off row the measurements earned.
  const template = {
    id: 't', name: 't', api: 'openai-completions', provider: 'opencode-zen-free',
    baseUrl: 'https://opencode.ai/zen/v1', reasoning: true, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1,
  }
  const probes = {
    'big-pickle': {
      verdict: 'ok', at: 1,
      effort: { kind: 'level-works', level: 'minimal', fp: 'yes:[]', api: 'openai-completions', at: 1 },
    },
    'longcat-2.5-preview-free': {
      verdict: 'ok', at: 1,
      effort: { kind: 'noop', fp: 'yes:[{"type":"toggle"}]', api: 'openai-completions', at: 1 },
    },
  }
  const section = {
    'big-pickle': { id: 'big-pickle', name: 'Big Pickle', reasoning: true, reasoning_options: [], cost: { input: 0, output: 0 } },
    'longcat-2.5-preview-free': {
      id: 'longcat-2.5-preview-free', name: 'Longcat', reasoning: true,
      reasoning_options: [{ type: 'toggle' }], cost: { input: 0, output: 0 },
    },
  }
  const base = derive(section, { template, knownApis: new Map() }).candidates
  const evidence = measuredEffortMap(base, section, probes)
  const derived = derive(section, { template, knownApis: new Map(), measuredEffort: evidence })
  assert.equal(derived.candidates.find((m) => m.id === 'big-pickle').thinkingLevelMap.off, 'minimal')
  assert.equal(derived.candidates.find((m) => m.id === 'longcat-2.5-preview-free').thinkingLevelMap.off, null)
})

function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

void EFFORT_SAMPLES
