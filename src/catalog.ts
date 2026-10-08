/**
 * Model catalogue owner: the models.dev `opencode.models` dictionary is the
 * source of truth for WHICH free models exist, while Zen's `/models` stays the
 * availability gate (a model models.dev calls free can still be unserved).
 *
 * Three layers, deliberately separable so each failure mode is attributable:
 *   1. derivation (pure): free test, activity test, channel inference, metadata
 *      mapping — no I/O, fully fixture-testable;
 *   2. fetch + cache: one conditional GET of the 5.2MB `api.json` (models.dev
 *      publishes no per-provider endpoint), storing ONLY the models dictionary
 *      so a warm start never re-downloads it;
 *   3. the state container: TTL, single-flight, degradation, and the Zen gate.
 *
 * DSH never calls `provider.refreshModels` (no host caller exists), so this
 * module owns its own trigger. It is host-side only: no DSH `ctx` concepts live
 * here, lifecycle wiring stays in `index.ts`.
 *
 * Identity (`provider` / `baseUrl` / `headers`) is NOT defined here — it is
 * inherited from `template`, an already identity-mapped pi-ai record, so the
 * Zen identity constants keep exactly one owner in `zen-provider.ts` and no
 * import cycle is introduced.
 */
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { PLUGIN_VERSION } from "./zen-provider.js";

/** Whole-file endpoint: models.dev serves no per-provider JSON (verified). */
export const MODELS_DEV_URL = "https://models.dev/api.json";
/** Cache schema version; anything else is treated as no cache at all. */
export const CACHE_VERSION = 1;
/** D4: lazy revalidation window. */
export const DEFAULT_TTL_MS = 86_400_000;
/**
 * Active-catalogue TTL, reached only when the previous fetch answered `304`.
 *
 * 24h is the conservative default; 6h is earned. Measured 2026-09-30: models.dev
 * answers `If-None-Match` with `304` and 0 bytes, so a revalidation that HITS costs
 * a few hundred bytes rather than 5.2MB, and the worst-case lag on a newly free
 * model drops from a day to six hours. A provider that stopped honouring the header
 * would instead see 5.2MB four times a day per user, so a MISS resets the interval
 * and the cost falls back to one download a day. The shortened window is taken from
 * observed behaviour and withdrawn the moment that behaviour stops — the full
 * argument, including why a competitor's shorter window really is a re-download, is
 * in `docs/adr/0002-catalogue-source-of-truth.md`.
 */
/**
 * Floor between two MANUAL probe rounds. The automatic round is bounded by
 * `probedToday(lastProbeAt, now)` (one per local calendar day), but `forceProbes()` is reachable
 * from the POST route, which has no server-side rate limit, and each round is up
 * to 34 real inference requests against a bucket shared per egress IP. Five
 * minutes is far below anything a user would notice and far above a double click
 *.
 */
export const FORCED_PROBE_MIN_INTERVAL_MS = 5 * 60_000;


export const CATALOG_TTL_ACTIVE_MS = 6 * 60 * 60_000;
/**
 * How long a Zen availability answer is trusted before it is re-asked.
 *
 * This is a second, independent expiry axis, and it is not a guess about the
 * catalogue's cost. `GET /zen/v1/models` spends no inference quota at all, so it
 * can be asked far more often than a completion can be spent — which is the
 * whole reason the round asks it before probing anything
 * (see {@link refreshGate}). Thirty minutes keeps a withdrawn model out of the
 * picker at minutes' notice instead of the 24h a catalogue-only refresh costs.
 *
 * Not persisted: a boot treats the gate as unasked. One tiny GET per start is
 * cheaper than a schema change, and it self-heals after downtime for free.
 */
export const GATE_TTL_MS = 30 * 60_000;
/** D1: bounded so a hung endpoint cannot pin a plugin fiber. */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** R1: the real file is ~5.2MB; 20MB leaves headroom and rejects a runaway. */
export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
/** Re-exported so `catalog.ts` consumers do not need a second import. */
export { PLUGIN_VERSION } from "./zen-provider.js";
/**
 * models.dev is NOT Zen: it gets an honest agent string. Reusing the OpenCode
 * CLI identity here would be both pointless and misleading.
 */
export const DEFAULT_USER_AGENT = `dsh-opencode-free/${PLUGIN_VERSION}`;

/** Where the catalogue came from, as reported to the panel. */
export type CatalogSource = "models.dev" | "builtin-fallback";

/** A models.dev model record, before mapping. Deliberately loose. */
export type CatalogRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** D2: zero cost across every declared dimension. */
export function isFree(record: CatalogRecord): boolean {
  const cost = record.cost;
  if (!isPlainObject(cost)) return false;
  const values = Object.values(cost);
  return values.length > 0 && values.every((value) => value === 0);
}

/** D2: models.dev omits `status` for active models; only `deprecated` retires one. */
export function isActive(record: CatalogRecord): boolean {
  return record.status !== "deprecated";
}

/**
 * D1: what the catalogue keeps — `status` absent (how models.dev says active),
 * `active`, or `deprecated`. A `deprecated` model STAYS in the catalogue:
 * only a probe can tell a finished free tier from a stale upstream record, and
 * a model dropped here could never be probed or brought back (D6a). Any other
 * status value is discarded outright.
 */
export function isCatalogueStatus(record: CatalogRecord): boolean {
  const status = record.status;
  if (status === undefined) return true;
  return status === "active" || status === "deprecated";
}

function reasoningOptionTypes(record: CatalogRecord): string[] {
  const options = record.reasoning_options;
  if (!Array.isArray(options)) return [];
  return options
    .map((option) => (isPlainObject(option) && typeof option.type === "string" ? option.type : undefined))
    .filter((type): type is string => type !== undefined);
}

/** pi-ai's level vocabulary, in the order it filters them. */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * models.dev effort spellings that pi-ai's vocabulary lacks, and what they mean.
 *
 * `"none"` is the one that occurs: `north-mini-code-free` publishes
 * `["none","high"]`. The old membership test discarded it as "not a level",
 * which removed that model's only off member. Adding a spelling here is a
 * one-line change; the same filter used to make it vanish silently.
 */
export const FOREIGN_EFFORT_SPELLINGS: Record<string, string> = { none: "off" };

/**
 * `xhigh` and `max` are opt-in for pi-ai: absent from the map means NOT
 * offered. They are left that way here so the refusal surface stays limited to
 * levels with positive evidence.
 */
const OPT_IN_THINKING_LEVELS = new Set<string>(["xhigh", "max"]);

/**
 * What was MEASURED about one model's Off control, on one channel.
 *
 * `"none-works"` — `reasoning_effort:"none"` reached zero reasoning tokens.
 * `"level-works"` — `none` is unusable here but a named level is: big-pickle
 *   honours `minimal` (0/8 across six samples) while rejecting `none` outright;
 *   space-bunny and both muse-spark models honour their lowest declared level at
 *   ~4.6-4.9x less reasoning than omission.
 * `"noop"` — accepted with HTTP 200, reasoning still present (longcat).
 * `"rejected"` — HTTP 400.
 *
 * `api` is what makes a stale measurement detectable rather than permanent: Off
 * is `reasoning_effort` on completions and `reasoning.effort` on responses, and a
 * measurement of one is evidence about the other only by coincidence.
 */
export interface MeasuredEffort {
  readonly kind: "none-works" | "level-works" | "noop" | "rejected";
  /** The level name when `kind === "level-works"`; omitted otherwise. */
  readonly level?: string | undefined;
  /** Fingerprint of the record's `reasoning_options`, so a revision voids it. */
  readonly fp: string;
  /** Channel it was measured on. */
  readonly api: string;
  readonly at: number;
}

/**
 * The shape of `reasoning_options`, reduced.
 *
 * Exported for diagnostics only — the Off rule must never consult it. Measured on
 * the live set: `[]` contained three models that accepted `none` and one that
 * rejected it; `[{type:"toggle"}]` contained one that honoured it and one that
 * ignored it. The shape carries no predictive power, so deriving an Off value from
 * it is a guess with no evidence behind it.
 */
export function reasoningControlShape(record: CatalogRecord): "effort" | "empty" | "toggle" | "silent" {
  const options = record.reasoning_options;
  if (!Array.isArray(options)) return "silent";
  let sawEffort = false;
  let sawToggle = false;
  for (const option of options) {
    if (!isPlainObject(option)) continue;
    if (option.type === "effort") sawEffort = true;
    else if (option.type === "toggle") sawToggle = true;
  }
  if (sawEffort) return "effort";
  if (sawToggle) return "toggle";
  return options.length === 0 ? "empty" : "silent";
}

/** Stable fingerprint of exactly what an effort measurement is about. */
export function reasoningFingerprint(record: CatalogRecord): string {
  const options = Array.isArray(record.reasoning_options) ? record.reasoning_options : null;
  return `${record.reasoning === false ? "no" : "yes"}:${options === null ? "absent" : JSON.stringify(options)}`;
}

/**
 * Which instrument produced the effort samples on a record.
 *
 * Reading 1 never read `usage.reasoning` (the field `usageOf` did not copy), so
 * every sample it wrote was a hard 0 — a constant, not a measurement. Those
 * samples cannot be recognised from their VALUE: a model asked for `low` and
 * reporting zero reasoning is possible, so "0" is a legitimate observation and
 * guessing would be the very mistake this axis exists to remove.
 *
 * They are recognisable by their INSTRUMENT. A measurement format change
 * invalidates the measurements taken under the old one, exactly as a changed
 * `reasoning_options` invalidates a fingerprint; this is the same idea with the
 * other operand. Nothing is lost: the old instrument could not produce a
 * confirmed verdict at all, so no real measurement is thrown away — only
 * baselines that would otherwise poison the median forever (a single stored 0
 * alongside real samples keeps `median(baseline)` at 0, which `effortVerdictFrom`
 * reads as "no claim", for ever).
 */
export const EFFORT_READING = 2;

/**
 * How many consecutive agreeing samples an effort verdict needs before it may be
 * persisted.
 *
 * Measured 2026-10-06, `big-pickle` accepted `reasoning_effort:"none"` on six of
 * nine identical requests and returned HTTP 400 on the other three, while
 * `reasoning_content` was present on every 200. One sample therefore records the
 * wrong row about a third of the time, and — unlike an `inconclusive` — nothing
 * downstream can detect it, because the probe returned a clean 200.
 *
 * Three is the smallest count that turns an intermittent failure into a
 * negligible one without making the round unconverge.
 */
export const EFFORT_CONCORDANCE = 3;


/** The recent samples a verdict is judged against, oldest first. */
export type EffortSamples = readonly MeasuredEffort["kind"][];

/**
 * Which spelling the probe is currently asking about.
 *
 * The round does not ADD a probe when `none` proves unusable — it changes what
 * the request it was already making asks. Measured 2026-10-06, big-pickle never
 * accumulates three agreeing samples for `none`, so it would sit unmeasured
 * forever and the user would never get the Off row that `minimal` demonstrably
 * provides (0 reasoning tokens across six samples). One request per round either
 * way; only the question changes.
 */
export type EffortQuestion = "baseline" | "none" | (string & {});

/**
 * A candidate counts as a working Off below this fraction of the same model's
 * omitted baseline, taken in the same round.
 *
 * Measured 2026-10-06 on the two models that can be reached:
 *   big-pickle  minimal 0-8   against omitted 14-16  ->  0.00-0.57
 *   longcat     minimal 36     against omitted 36-45  ->  0.80-1.00
 * longcat's `minimal` output is byte-identical to omitting, so it genuinely
 * does nothing there; big-pickle's is a 95-100% reduction.
 *
 * A RATIO, not an absolute count. The absolute counts would separate this pair
 * too (8 against 36) and that is the trap: longcat's floor of 36 sits ABOVE
 * big-pickle's omitted baseline of 14, so any fixed absolute number collides the
 * moment a third model appears.
 *
 * 0.43 is DERIVED, not determined: it is the max-margin cut in log space of the
 * measured bracket, and ANY value in (0.231, 0.800) classifies the whole
 * dataset correctly. It is recorded as a judgement call so the next measurement
 * does not get to choose it symmetrically. At 0.43 the margins are 1.86x on
 * each side — nothing in the dataset lands closer.
 */
export const EFFORT_WORKING_RATIO = 0.43;

/**
 * Decisive rejections before the probe moves to the next candidate.
 *
 * One, not three. big-pickle's `none` sits at a ratio of 12.4 — a rejection so
 * far outside the bracket that repeating it only spends quota to confirm what is
 * already settled. `longcat` is the counter-example that keeps the fallback at
 * all: its `none` is 1.578 and its lowest level is 0.800, so both candidates
 * must be spent before the model can honestly be left with no Off row.
 */
export const EFFORT_FALLBACK_AFTER = 1;

/** Samples per side before a verdict is drawn. A median needs more than one. */
export const EFFORT_SAMPLES = 3;
/**
 * How many candidate samples a verdict costs before it can be persisted.
 *
 * Not `EFFORT_CONCORDANCE`: a candidate verdict only exists once
 * `EFFORT_SAMPLES` samples have been judged against the model's own baseline
 * (the median, not a per-sample test), and then `EFFORT_CONCORDANCE` of those
 * verdicts must agree. Replay 2026-10-06: five candidate samples are consumed
 * before a model confirms — samples 1 and 2 cannot be judged at all, and 3, 4
 * and 5 are the first three verdicts.
 */
export const EFFORT_CANDIDATE_SAMPLES = EFFORT_SAMPLES + EFFORT_CONCORDANCE - 1;
/**
 * Requests one model may cost inside a single MANUAL round.
 *
 * The daily round keeps one request per model: nobody asked for it, and it spends
 * the same bucket. A manual round is the user saying "measure these now", and one
 * request left every model one sample short of a median — a completed round, an
 * unchanged picker, and no way to tell progress from failure.
 *
 * Sized from the evidence thresholds rather than guessed: three baseline samples
 * (a median needs more than one), one refusal (`EFFORT_FALLBACK_AFTER` is what
 * moves a model off `none` onto its own lowest level), and five candidate ones at
 * that level (the first two cannot be judged, and three judged verdicts must
 * agree). `effortMeasurementPending` stops the loop the moment a model has its
 * answer, so this is a CEILING, not a bill — a model whose `none` is the answer
 * spends eight, and one whose `none` is refused spends the ninth on the fallback.
 */
export const MANUAL_SAMPLE_BUDGET = EFFORT_SAMPLES + EFFORT_FALLBACK_AFTER + EFFORT_CANDIDATE_SAMPLES;

/**
 * Requests one round may spend on the CAPABILITY axes — the ceiling question and
 * the two declared-capability questions — per model.
 *
 * Deliberately NOT part of `samplesPerModel`. That number is the EFFORT axis's
 * budget, and the daily round runs it at 1, so sharing the counter meant the
 * ceiling and capability questions never fired outside a manual round: the block
 * broke on `shots >= samplesPerModel` before its first request. ADR 0004 §49
 * described the harvest as part of every round; the code said otherwise, and the
 * code was right about what shipped and wrong about what was documented.
 *
 * Three is the whole budget, so a model that appears on Zen tonight is fully
 * measured by tomorrow's daily round and costs nothing again on any round after
 * that — the gate is the evidence, not the budget.
 */
export const CAPABILITY_SAMPLE_BUDGET = 3;

/**
 * Which spelling to ask about next.
 *
 * The baseline is asked for rather than assumed, because a threshold on an
 * absolute count is not defensible across models. It costs nothing extra: the
 * round alternates the question inside the one request it was already making,
 * so the per-round cost is unchanged and the pairing is consecutive.
 */
/**
 * The level to fall back on for a model whose `none` is unusable.
 *
 * The model's OWN lowest published level, not a fixed one. Measured 2026-10-06:
 * space-bunny-free publishes `low…max` and its `low` brings reasoning to
 * 0/9/22/37 against an omitted baseline of 35 — a working Off. Asking it for
 * `minimal` instead measures a level it never published and finds nothing, so
 * the row is withheld from a model that has one. A model publishing no ladder at
 * all falls back to `minimal`, which is where big-pickle's 0/8 was measured.
 */
export function fallbackLevelFor(record: CatalogRecord): string {
  const published: string[] = [];
  for (const option of Array.isArray(record.reasoning_options) ? record.reasoning_options : []) {
    if (!isPlainObject(option) || option.type !== "effort") continue;
    for (const value of Array.isArray(option.values) ? option.values : []) {
      if (typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)) published.push(value);
    }
  }
  // Lowest by the vocabulary's own order, not by declaration order.
  for (const level of THINKING_LEVELS) {
    if (level === "off") continue;
    if (published.includes(level)) return level;
  }
  return "minimal";
}

/**
 * How long a CONFIRMED effort verdict stands before it is re-litigated.
 *
 * Thirty days, and the clock only runs while nothing interesting happened. The
 * point of a TTL here is not freshness — it is BOUNDING. A verdict that keeps
 * absorbing samples has a median over an ever-growing set, which is a different
 * statistic from the median of three that produced it: big-pickle's `minimal`
 * alternates 0 and 8, and a slowly growing median can drift across the boundary
 * and silently demote a control the model demonstrably supports.
 */
export const EFFORT_TTL_MS = 30 * 24 * 60 * 60_000;

/**
 * How long a vision/tools verdict stays authoritative.
 *
 * The effort axis has always had a TTL and the capability axes did not, which made
 * a probe from months ago indistinguishable from one taken today: a model that
 * gained tool support, or lost it, kept its mark for ever, and nothing could ever
 * downgrade it. Thirty days matches the effort axis, so "stale" means the same
 * thing on both.
 */
export const CAPABILITY_TTL_MS = 30 * 24 * 60 * 60_000;

/** Whether a confirmed effort verdict still stands. */
export function effortVerdictFresh(
  record: ProbeRecord | undefined,
  fingerprint: string,
  now: number,
): boolean {
  const effort = record?.effort;
  if (effort === undefined) return false;
  if (effort.fp !== fingerprint) return false;
  if (record?.effortFrozenAt === undefined) return false;
  return now - record.effortFrozenAt < EFFORT_TTL_MS;
}

/**
 * Whether one more request would still teach this round something.
 *
 * The round asks a model the same question until the axis has an answer, not
 * until a round ends: a round that spent one request per model left every model
 * one sample short of a median, so a manual click could not change a capability
 * row at all — the user saw a completed round and an unchanged picker.
 *
 * This is the loop condition, and it is derived from the evidence thresholds
 * rather than a hard-coded count, so it stays correct when those move.
 */
export function effortMeasurementPending(
  model: Model<Api>,
  record: ProbeRecord | undefined,
  question: EffortQuestion,
): boolean {
  // No Off axis to measure: a non-reasoning model has no map, so no sample of
  // its effort could ever change what the user is offered.
  if (!model.reasoning || model.thinkingLevelMap === undefined) return false;
  if (question === "settled") return false;
  if (question === "baseline") return (record?.effortBaselineTokens?.length ?? 0) < EFFORT_SAMPLES;
  return (record?.effortTokens?.length ?? 0) < EFFORT_CANDIDATE_SAMPLES;
}

/**
 * Whether this model's reasoning can be measured at all.
 *
 * A baseline of zero makes the axis STRUCTURALLY undecidable: the ratio test is
 * `candidate < 0.43 × baseline`, and nothing is below 0.43 × 0, so neither "works"
 * nor "noop" is reachable — and a question whose answer cannot land must not be
 * asked at all.
 *
 * Measured 2026-10-06: `fledge-alpha-free` sends no `completion_tokens_details`
 * (ADR 0004 §33), so its baseline reads 0. Stopping the LOOP was not enough: the
 * round still opened with one shot, that shot asked the spelling, and its reading
 * was filed — so the sample array grew by one every round for ever. Deciding it
 * here instead means the round asks for LIVENESS only, exactly like a settled
 * model, and nothing accumulates.
 */
function effortAxisUndecidable(record: ProbeRecord | undefined): boolean {
  const baseline = record?.effortBaselineTokens;
  return baseline !== undefined && baseline.length >= EFFORT_SAMPLES && median(baseline) === 0;
}

/**
 * Models whose reasoning measurement is still open, in catalogue order.
 *
 * The panel needs to say "these still need measuring" rather than make the user
 * infer it from a missing row, and it must be the SAME predicate the loop uses —
 * an id whose axis is undecidable or settled is not pending either.
 */
export function pendingEffortIds(state: CatalogState): string[] {
  // The SAME list the picker offers. `state.models` is the pre-gate catalogue,
  // so a model Zen no longer lists would otherwise be reported as "still being
  // measured" — the panel would then ask the user to keep clicking for a model
  // that is not in their picker at all and never will be (live 2026-10-06: 28
  // pending, 23 of them not-listed).
  return effectiveList(state.models, state.zenIds, state.probes)
    .filter((model) => !effortVerdictFresh(state.probes[model.id], "", 0))
    .filter((model) => {
      const record = state.probes[model.id];
      const raw = state.cache?.models?.[model.id];
      const question = nextEffortQuestion(record, raw === undefined ? "minimal" : fallbackLevelFor({ ...raw, id: model.id }));
      if (question === "settled") return false;
      return effortMeasurementPending(model, record, question);
    })
    .map((model) => model.id);
}

export function nextEffortQuestion(
  record: ProbeRecord | undefined,
  fallback = "minimal",
  settled = false,
): EffortQuestion {
  if (effortAxisUndecidable(record)) return "settled";
  // A confirmed verdict stands. The model is still probed for LIVENESS — that is
  // unchanged and still how a `dead` verdict is earned — but no further effort
  // sample is taken, because a verdict that keeps absorbing samples has a median
  // over an ever-growing set. That is a different statistic from the three that
  // produced it, and a slowly drifting median can silently demote a control the
  // model demonstrably supports.
  if (settled) return "settled";
  // The liveness request IS the omitted request on a no-ladder model — its
  // hardcoded `reasoning: "low"` clamps to omission there — so the baseline
  // usually arrives without a round being spent on asking for it.
  if ((record?.effortBaselineTokens?.length ?? 0) < EFFORT_SAMPLES) return "baseline";
  if (typeof record?.effortQuestion === "string" && record.effortQuestion !== "none" && record.effortQuestion !== "baseline") {
    return record.effortQuestion;
  }
  return (record?.effortDiscord ?? 0) >= EFFORT_FALLBACK_AFTER ? fallback : "none";
}

/**
 * Whether a candidate brought reasoning down to the floor.
 *
 * Returns `undefined` when there is no baseline, which the caller must read as
 * "no claim" rather than as a negative: a model we have not measured against
 * itself has told us nothing about whether a level works.
 */
export function effortWorking(candidate: number, baseline: number | undefined): boolean | undefined {
  if (baseline === undefined || baseline <= 0) return undefined;
  return median([candidate]) < EFFORT_WORKING_RATIO * median([baseline]);
}

/**
 * The median of a sample set.
 *
 * Classification runs on a MEDIAN, never per sample. Per-sample classification
 * measures the classifier's fragility rather than the model's: big-pickle's
 * `minimal` alternates 0 and 8, and a `=== 0` test flips on that even though
 * both values sit two orders of magnitude below its baseline.
 */
function median(values: readonly number[]): number {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The verdict for a candidate, judged on the medians of what has been seen.
 *
 * `undefined` means no claim: without enough of either side there is nothing to
 * compare, and "we did not look" must never read as "it does not work".
 */
export function effortVerdictFrom(
  candidateSamples: readonly number[] | undefined,
  baselineSamples: readonly number[] | undefined,
): boolean | undefined {
  if (baselineSamples === undefined || baselineSamples.length === 0) return undefined;
  if (candidateSamples === undefined || candidateSamples.length === 0) return undefined;
  const base = median(baselineSamples);
  const cand = median(candidateSamples);
  if (!Number.isFinite(base) || !Number.isFinite(cand) || base <= 0) return undefined;
  return cand < EFFORT_WORKING_RATIO * base;
}

/**
 * Whether a fresh sample agrees with what came before.
 *
 * A sample that DISAGREES resets the tally rather than being averaged or
 * out-voted: `big-pickle`'s six-to-three record would decide "accepted" by
 * majority, which is precisely the reading its own data refutes — when it does
 * accept `none`, the reasoning is still present.
 *
 * An `inconclusive` produces no sample at all and so leaves the tally untouched:
 * a gated IP is not evidence about the model.
 */
export function effortVerdict(
  previous: EffortSamples | undefined,
  candidate: MeasuredEffort["kind"],
): { kind: "sample"; samples: EffortSamples } | { kind: "discord"; samples: EffortSamples } | { kind: "confirmed" } {
  const prior = Array.isArray(previous) ? previous : [];
  const agrees = prior.length > 0 && prior.every((sample) => sample === candidate);
  if (!agrees) {
    // Keep only the newest: a stale disagreement must not delay forever.
    return { kind: "discord", samples: [candidate] };
  }
  const samples = [...prior, candidate];
  if (samples.length >= EFFORT_CONCORDANCE) return { kind: "confirmed" };
  return { kind: "sample", samples };
}

/** Defensive read of a persisted effort measurement, in `isMeasuredChannel`'s style. */
export function isMeasuredEffort(value: unknown): value is MeasuredEffort {
  if (!isPlainObject(value)) return false;
  if (value.kind !== "none-works" && value.kind !== "level-works" && value.kind !== "noop" && value.kind !== "rejected") {
    return false;
  }
  if (typeof value.fp !== "string" || typeof value.at !== "number" || !isMeasuredChannel(value.api)) return false;
  if (value.kind !== "level-works") return true;
  return typeof value.level === "string" && (THINKING_LEVELS as readonly string[]).includes(value.level);
}

/**
 * A persisted question is one this module can ask again.
 *
 * `none` and `baseline` are the round's own markers; anything else must be a
 * level name pi-ai knows, because a question nobody can re-ask is a stuck model.
 * The old reader allowed only `none` and `minimal`, so a fallback LEVEL — `low`
 * on space-bunny-free — was dropped on restart and the model was asked `none`
 * again, the very request its models.dev ladder refuses.
 */
function isEffortQuestion(value: unknown): value is EffortQuestion {
  if (value === "none" || value === "baseline") return true;
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}


/**
 * D6: the thinking levels models.dev publishes for this model, as pi-ai's
 * `thinkingLevelMap`.
 *
 * The values are identity because OpenCode is OpenAI-compatible and the level
 * name is what goes on the wire (`reasoning_effort` on completions, `effort` on
 * responses); the map's job here is to say which levels EXIST.
 *
 * `off` is deliberately left absent (offered) rather than nulled: it means
 * "send no reasoning parameter", which is a real choice the user asked to keep
 * as an explicit row. The placeholder effort pi-ai would otherwise put on the
 * wire for it (`"none"` by default, `"off"` when explicitly chosen — neither of
 * which pi-ai's own builtin records nor OpenCode ever send) is stripped back
 * to "no reasoning object" by the plugin's onPayload guard in zen-provider.ts,
 * so offering it is safe.
 *
 * `undefined` means "models.dev published no level list, so make no claim" —
 * pi-ai then falls back to its own default set. That is the honest answer for
 * a `toggle` model (reasoning is on or off, and pi-ai has no name for bare
 * "on") and for a record with `reasoning_options: []`. Guessing there would
 * offer levels upstream rejects, which surfaces as an
 * `UNSUPPORTED_REASONING_EFFORT` failure rather than as a clamp.
 */
export function thinkingLevelMapFor(
  record: CatalogRecord,
  channel: Api,
  measured?: MeasuredEffort,
  /** Levels the MODEL ITSELF named, from a refusal that enumerated them. */
  selfReported?: readonly string[],
): Record<string, string | null> | undefined {
  // R0 — no reasoning claim: say nothing at all. An ABSENT `reasoning` is as
  // little a claim as `false` is, and `getSupportedThinkingLevels` already
  // answers ["off"] for a non-reasoning model, so a map here would be decoration.
  if (record.reasoning !== true) return undefined;

  const published = new Set<string>();
  let hasLadder = false;
  const options = record.reasoning_options;
  if (Array.isArray(options)) {
    for (const option of options) {
      if (!isPlainObject(option) || option.type !== "effort") continue;
      hasLadder = true;
      const values = option.values;
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        if (typeof value !== "string") continue;
        // Foreign spellings are DATA, not filtered out. Dropping "none" here is
        // what silently discarded north-mini-code-free's only off member.
        if ((THINKING_LEVELS as readonly string[]).includes(value)) published.add(value);
        else if (FOREIGN_EFFORT_SPELLINGS[value] !== undefined) {
          published.add(FOREIGN_EFFORT_SPELLINGS[value]);
        }
      }
    }
  }

  // ALWAYS a map for a reasoning model. Returning `undefined` is NOT "no claim" —
  // pi-ai reads an absent map as "offer everything", which is how seven live
  // models were offered four levels models.dev publishes nothing for.
  const map: Record<string, string | null> = {};

  // The single Off rule. `shape` is deliberately never consulted: measured on the
  // live set, two models with the identical `[{type:"toggle"}]` shape behaved
  // oppositely, and three of four `reasoning_options: []` models accepted "none"
  // while the fourth rejected it with a hard 400.
  if (published.has("off")) {
    // R1 — the published vocabulary HAS an off member and names it.
    map.off = "none";
  } else if (measured !== undefined && measured.api === channel) {
    // R3 — measured on THIS channel to reach zero.
    map.off =
      measured.kind === "none-works"
        ? "none"
        : measured.kind === "level-works" && measured.level !== undefined
          ? measured.level
          : null;
  } else {
    // Unmeasured, or measured on the other channel: no claim.
    map.off = null;
  }

  // The ladder rows are NOT filtered by models.dev.
  //
  // Measured 2026-10-06, across eight models and both channels: NO ladder level
  // has ever been refused — not a declared one, and not an undeclared one.
  // `big-pickle` accepts `low` (164 reasoning tokens), `muse-spark-1.3` accepts a
  // `max` it never published (516, the highest on that model, corroborated by
  // its own 400 listing the allowed set), and `mimo-v2.6-flash-free` accepts
  // `minimal` and `high`.
  //
  // The asymmetry with `off` is the whole reason the two are handled apart. An
  // IGNORED ladder level is inert: the user gets the default, which is what the
  // provider-default row also gives. An ignored `off` is the opposite of its
  // promise — maximum thinking where the user asked for none — so `off` is
  // gated on measurement and a ladder level is not.
  //
  // xhigh/max stay opt-in, as pi-ai intends: they are offered only where a
  // DECLARATION named them, or a measurement showed one doing something.
  //
  // A model's OWN self-report is deliberately NOT one of those. It is evidence
  // about VALIDITY — the spelling is accepted instead of 400'd — and that is
  // exactly what it says. It is not evidence about AVAILABILITY, and the two come
  // apart: a tier can accept `max` and route the request to `xhigh` instead,
  // answering 200 with the reasoning count of a mode the user did not choose.
  //
  // Measured 2026-10-06 and confirmed by the operator: `max` is not open to
  // individuals on this route. The refusal that names it lists
  // `[minimal, low, medium, high, xhigh, max]`, and one `max` request came back
  // 200 — with NO token count recorded, so nothing ever distinguished "honored"
  // from "silently downgraded". models.dev does not publish `max` for this model
  // either, which is what a tier that does not expose it looks like.
  //
  // The recorded vocabulary is kept: it is what makes a refusal useful later, and
  // §19 already showed that a declaration's SHAPE carries no predictive power —
  // a model's enumeration is a shape too, and it must not grant a capability.
  //
  // `selfReported` is a parameter this function accepts and deliberately does
  // not consult for what to OFFER. It is kept on the signature because
  // `derive` carries it as evidence and dropping it here would make the two look
  // unrelated when they are the same record.
  const named = new Set(published);
  for (const level of THINKING_LEVELS) {
    if (level === "off") continue;
    if (named.has(level)) map[level] = level;
    else if (!OPT_IN_THINKING_LEVELS.has(level)) map[level] = level;
    // else: xhigh/max absent means NOT offered, which is pi-ai's own rule.
  }
  return map;
}

/**
 * D6, three tiers: the pi-ai builtin table when it knows the model, then
 * models.dev signals, then the provider's own default. Validated 7/7 against
 * the known opencode models (interleaved/toggle ⇒ completions, effort ⇒
 * responses).
 */
export function channelFor(record: CatalogRecord, knownApis?: ReadonlyMap<string, Api>): Api {
  const id = typeof record.id === "string" ? record.id : undefined;
  if (id !== undefined && knownApis !== undefined) {
    const known = knownApis.get(id);
    if (known !== undefined) return known;
  }
  if (record.interleaved !== undefined) return "openai-completions";
  const types = reasoningOptionTypes(record);
  if (types.includes("toggle")) return "openai-completions";
  if (types.includes("effort")) return "openai-responses";
  return "openai-completions";
}

export interface DeriveOptions {
  /** pi-ai builtin `id -> api`, tier 1 of D6. */
  readonly knownApis?: ReadonlyMap<string, Api>;
  /** An already identity-mapped record supplying the fallback field values. */
  readonly template: Model<Api>;
  /**
   * Per-model Off evidence, keyed by model id. Supplied rather than read from
   * state so `derive()` stays pure and fixture-testable.
   */
  readonly measuredEffort?: ReadonlyMap<string, MeasuredEffort>;
  /**
   * Measured context windows, keyed by id. Supplied rather than read from state
   * so `derive()` stays pure and fixture-testable, exactly like `measuredEffort`.
   */
  readonly measuredContext?: ReadonlyMap<string, MeasuredContext>;
  /**
   * Ceilings the ROUTE has stated about itself, keyed by id. Same reason, and it
   * travels beside `measuredEffort` rather than inside it: this axis is about
   * the request's own limits, not about the model's reasoning.
   */
  readonly measuredLimits?: ReadonlyMap<string, MeasuredLimits>;
}

export interface DerivedCatalog {
  /** Free AND `status ∈ {active, deprecated}` — the pre-Zen-gate catalogue. */
  readonly candidates: Model<Api>[];
}

/**
 * One models.dev record → one pi-ai model. Everything the plugin can learn
 * about a model's CAPABILITIES is taken from the record rather than inherited:
 *
 *   - image input      ← `modalities.input` (pi-ai knows only text/image, so
 *                        audio/video/pdf are dropped, not silently kept)
 *   - context window   ← `limit.context`, lifted where the endpoint stated its own
 *   - max output       ← `limit.output`, lifted where the route accepted more
 *   - thinking levels  ← `reasoning_options[].values`
 *
 * A field models.dev does not publish falls back to the template, and the
 * template is one fixed record — so `thinkingLevelMap` is set EXPLICITLY in
 * both branches. Inheriting another model's level list would offer levels this
 * model rejects, which the host reports as `UNSUPPORTED_REASONING_EFFORT`
 * rather than clamping.
 */
function buildModel(
  record: CatalogRecord,
  template: Model<Api>,
  knownApis?: ReadonlyMap<string, Api>,
  measured?: MeasuredEffort,
  measuredContext?: MeasuredContext,
  measuredLimits?: MeasuredLimits,
): Model<Api> {
  const id = typeof record.id === "string" && record.id !== "" ? record.id : "";
  const api = channelFor(record, knownApis);
  const limit = isPlainObject(record.limit) ? record.limit : {};
  const modalities = isPlainObject(record.modalities) ? record.modalities : {};
  const declaredInput = Array.isArray(modalities.input)
    ? modalities.input.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image")
    : [];
  const levels = thinkingLevelMapFor(record, api, measured);
  const contextWindow =
    contextWindowFor(record, measuredContext) ?? finitePositive(limit.context) ?? template.contextWindow;
  return {
    ...template,
    id,
    name: typeof record.name === "string" && record.name !== "" ? record.name : id,
    api,
    // Absence is NOT `true`. The template resolves to mimo-v2.6-flash-free
    // (reasoning true, input text+image), so inheriting it answered "models.dev
    // did not tell us" with "inherit the most capable thing we know" — the same
    // error as an undefined map, one field over.
    reasoning: record.reasoning === true,
    input: declaredInput.length > 0 ? declaredInput : ["text"],
    // Free by construction here (isFree already proved it); stated explicitly
    // so a stray inherited tier cannot reintroduce a non-zero rate.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    // The window first, because the output ceiling is bounded by it: a ceiling
    // above the context it must fit inside is not a bigger ceiling, it is a lie.
    maxTokens: maxTokensFor(record, id, contextWindow, measuredLimits) ?? template.maxTokens,
    thinkingLevelMap: (levels ?? undefined) as Model<Api>["thinkingLevelMap"],
    // `compat` is transport-specific. Carrying the template's completions
    // overrides onto a responses model would misconfigure it, so a channel
    // change drops them and lets pi-ai auto-detect from baseUrl.
    compat: (api === template.api ? template.compat : undefined) as Model<Api>["compat"],
  };
}

/**
 * Alphabetical by id, with a plain comparison rather than `localeCompare`: the
 * ids are lowercase ASCII, and ICU collation orders `kimi-k2.5-free` and
 * `kimi-k2-5-free` differently depending on the host's locale — a list whose
 * order depends on the machine is not an order anyone can rely on.
 */
export function byId<T extends { readonly id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Pure: models.dev models dictionary → pre-gate catalogue. */
export function derive(section: CatalogRecord, options: DeriveOptions): DerivedCatalog {
  const candidates: Model<Api>[] = [];
  for (const [key, value] of Object.entries(section)) {
    if (!isPlainObject(value)) continue;
    const id = typeof value.id === "string" && value.id !== "" ? value.id : key;
    if (id === "") continue;
    const record: CatalogRecord = { ...value, id };
    if (!isFree(record)) continue;
    // D1: `deprecated` is kept (a probe judges it); anything else is discarded.
    if (!isCatalogueStatus(record)) continue;
    candidates.push(
      buildModel(
        record,
        options.template,
        options.knownApis,
        options.measuredEffort?.get(id),
        options.measuredContext?.get(id),
        options.measuredLimits?.get(id),
      ),
    );
  }
  // Sorted HERE, at the one place the list is born, so the snapshot, the
  // visible set and the picker all inherit the same order instead of each
  // deciding for itself. models.dev's own order is grouped by vendor and
  // family, which reads as arbitrary to anyone scanning for one model.
  return { candidates: candidates.slice().sort(byId) };
}

export interface FetchLikeResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<FetchLikeResponse>;

export interface FetchSectionOptions {
  readonly fetchImpl: FetchLike;
  /** Sent as `if-none-match`; callers MUST omit it when no cache exists (R5). */
  readonly etag?: string | undefined;
  readonly url?: string;
  readonly userAgent?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export type FetchSectionResult =
  | { readonly kind: "not-modified" }
  | { readonly kind: "ok"; readonly etag: string | undefined; readonly section: CatalogRecord }
  | { readonly kind: "failed"; readonly reason: string };

/** D1: one conditional GET. Every failure mode is reported, never thrown. */
export async function fetchSection(options: FetchSectionOptions): Promise<FetchSectionResult> {
  const {
    fetchImpl,
    etag,
    url = MODELS_DEV_URL,
    userAgent = DEFAULT_USER_AGENT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
  } = options;
  const headers: Record<string, string> = { accept: "application/json", "user-agent": userAgent };
  if (typeof etag === "string" && etag !== "") headers["if-none-match"] = etag;
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 304) return { kind: "not-modified" };
    if (!response.ok) return { kind: "failed", reason: `http ${response.status}` };
    const text = await readBounded(response, maxBytes);
    if (text === null) return { kind: "failed", reason: "response too large" };
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // A stable reason, not the engine's SyntaxError text: callers and logs
      // compare on this vocabulary.
      return { kind: "failed", reason: "malformed response body" };
    }
    if (!isPlainObject(body)) return { kind: "failed", reason: "malformed response body" };
    // api.json is keyed by provider: `body.opencode` is the PROVIDER record
    // ({id,env,npm,api,name,doc,models}) and the model dictionary sits one
    // level deeper. Handing the provider record to `derive` yields an EMPTY
    // catalogue — none of those keys carries a zero cost — which is worse than
    // the offline floor. The unwrap therefore happens here, once, and `derive`
    // only ever sees a models dictionary.
    const provider = body.opencode;
    if (!isPlainObject(provider)) return { kind: "failed", reason: "missing opencode section" };
    const models = provider.models;
    if (!isPlainObject(models)) return { kind: "failed", reason: "missing opencode models section" };
    return { kind: "ok", etag: response.headers.get("etag") ?? undefined, section: models };
  } catch (error) {
    const name = isPlainObject(error) && typeof error.name === "string" ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "failed", reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : message };
  }
}

/**
 * Read a response body, refusing to grow past `maxBytes`.
 *
 * `await response.text()` first and check the length afterwards can only
 * REJECT an oversized body, never prevent it: by the time the check ran, the
 * whole thing was already resident in the DSH process. A 20MB ceiling that still
 * admits a 400MB error page buys nothing, and the symptom (a desktop host dying
 * with no visible cause) is three steps removed from the reason. Measured
 * 2026-09-30: a 40MB body against a 20MB cap buffered all 40MB.
 *
 * `content-length` is consulted first because it makes the common case free; the
 * streaming read is what makes the chunked case honest. Returns null when the
 * body is refused, which the caller reports as `response too large` — the same
 * reason string as before, so nothing downstream had to change.
 */
async function readBounded(response: FetchLikeResponse, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const body = (response as { body?: ReadableStream<Uint8Array> | null }).body;
  // No stream (a hand-rolled fetch double, or a Response subclass): fall back to
  // the buffered read and check afterwards. Slightly less safe, and the only way
  // to serve those inputs at all.
  if (!body || typeof body.getReader !== "function") {
    const text = await response.text();
    return Buffer.byteLength(text, "utf8") > maxBytes ? null : text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    // Stop the transfer rather than finishing it: the point of the cap is not
    // to spend the memory, and cancelling is what actually returns it.
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface CatalogCacheRecord {
  readonly version: number;
  readonly etag: string | undefined;
  readonly fetchedAt: number;
  /** The `opencode.models` dictionary — named for what it holds, not the slice it came from. */
  readonly models: CatalogRecord;
  /** Conclusive verdicts only; empty means "no history", i.e. all unprobed. */
  readonly probes: ProbeMap;
  /**
   * Ask-again cadence per model.
   *
   * Deliberately NOT inside `ProbeRecord`: a round that reached nothing must
   * write nothing there, and a model we never reached has no verdict to give it.
   */
  /**
   * Models whose stored verdict was NOT adopted, because a median-based verdict
   * with no samples behind it cannot be reproduced. In-memory only: every write
   * site names its fields, so this never reaches disk.
   */
  readonly droppedVerdicts?: readonly string[];
  /** When the last probe ROUND ran, whether or not it concluded anything. */
  readonly lastProbeAt: number;
  /**
   * The last round's report — the tally and the per-row outcomes the panel
   * draws. It lives here because the live reading is memory-only, and memory
   * does not survive a restart: without this the card adopts nothing on mount
   * after a restart and the progress area is simply blank, which reads as
   * "the probe display is gone" rather than "there is nothing to report yet".
   * Optional and version-stable; a cache without it restores as before.
   */
  readonly lastRound?: {
    readonly total: number;
    readonly done: number;
    readonly results: Record<string, ProbeProgressResult>;
    /** The round's scope, so a restored report still says what it covered. */
    readonly targets?: readonly string[];
  };
}

/** A conclusive verdict. `inconclusive` is deliberately NOT one of them. */
export type ProbeVerdict = "ok" | "dead";

export interface ProbeRecord {
  readonly verdict: ProbeVerdict;
  readonly at: number;
  readonly reason?: string;
  /**
   * Whether this `dead` was established by asking every channel the provider
   * implements, rather than by a single request.
   *
   * It is the whole difference between "this model is gone" and "this request
   * was refused", because a wrong channel is answered with the same "not
   * supported" sentence a dead model produces. A verdict recorded before the
   * sweep existed has no marker and is therefore re-checked once: those older
   * verdicts are exactly the ones that may have been a routing mistake, and
   * leaving them permanent is how a working model stays missing forever.
   */
  readonly swept?: boolean;
  /**
   * When a swept `dead` verdict may be asked again.
   *
   * Written when the death is recorded, and READ by {@link isSettled}. It was
   * documented here from the start and never consulted, which made every removal
   * permanent — including the ones that were wrong.
   */
  readonly nextProbeAt?: number;
  /**
   * The channel this model actually ANSWERED on, when a probe found one.
   *
   * Everything else about a model's channel is inference: a pi-ai builtin table
   * entry, a models.dev signal, or a provider default. Inference is what sends a
   * request down the wrong channel and gets "model not supported" back — which
   * is indistinguishable from a dead model without asking the other channel. So
   * when the sweep DID get an answer, that answer outranks every inference above:
   * keeping it is the difference between a probe that says "ok" and a chat that
   * then fails on the same model.
   *
   * Persisted with the verdict, so the routing survives a restart. Only an `ok`
   * carries one — a refusal says nothing about which channel would have worked.
   */
  readonly api?: string;
  /**
   * What was MEASURED about this model's Off control, if anything has been.
   *
   * Absent means "unmeasured", which is NOT the same as "measured negative" —
   * conflating those two is the bug this whole axis exists to fix. `fp` and `api`
   * are what make a stale measurement detectable rather than permanent.
   */
  readonly effort?: MeasuredEffort;
  /**
   * Levels this model enumerated in a refusal.
   *
   * Kept even though the round recorded nothing else from that request: the
   * refusal is worthless as a verdict and valuable as a vocabulary, and the two
   * must not be conflated.
   */
  readonly selfReported?: readonly string[];
  /**
   * When this model's effort verdict was last confirmed.
   *
   * Set only on confirmation, and it stops sample accumulation: a verdict that
   * keeps absorbing samples has a median over a growing set, which is a different
   * statistic from the three that produced it.
   */
  readonly effortFrozenAt?: number;
  /**
   * What was MEASURED about this model's context window, if anything has been.
   *
   * Written only by the clamp observation, and only after repeated agreement —
   * a single silent reply is not evidence, and one gated round is not either.
   */
  readonly context?: MeasuredContext;
  /**
   * What was MEASURED about this model's declared capabilities, per axis.
   *
   * The two axes here are the ones a request can answer: give a model an image
   * and ask what it sees, give it real tools and ask it to call one. Context and
   * output are absent by design — they are not questions, they are ceilings.
   *
   * Written only when a measurement CONCLUDED. An upstream that was down, a
   * bucket that was spent, or a reply that was all thinking and no text writes
   * nothing, because "we could not find out" and "it cannot do this" are
   * different facts and only the first one is true most often.
   */
  readonly capabilities?: Partial<Record<CapabilityAxis, CapabilityVerdict>>;
  /**
   * Ceilings the ROUTE has stated about this model, harvested from refusals.
   *
   * This is the mechanism that replaces a table of guesses: the numbers come
   * from the route itself, at the moment it refused, and they are fingerprinted
   * against the declaration they were stated about so a changed declaration
   * discards them. `namedAt` records when — a ceiling stated last month may have
   * moved, and the panel shows the age rather than implying permanence.
   */
  readonly limits?: MeasuredLimits;
  /**
   * Which instrument wrote the effort samples here. See {@link EFFORT_READING};
   * a record without it is read as unmeasured on that axis.
   */
  readonly effortReading?: number;
  /**
   * The recent effort samples, oldest first. Persisted rather than held in
   * memory so a restart does not restart the count — the cost of a lost tally is
   * a few more rounds, and it is only ever spent on a model whose verdict is
   * still unconfirmed.
   */
  readonly effortSamples?: EffortSamples;
  /** Which spelling the probe is currently asking about. */
  readonly effortQuestion?: EffortQuestion;
  /** Discordant rounds seen on the current question; drives the fallback. */
  readonly effortDiscord?: number;
  /**
   * The model's reasoning tokens when nothing was asked for, as of the last
   * baseline round. A candidate is judged against THIS rather than against an
   * absolute count.
   */
  readonly effortBaseline?: number;
  /** Every candidate sample seen for the current question, kept to judge on. */
  readonly effortTokens?: readonly number[];
  /** Every omitted sample seen, the reference the candidate is judged against. */
  readonly effortBaselineTokens?: readonly number[];
  /**
   * Consecutive clamp observations seen since the last write. A confidence
   * gauge, not a verdict: a round that reaches nothing else still carries it
   * forward, so a restart resumes the count instead of restarting it — which is
   * the conservative direction, since `clampVerdict` raises only on agreement
   * and losing the count would only ever repeat the observation.
   */
  readonly contextHits?: number;
  /**
   * Replies this model has had CUT OFF at the budget, counted from real traffic.
   *
   * `output` is the question the whole output axis turns on: the plugin sends a
   * number, and this says whether a reply has ever wanted more of it. `context`
   * is counted apart because it is a different event — the conversation ran out
   * of room, which says nothing about the output budget being small.
   *
   * It costs nothing to keep: the transport sees `stopReason` on a request that
   * was being sent anyway. The alternative is a synthetic generation, and those
   * cost tens of thousands of tokens to answer a question real traffic answers for
   * free.
   */
  readonly budgetHits?: { readonly output?: number; readonly context?: number; readonly at?: number };
  /**
   * Milliseconds to the FIRST stream event on a real reply, newest first.
   *
   * Total latency says how long the model took to finish; this says how long you
   * waited before it started. A model that thinks for four seconds and then
   * answers in one is not slow to use — it is slow to start — and the panel can
   * only say that if it measured the two separately. Free: the transport sees
   * the first event on a request that was being made anyway.
   */
  readonly firstTokenMs?: readonly number[];
}

export type ProbeMap = Record<string, ProbeRecord>;

/** The two channels this provider speaks, and so the only values worth keeping. */
const MEASURED_CHANNELS: readonly string[] = ["openai-completions", "openai-responses"];

export function isMeasuredChannel(value: unknown): value is Api {
  return typeof value === "string" && MEASURED_CHANNELS.includes(value);
}

/**
 * Point a model at the channel it was last MEASURED on.
 *
 * The single place that claim is applied. Two callers, one rule: the round when
 * it records the answer, and the warm read when it adopts a cache that already
 * holds one — which is the half that makes it survive a restart. Without both,
 * the probe knows and nothing else does.
 */
export function applyMeasuredChannel(models: readonly Model<Api>[], probes: ProbeMap): void {
  for (const model of models) {
    const measured = probes[model.id]?.api;
    if (measured === undefined || measured === model.api) continue;
    (model as { api: Api }).api = measured;
  }
}

/**
 * The evidence a model's Off row is allowed to rest on.
 *
 * A record is dropped when its fingerprint or its channel no longer matches: the
 * measurement is OF a claim, and if the claim changed or was made on another
 * channel, the answer is about a question no longer being asked. Dropping it
 * leaves the derived map in its unmeasured state, which is the honest default —
 * an unmatched measurement must never widen what is offered.
 *
 * Two callers, one rule: the round when it records the answer, and the warm read
 * when it adopts a cache that already holds one. Without both, the measurement is
 * on disk and ignored — the exact failure `applyMeasuredChannel`'s comment warns of.
 */
export function measuredEffortFor(model: Model<Api>, probes: ProbeMap): MeasuredEffort | undefined {
  const effort = probes[model.id]?.effort;
  if (effort === undefined) return undefined;
  if (effort.api !== model.api) return undefined;
  return effort;
}

/**
 * Collect the per-model evidence `derive()` needs, in one pass.
 *
 * `section` is the raw models dictionary rather than the derived list, because
 * the fingerprint is computed from the record as models.dev publishes it — the
 * thing the measurement is actually about.
 */
export function measuredEffortMap(
  models: readonly Model<Api>[],
  section: CatalogRecord,
  probes: ProbeMap,
): Map<string, MeasuredEffort> {
  const out = new Map<string, MeasuredEffort>();
  for (const model of models) {
    const effort = measuredEffortFor(model, probes);
    if (effort === undefined) continue;
    const raw = section[model.id];
    // The fingerprint guard: an older measurement about a revised declaration is
    // discarded rather than applied.
    if (!isPlainObject(raw)) continue;
    if (effort.fp !== reasoningFingerprint({ ...raw, id: model.id })) continue;
    out.set(model.id, effort);
  }
  return out;
}

/**
 * What the transport layer reports for one probe. Structurally compatible with
 * `zen-provider`'s `ProbeOutcome`; declared here so this module keeps no
 * dependency on the transport and no import cycle is introduced. A prober may
 * also reject, which is treated as "no conclusion" (D5).
 */
export interface ProbeResult {
  readonly kind: ProbeVerdict | "inconclusive";
  readonly reason?: string;
  /**
   * The channel that answered, on an `ok` only. The catalogue stores it and
   * routes the model by it, so a probe that succeeded on the second channel is
   * not followed by a chat that fails on the first.
   */
  readonly api?: Api;
  /** Machine-readable failure code; the panel localizes it rather than guessing. */
  readonly code?: string;
  /**
   * What an `ok` observed about `reasoning_effort:"none"`, since the probe
   * sends it at the payload boundary. Deliberately coarse: the round, not the
   * prober, decides when enough of these agree to persist.
   */
  readonly effort?: { readonly kind: "baseline" | "candidate"; readonly tokens: number };
  /**
   * What a CAPABILITY question concluded, on a reply that carried an answer.
   *
   * Absent means the request taught nothing — no text, a refusal, a spent
   * bucket — and the round writes nothing for it. That is the same distinction
   * the effort axis makes between a sample and an absence, and it is what keeps
   * an upstream outage from being persisted as a missing capability.
   */
  readonly capability?: { readonly axis: CapabilityAxis; readonly ok: boolean; readonly detail: string };
  /**
   * Ceilings the ROUTE stated about itself in the refusal that ended this
   * probe, when it named any. Harvested from every failure, because it is free:
   * the request was being sent anyway, and a refusal returns a number where an
   * acceptance returns nothing.
   */
  readonly ceilings?: { readonly output?: number; readonly context?: number };
  /**
   * Levels this model enumerated in a refusal.
   *
   * Kept even though the round recorded nothing else from that request: the
   * refusal is worthless as a verdict and valuable as a vocabulary, and the two
   * must not be conflated.
   */
  readonly selfReported?: readonly string[];
  /** HTTP status the transport saw; 0 means no response ever arrived. */
  readonly http?: number;
  /**
   * Which anonymous-gate marker the upstream body carried, when it carried
   * one. `code: "anon-gated"` deliberately folds three conditions together
   * because none of them is a verdict about the model — but they need three
   * different fixes, and the body is the only place that fact ever exists.
   * Carried into the round record so the panel can say which.
   */
  readonly marker?: string | null | undefined;
  /**
   * The body said the request SHAPE is not supported for this model
   * ("… not supported for format openai").
   *
   * Distinct from a refusal about the caller, and the round needs the
   * difference to attribute it: a shape the PLUGIN injected is evidence about
   * that spelling, while the same sentence for a channel the plugin GUESSED is
   * evidence about the channel.
   */
  readonly formatScoped?: boolean;
}

/**
 * A stored verdict's KIND is derived from its own samples, every time it is
 * read.
 *
 * For a while the round re-derived that kind from the question spelling
 * ("were we asking about `none`, or about a level?") instead of taking it from
 * the confirmed sample, so a confirmed `noop` could be stored as
 * `level-works`. Live 2026-10-06: `longcat-2.5-preview-free` carried
 * `[1,36,36,36,36]` against a `[36,36,36]` baseline — median 36 against a
 * threshold of 15.48, no reduction at all — and was handed an Off row at
 * `minimal`.
 *
 * The verdict is a pure function of those samples, and the samples sit right
 * beside it, so there is nothing to wait for and no request to spend: recompute.
 * A model whose verdict is stored without samples yields no recomputation and
 * no claim, which is the same place the unsupported check above already sends
 * it.
 */
function correctedEffortKind(entry: Record<string, unknown>): MeasuredEffort | undefined {
  if (!isMeasuredEffort(entry.effort)) return undefined;
  const effort = entry.effort;
  // A refusal is decided by refusals, not by a median; there is nothing to
  // recompute and nothing that could contradict it.
  if (effort.kind === "rejected") return effort;
  const tokens = Array.isArray(entry.effortTokens) ? entry.effortTokens : undefined;
  const baseline = Array.isArray(entry.effortBaselineTokens) ? entry.effortBaselineTokens : undefined;
  const verdict = effortVerdictFrom(tokens, baseline);
  // No samples to judge from: make no claim rather than carry one we cannot check.
  if (verdict === undefined) return undefined;
  if (verdict) {
    // It reduces reasoning. `level-works` and `none-works` are the same finding
    // spoken in the words of the level that was asked.
    return effort.level === undefined ? { ...effort, kind: "none-works" } : { ...effort, kind: "level-works" };
  }
  // It reduces nothing. That is `noop`, whatever spelling was asked.
  return { ...effort, kind: "noop", level: undefined };
}

/**
 * Read persisted verdicts defensively: a damaged entry is dropped, not fatal.
 *
 * Every evidence field the round writes MUST be read here, and the reader is
 * the second half of that contract. Three were missing, which made the write
 * side a fiction: `effortFrozenAt` (the marker that stops a confirmed verdict
 * from being re-litigated) and every `effortQuestion` other than
 * `none`/`minimal` (a fallback LEVEL — `low` on space-bunny-free — was silently
 * dropped, so a restart sent the model back to `none`).
 *
 * `selfReported` is read back for the same reason even though it no longer
 * decides anything: it is the only record of what a model's refusal said it
 * accepts, and that is worth keeping for a cross-check that does not exist yet.
 */
/**
 * Defensive read of a persisted capability verdict.
 *
 * An axis is kept only if it carries all three parts of a measurement. A half
 * written entry is not a weak verdict, it is a claim with no evidence attached —
 * and the panel would render it as measured.
 */
function readCapabilities(value: unknown): Partial<Record<CapabilityAxis, CapabilityVerdict>> | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Partial<Record<CapabilityAxis, CapabilityVerdict>> = {};
  for (const axis of ["vision", "tools"] as const) {
    const entry = value[axis];
    if (!isPlainObject(entry)) continue;
    if (typeof entry.ok !== "boolean") continue;
    if (typeof entry.at !== "number" || !Number.isFinite(entry.at)) continue;
    if (typeof entry.fp !== "string" || entry.fp === "") continue;
    out[axis] = { ok: entry.ok, at: entry.at, fp: entry.fp };
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function readProbes(value: unknown): { probes: ProbeMap; droppedVerdicts: string[] } {
  const droppedVerdicts: string[] = [];
  if (!isPlainObject(value)) return { probes: {}, droppedVerdicts };
  const probes: ProbeMap = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) continue;
    if (entry.verdict !== "ok" && entry.verdict !== "dead") continue;
    if (typeof entry.at !== "number" || !Number.isFinite(entry.at)) continue;
    // Effort samples written by an older instrument are not weak evidence, they
    // are a constant; see EFFORT_READING. Dropped here so the model is measured
    // again rather than judged against numbers that were never read from a
    // response. The verdict itself is kept when there is one: the old instrument
    // could not confirm one, so a record carrying `effort` already says it came
    // from this one.
    const readableEffort = entry.effortReading === EFFORT_READING || isMeasuredEffort(entry.effort);
    // A median-based verdict whose samples are gone is not a verdict any more —
    // it is an assertion nobody can reproduce. 0.3.1 confirmed those verdicts and
    // then cleared `effortTokens`, so every one of them is unsupported (live
    // 2026-10-06: longcat-2.5-preview-free confirmed at a level the recorded
    // measurement says does nothing). Dropping it here re-measures the model on
    // the next round instead of trusting a number whose evidence was deleted by
    // the code that produced it.
    //
    // `rejected` is exempt: it is decided by refusals, not by a median, so it
    // legitimately has no samples.
    const unsupported =
      isMeasuredEffort(entry.effort) &&
      entry.effort.kind !== "rejected" &&
      (!Array.isArray(entry.effortTokens) || entry.effortTokens.length === 0);
    if (unsupported) droppedVerdicts.push(id);
    probes[id] = {
      ...(unsupported ? {} : { effort: correctedEffortKind(entry) }),
      verdict: entry.verdict,
      at: entry.at,
      ...(typeof entry.reason === "string" && entry.reason !== "" ? { reason: entry.reason } : {}),
      ...(entry.swept === true ? { swept: true } : {}),
      ...(typeof entry.nextProbeAt === "number" && Number.isFinite(entry.nextProbeAt)
        ? { nextProbeAt: entry.nextProbeAt }
        : {}),
      ...(isMeasuredChannel(entry.api) ? { api: entry.api } : {}),
      ...(isMeasuredContext(entry.context) ? { context: entry.context } : {}),
      ...(readCapabilities(entry.capabilities) === undefined ? {} : { capabilities: readCapabilities(entry.capabilities) }),
      // A `fp: ""` entry is the recorded fact that the route named nothing when
      // it was asked. It IS read back, so a restart does not re-ask, but it can
      // never become a measurement: an empty fingerprint matches no
      // `contextFingerprint`, so every ceiling check skips it, and the panel
      // projection checks the empty string separately.
      ...(isMeasuredLimits(entry.limits) ? { limits: entry.limits } : {}),
      ...(readBudgetHits(entry.budgetHits) === undefined ? {} : { budgetHits: readBudgetHits(entry.budgetHits) }),
      ...(Array.isArray(entry.firstTokenMs)
        ? { firstTokenMs: entry.firstTokenMs.filter((n) => typeof n === "number" && Number.isFinite(n) && n >= 0).slice(0, 5) }
        : {}),
      ...(Array.isArray(entry.selfReported)
        ? { selfReported: entry.selfReported.filter((level): level is string => typeof level === "string") }
        : {}),
      ...(typeof entry.effortReading === "number" && Number.isFinite(entry.effortReading)
        ? { effortReading: entry.effortReading }
        : {}),
      ...(readableEffort && Array.isArray(entry.effortSamples)
        ? { effortSamples: entry.effortSamples.filter((k) => typeof k === "string") as EffortSamples }
        : {}),
      ...(readableEffort && isEffortQuestion(entry.effortQuestion) ? { effortQuestion: entry.effortQuestion } : {}),
      ...(readableEffort && !unsupported && typeof entry.effortFrozenAt === "number" && Number.isFinite(entry.effortFrozenAt)
        ? { effortFrozenAt: entry.effortFrozenAt }
        : {}),
      ...(readableEffort && typeof entry.effortDiscord === "number" && Number.isFinite(entry.effortDiscord)
        ? { effortDiscord: entry.effortDiscord }
        : {}),
      ...(readableEffort && typeof entry.effortBaseline === "number" && Number.isFinite(entry.effortBaseline)
        ? { effortBaseline: entry.effortBaseline }
        : {}),
      ...(typeof entry.contextHits === "number" && Number.isFinite(entry.contextHits)
        ? { contextHits: entry.contextHits }
        : {}),
      ...(readableEffort && Array.isArray(entry.effortTokens)
        ? { effortTokens: entry.effortTokens.filter((n) => typeof n === "number" && Number.isFinite(n)) }
        : {}),
      ...(readableEffort && Array.isArray(entry.effortBaselineTokens)
        ? { effortBaselineTokens: entry.effortBaselineTokens.filter((n) => typeof n === "number" && Number.isFinite(n)) }
        : {}),
    };
  }
  // The ids whose verdict could not be adopted. Collected HERE because the
  // sanitised map has already lost the evidence that they had one: whoever
  // restores the catalogue must be able to tell "never measured" from "we just
  // decided we do not know", and only this list says which.
  return { probes, droppedVerdicts };
}

/** D5: `$DSH_HOME/dsh-opencode-free/catalog.json` (same convention as dsh-pocket). */
export function cachePath(env: Record<string, string | undefined> = process.env): string {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME !== "" ? env.DSH_HOME : join(homedir(), ".dsh");
  return join(home, "dsh-opencode-free", "catalog.json");
}

/** Any unreadable/foreign cache is simply "no cache" — never an error. */
export async function readCache(path: string): Promise<CatalogCacheRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isPlainObject(parsed)) return null;
    if (parsed.version !== CACHE_VERSION) return null;
    // The `models` guard is what makes the field rename safe: a file still
    // carrying the old `opencode` provider record is rejected outright rather
    // than adopted as a catalogue.
    if (!isPlainObject(parsed.models)) return null;
    const read = readProbes(parsed.probes);
    return {
      version: CACHE_VERSION,
      etag: typeof parsed.etag === "string" ? parsed.etag : undefined,
      fetchedAt: typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : 0,
      models: parsed.models,
      probes: read.probes,
      droppedVerdicts: read.droppedVerdicts,
      lastProbeAt:
        typeof parsed.lastProbeAt === "number" && Number.isFinite(parsed.lastProbeAt)
          ? parsed.lastProbeAt
          : 0,
      lastRound: readLastRound(parsed.lastRound),
    };
  } catch {
    return null;
  }
}

/**
 * The last round's report, read defensively. A damaged or absent field means
 * "no report to show", which is exactly what the panel showed before — the
 * report is a convenience, never a verdict.
 */
function readLastRound(value: unknown): CatalogCacheRecord["lastRound"] {
  if (!isPlainObject(value)) return undefined;
  const total = value.total;
  const done = value.done;
  if (typeof total !== "number" || !isFinite(total) || total <= 0) return undefined;
  if (typeof done !== "number" || !isFinite(done)) return undefined;
  const results: Record<string, ProbeProgressResult> = {};
  if (isPlainObject(value.results)) {
    for (const [id, entry] of Object.entries(value.results)) {
      if (!isPlainObject(entry)) continue;
      if (entry.status === "ok" && typeof entry.ms === "number") {
        results[id] = { status: "ok", ms: entry.ms };
        continue;
      }
      if (entry.status === "failed" && typeof entry.ms === "number") {
        results[id] = {
          status: "failed",
          ms: entry.ms,
          code: typeof entry.code === "string" ? entry.code : "unknown",
          http: typeof entry.http === "number" && isFinite(entry.http) ? entry.http : 0,
          // Both directions, or the report that comes back is not the report
          // that was written. Keeping only the `false` form meant a row that
          // really DID remove a model came back with no flag — and
          // `isFreshRemoval` reads a missing `removed` as a fresh removal, so
          // a restart re-announced a removal for a round that finished hours
          // ago.
          ...(typeof entry.removed === "boolean" ? { removed: entry.removed } : {}),
          ...(typeof entry.marker === "string" && entry.marker !== "" ? { marker: entry.marker } : {}),
        };
      }
    }
  }
  const targets = Array.isArray(value.targets)
    ? value.targets.filter((id): id is string => typeof id === "string")
    : [];
  return { total, done, results, targets };
}

/** Temp file + rename, so a crash mid-write can never leave a torn cache. */
export async function writeCacheAtomic(
  path: string,
  record: {
    etag: string | undefined;
    fetchedAt: number;
    models: CatalogRecord;
    probes?: ProbeMap;
    lastProbeAt?: number;
    lastRound?: CatalogCacheRecord["lastRound"];
  },
): Promise<boolean> {
  // Unpredictable on purpose. `${path}.${process.pid}.tmp` was both the path and
  // the pid: on a shared machine another local user could pre-create that exact
  // name as a symlink and have `writeFile` follow it.
  const temporary = join(dirname(path), `.catalog.${randomUUID()}.tmp`);
  try {
    // 0700/0600 rather than the umask default: the file records which models
    // this user hides and when each was last probed, which is nobody else's
    // business on a multi-user host.
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const payload: Record<string, unknown> = {
      version: CACHE_VERSION,
      etag: record.etag,
      fetchedAt: record.fetchedAt,
      models: record.models,
    };
    // Probe fields are omitted until a round has something to record, so a
    // never-probed cache keeps exactly the file shape it had before probing
    // existed (and a catalogue sync must carry the current verdicts forward
    // rather than silently dropping them).
    if (record.probes !== undefined && Object.keys(record.probes).length > 0) payload.probes = record.probes;
    if (record.lastProbeAt !== undefined && record.lastProbeAt > 0) payload.lastProbeAt = record.lastProbeAt;
    const round = record.lastRound;
    if (round !== undefined && round.total > 0) payload.lastRound = round;
    await writeFile(temporary, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
    return true;
  } catch {
    // A cache we cannot persist is a performance loss, never a failure.
    //
    // But the staged file is OURS: on Windows a rename onto a target that is
    // being written concurrently fails with EPERM/EBUSY, and leaving the staged
    // copy behind means a crash loop accumulates one partial per attempt in the
    // user's own cache directory
    // test rather than by inspection).
    await rm(temporary, { force: true }).catch(() => undefined);
    return false;
  }
}

export interface CatalogSnapshot {
  /** Pre-Zen-gate catalogue (what `refreshModels` intersects and probes). */
  readonly models: Model<Api>[];
  /**
   * Post-gate, post-probe ids: exactly what the picker offers. A model a probe
   * judged `dead` is simply absent — there is no companion list naming it.
   */
  readonly visible: readonly string[];
  /**
   * One capability card per `visible` id, same order: what the detail-page
   * panel renders next to each row. Names and booleans only, never the full
   * records (which carry request-shaping internals the browser has no use for).
   */
  readonly capabilities: readonly ModelCapability[];
  readonly source: CatalogSource;
  readonly updatedAt: number;
  /**
   * When Zen last answered "which ids do you serve", or 0 if never this boot.
   *
   * Separate from {@link updatedAt} on purpose: the two expire on different
   * clocks, and conflating them is how a withdrawn model stays in a picker for
   * a whole catalogue TTL. Not persisted — a boot re-asks.
   */
  readonly gateCheckedAt: number;
  /**
   * Ids Zen serves that look free but the catalogue has no record of. A
   * diagnostic, never a membership input — see {@link unknownFree}.
   */
  readonly unknownFree: readonly string[];
  readonly refreshing: boolean;
  /** When the last probe round ran; 0 means never. */
  readonly probedAt?: number;
  /** The last round reached no conclusion (gated, quota, bad key, network). */
  readonly probeInconclusive?: boolean;
}

/**
 * The axes a round can MEASURE, as opposed to declare.
 *
 * `vision` and `tools` are the two the panel has always shown or implied without
 * ever checking: the vision badge is a declaration copied from models.dev, and
 * "tool calls work" was, until 2026-10-07, an inference from the admission gate.
 * Both are answerable with one request, so both are worth a slot.
 *
 * Context and output are NOT here: they are not questions a cheap request can
 * ask, they are ceilings measured against the request body. They carry their own
 * seed tables ({@link SEED_CONTEXT}, {@link SEED_OUTPUT}) and their own runtime
 * observation (`observeClamp`).
 */
export type CapabilityAxis = "vision" | "tools";

/**
 * What one measurement of an axis concluded.
 *
 * `ok` false is deliberately rare: the round records `false` only when the model
 * ANSWERED and the answer was wrong (it named the wrong colour, or replied in
 * prose instead of calling the tool). A model that could not be reached records
 * nothing at all — the same rule the effort axis follows, and for the same
 * reason: absent is "we do not know", and reading it as "no" would retire a
 * capability on the strength of an upstream outage.
 */
export interface CapabilityVerdict {
  readonly ok: boolean;
  readonly at: number;
  /** Fingerprint of the record this was measured against. */
  readonly fp: string;
}

/**
 * Stable fingerprint of what a capability measurement is ABOUT.
 *
 * A vision verdict is about a model that accepts images, so it is discarded when
 * the declared modalities change; a tool verdict is about nothing the declaration
 * says, but it is kept on the same fingerprint so one rule covers both.
 */
export function capabilityFingerprint(record: CatalogRecord): string {
  const limit = isPlainObject(record.limit) ? record.limit : {};
  const modalities = isPlainObject(record.modalities) ? record.modalities : {};
  const input = Array.isArray(modalities.input) ? modalities.input.join("+") : "-";
  return `${String(limit.context ?? "-")}:${String(limit.output ?? "-")}:${input}`;
}

/**
 * Capabilities this plugin has MEASURED on the live route, by model id.
 *
 * Only `true` is ever seeded. Measured 2026-10-07, one request each, and the
 * requests are the ones the panel's claims had been standing in for:
 *
 *   tools — asked to run `echo capability-probe` with three REAL schemas (the
 *     admission gate's stubs say "Do not call", which would make a compliant
 *     model look incapable). 9 of the live models emitted a correct tool call.
 *   vision — a 64x64 PNG, magenta over lime, asked to name the TOP half. Every
 *     model that declares image input and answered said `magenta`, while the
 *     no-image control said "no image was attached" (mimo) and `blue`
 *     (space-bunny) — the wrong answer, which is what proves the image carried it.
 *
 * `ling-3.0-flash-fin-free` and `fledge-alpha-free` learned nothing (an endpoint
 * that has answered `Endpoint is unavailable.` since 2026-10-06, and an upstream
 * 500), so they are ABSENT rather than seeded false — the same distinction the
 * effort axis makes between "unmeasured" and "measured negative".
 */
const SEED_CAPABILITIES: Readonly<
  Record<string, { readonly vision?: true; readonly tools?: true }>
> = {
  "mimo-v2.6-flash-free": { vision: true, tools: true },
  "space-bunny-free": { vision: true, tools: true },
  "longcat-2.5-preview-free": { vision: true, tools: true },
  "muse-spark-1.2-contributor-free": { vision: true, tools: true },
  "muse-spark-1.3-contributor-free": { vision: true, tools: true },
  "nemotron-3.5-lightning-free": { tools: true },
  "nemotron-3-ultra-free": { tools: true },
  "ling-3.1-flash-free": { tools: true },
  "big-pickle": { tools: true },
};

/**
 * The measured verdict for one axis, from the round first and the seed second.
 *
 * `now` exists for the TTL: a verdict older than {@link CAPABILITY_TTL_MS reads as
 * unmeasured, so the axis is asked again on the next manual round. It is not
 * deleted — a stale entry is still a fact, it is just no longer current, and the
 * difference matters when someone asks "how old is that tick?".
 */
export function measuredCapabilityFor(
  record: CatalogRecord | undefined,
  id: string,
  axis: CapabilityAxis,
  probes: ProbeMap | undefined,
  now?: number,
): CapabilityVerdict | undefined {
  if (record === undefined) return undefined;
  const fp = capabilityFingerprint(record);
  const fresh = (verdict: CapabilityVerdict | undefined): CapabilityVerdict | undefined => {
    if (verdict === undefined) return undefined;
    // A seed carries `at: 0` — it is a property of the shipped table, not of a
    // moment — so the TTL cannot apply to it without expiring a fact that was
    // never dated.
    if (now !== undefined && verdict.at > 0 && now - verdict.at > CAPABILITY_TTL_MS) return undefined;
    return verdict;
  };
  const live = fresh(probes?.[id]?.capabilities?.[axis]);
  if (live !== undefined && live.fp === fp) return live;
  const seeded = SEED_CAPABILITIES[id]?.[axis];
  // A seed carries no timestamp of its own: it is a property of the shipped
  // table, which changes in a commit, not a fact about a moment. `at: 0` is what
  // keeps it out of any "measured N days ago" arithmetic.
  return seeded === true ? { ok: true, at: 0, fp } : undefined;
}

/**
 * The facts the detail-page panel renders per row.
 *
 * `thinking` is the strongest published thinking level (`"Max"`, `"XHigh"`, …)
 * or `null` when the model publishes no level list — the panel shows no thinking
 * badge then, rather than guessing. The raw level id travels here; display
 * capitalization is the panel's business.
 *
 * The two NUMBERS are the point of the change. `contextWindow` and `maxOutput`
 * are read off the same `Model<Api>` pi-ai clamps the request with, so the panel
 * cannot describe a limit the request path does not use — and `declaredContext`
 * /
 * `declaredOutput` travel beside them so a reader can see when the shipped number
 * is not the published one.
 *
 * `measured` says, per axis, whether the number or badge in this row was
 * verified on the route or copied from models.dev. A panel that shows a declared
 * 200,000 next to a measured 1,048,576 with nothing to tell them apart is worse
 * than one that shows only the declaration: both look equally true.
 */
export interface ModelCapability {
  readonly id: string;
  readonly image: boolean;
  readonly thinking: string | null;
  /** What pi-ai will clamp this conversation against. */
  readonly contextWindow: number | undefined;
  /**
   * The `max_tokens` budget pi-ai will put on the wire.
   *
   * Named for what it is. It is the largest budget the route takes, NOT an
   * output length any model has produced — presenting it as "maximum output" is
   * how a 1,040,384 budget came to read as a million-token reply nobody has
   * ever seen (ADR 0004 §43).
   */
  readonly outputBudget: number | undefined;
  /**
   * The largest reply this plugin has watched this model produce, when one has
   * been watched. Absent means never watched — NOT "cannot write", and NOT
   * "writes exactly the budget".
   */
  readonly observedOutput: number | undefined;
  /** What models.dev published, for the two numbers above. */
  readonly declaredContext: number | undefined;
  readonly declaredOutput: number | undefined;
  /** The ladder actually offered, including `off` when it is offered. */
  readonly levels: readonly string[];
  /** The Off spelling that is MEASURED to stop reasoning, else null. */
  readonly off: string | null;
  /**
   * Ceilings the ROUTE has stated about this model, when it has named any.
   *
   * These are the interval's other end. A budget is only meaningful as a range:
   * a reply has been watched at `observedOutput`, and the route says nothing
   * above `statedOutput`. Neither is the ceiling — one is the low bound, the
   * other the high bound — and a row that shows only the budget hides that.
   */
  readonly stated?: { readonly output?: number; readonly context?: number; readonly at: number };
  /**
   * Replies this model has had cut off at the budget, from REAL traffic.
   *
   * The whole output axis rests on a number nobody can verify by asking the
   * model — whether a reply ever wants more than we send. This counts the times
   * one did, for free, on requests that were happening anyway. Zero is the
   * useful reading: it means the budget has not bound, so raising it would have
   * bought nothing, and the honest thing to say is that.
   */
  readonly truncated?: { readonly output?: number; readonly context?: number };
  /** Median first-token latency over real replies, when any were recorded. */
  readonly firstTokenMs?: number;
  /** Per axis: was this verified on the route, or copied from a declaration? */
  /**
   * Where each number on this row COMES FROM — which is not the same question as
   * "is it true".
   *
   * There were four booleans here once, computed as "differs from what models.dev
   * published", and they collapsed four different kinds of evidence into one word:
   * a ceiling the route stated in its own refusal, a ceiling a vendor published on
   * its model page, a reply somebody watched a model finish, and a raise inferred
   * from a clamp signature all rendered as 已实测. That is the ambiguity that
   * produced "一百万输出明显不对" — and it was ours, not the publisher's.
   *
   * `declared` means the panel is showing models.dev's number unaltered, which is
   * a legitimate answer and is now distinguishable from "we changed it".
   */
  readonly evidence: {
    readonly context: Evidence;
    readonly output: Evidence;
    /** `none` when the model makes no such claim (no image input declared). */
    readonly vision: Evidence;
    readonly tools: Evidence;
  };
}

/**
 * One model's provenance for one axis.
 *
 * Ordered by how much the statement can be trusted to still hold, which is also
 * the order the panel prefers when two sources supply the same number.
 */
export type Evidence =
  /** The route said so about itself, in a refusal that named a limit. */
  | "route"
  /** The model vendor published it. */
  | "vendor"
  /** A generation this plugin watched to its end. */
  | "witnessed"
  /** Inferred from a clamp signature — a positive claim about an UNDER-stated value. */
  | "inferred"
  /** models.dev's number, unaltered. */
  | "declared"
  /** There is no claim on screen for this axis. */
  | "none";

const EVIDENCE_TRUST: readonly Evidence[] = ["route", "vendor", "witnessed", "inferred", "declared"];

/** The most-trusted of several sources; `none` only when all of them are. */
function preferredEvidence(values: readonly Evidence[]): Evidence {
  return EVIDENCE_TRUST.find((candidate) => values.includes(candidate)) ?? "none";
}

/** Strongest-first thinking levels; `off` is never a badge. */
const THINKING_LEVEL_RANK = ["max", "xhigh", "high", "medium", "low", "minimal"] as const;

/**
 * The only signal available for a model the catalogue has never heard of.
 *
 * A known model is free because its `cost` is all zero. An unknown one has no
 * `cost` at all, so the id is the only thing left to read — and a "-free" in
 * the name is a weaker claim than a price of zero, not an equal one. It is
 * therefore used for a diagnostic line and for nothing else: never for
 * membership, never for a capability badge. The panel says so in as many words,
 * because a list that looks authoritative and is not is worse than no list.
 */
const FREE_ID_PATTERN = /(?:^|[-_])free(?:$|[-_.])/;

/**
 * The badge level for one derived record: the strongest level whose map value
 * is a real (string) entry. A string-valued map entry IS a published level —
 * `thinkingLevelMapFor` only writes identity entries for published names and
 * `null` for unpublished ones — so this reads the same fact back without
 * re-parsing models.dev. No map, or no string entry, means no badge.
 */
export function topThinkingLevel(model: Model<Api>): string | null {
  const map = model.thinkingLevelMap;
  if (!map || typeof map !== "object") return null;
  for (const level of THINKING_LEVEL_RANK) {
    if (typeof (map as Record<string, unknown>)[level] === "string") return level;
  }
  return null;
}

/**
 * The capability axes a round would ask about for this model right now, in a
 * fixed order.
 *
 * Vision is only asked of a model that DECLARES image input: there is no badge
 * on screen for a model that claims no vision, so there is nothing on screen to
 * hold to an answer. Tools is asked of every model, because the anonymous gate
 * already assumes every request carries them — that assumption is exactly what
 * was never checked.
 *
 * A model with evidence is never asked again. That is what makes this affordable:
 * the cost is one request per axis per model, ONCE, and the seed table means the
 * models already measured on 2026-10-07 cost nothing at all.
 */
export function capabilityQuestionsFor(
  model: Model<Api>,
  record: CatalogRecord | undefined,
  probes: ProbeMap | undefined,
  now?: number,
): CapabilityAxis[] {
  const out: CapabilityAxis[] = [];
  const declaresImage = Array.isArray(model.input) && model.input.includes("image");
  if (declaresImage && measuredCapabilityFor(record, model.id, "vision", probes, now) === undefined) out.push("vision");
  if (measuredCapabilityFor(record, model.id, "tools", probes, now) === undefined) out.push("tools");
  return out;
}

/**
 * Where the advertised OUTPUT number came from.
 *
 * The winner is whichever source supplied the largest figure, because that is the
 * number pi-ai will send — and ties go to the more trustworthy source, so a
 * ceiling the route states beats a vendor page that happens to agree.
 */
export function outputEvidenceFor(
  record: CatalogRecord | undefined,
  id: string,
  shown: number,
  limits?: MeasuredLimits | undefined,
): Evidence {
  if (record === undefined) return "none";
  const declared = finitePositive(isPlainObject(record.limit) ? record.limit.output : undefined);
  if (declared === undefined) return "none";
  const seed = SEED_OUTPUT[id];
  const seedApplies = seed !== undefined && seed.declared === declared;
  const routeStated =
    limits !== undefined && limits.fp === contextFingerprint(record) ? finitePositive(limits.output) : undefined;
  const claims: Evidence[] = ["declared"];
  if (seedApplies && seed?.named !== undefined && seed.named === shown) claims.push("vendor");
  if (seedApplies && seed?.observed !== undefined && seed.observed === shown) claims.push("witnessed");
  if (routeStated !== undefined && routeStated === shown) claims.push("route");
  return preferredEvidence(claims);
}

/**
 * Where the advertised CONTEXT number came from.
 *
 * `inferred` is the clamp-signature raise, which is a positive claim about a value
 * being understated — kept apart from `route` because the route never said it.
 */
export function contextEvidenceFor(
  record: CatalogRecord | undefined,
  shown: number,
  measured?: MeasuredContext | undefined,
): Evidence {
  if (record === undefined) return "none";
  const declared = finitePositive(isPlainObject(record.limit) ? record.limit.context : undefined);
  if (declared === undefined) return "none";
  if (declared === shown) return "declared";
  if (measured === undefined || measured.fp !== contextFingerprint(record)) return "declared";
  return measured.source === "inferred" ? "inferred" : "route";
}

/** The median of a newest-first sample list, or undefined when there is none. */
function firstTokenMedian(samples: readonly number[] | undefined): number | undefined {
  if (samples === undefined || samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Project one effective record to the panel's capability card. */
export function modelCapability(
  model: Model<Api>,
  context?: {
    /** The raw models.dev record, for the declared values and the fingerprints. */
    readonly record?: CatalogRecord | undefined;
    readonly probes?: ProbeMap | undefined;
    /** The window measurement, so the card can say WHERE the number came from. */
    readonly measured?: MeasuredContext | undefined;
    readonly measuredEffort?: MeasuredEffort | undefined;
    readonly limits?: MeasuredLimits | undefined;
    /** Truncation counters from real traffic, when the probe record has them. */
    readonly budgetHits?: ProbeRecord["budgetHits"];
    /** Wall clock, so a verdict older than the TTL reads as unmeasured. */
    readonly now?: number;
    /** Newest-first first-token samples from real replies. */
    readonly firstTokenMs?: readonly number[] | undefined;
  },
): ModelCapability {
  const record = context?.record;
  const limits = context?.limits;
  const limit = isPlainObject(record?.limit) ? record.limit : {};
  const map = model.thinkingLevelMap as Record<string, string | null> | undefined;
  const levels = map !== null && typeof map === "object" ? Object.keys(map).filter((level) => typeof map[level] === "string") : [];
  const vision = measuredCapabilityFor(record, model.id, "vision", context?.probes, context?.now);
  const tools = measuredCapabilityFor(record, model.id, "tools", context?.probes, context?.now);
  // `off` is `null` in the map when it is offered but unproven, so a string is
  // the only reading that says "this spelling is known to stop reasoning".
  const off = map !== null && typeof map === "object" && typeof map.off === "string" ? map.off : null;
  return {
    id: model.id,
    image: Array.isArray(model.input) && model.input.includes("image"),
    thinking: topThinkingLevel(model),
    contextWindow: model.contextWindow,
    outputBudget: model.maxTokens,
    observedOutput: observedOutputFor(record ?? {}, model.id, model.maxTokens),
    declaredContext: finitePositive(limit.context),
    declaredOutput: finitePositive(limit.output),
    levels,
    off,
    // Only when it names something: `fp: ""` is the record of a route that said
    // nothing, and it must not reach the panel as a number.
    ...(limits?.fp === "" || limits === undefined
      ? {}
      : {
          stated: {
            ...(limits.output === undefined ? {} : { output: limits.output }),
            ...(limits.context === undefined ? {} : { context: limits.context }),
            at: limits.at,
          },
        }),
    // Absent unless something was actually cut off: a row that says "0 times"
    // is a claim about traffic the panel has no other evidence of.
    ...(context?.budgetHits === undefined || (context.budgetHits.output ?? 0) + (context.budgetHits.context ?? 0) === 0
      ? {}
      : {
          truncated: {
            ...(context.budgetHits.output === undefined || context.budgetHits.output === 0 ? {} : { output: context.budgetHits.output }),
            ...(context.budgetHits.context === undefined || context.budgetHits.context === 0 ? {} : { context: context.budgetHits.context }),
          },
        }),
    // Median of the last few first-token samples: one cold request should not
    // become a model's reputation, and a stale entry ages out on its own.
    ...(firstTokenMedian(context?.firstTokenMs) === undefined
      ? {}
      : { firstTokenMs: firstTokenMedian(context?.firstTokenMs) }),
    evidence: {
      context: contextEvidenceFor(record, model.contextWindow, context?.measured),
      output: outputEvidenceFor(record, model.id, model.maxTokens, limits),
      // A model that declares no image input makes no such claim, so there is
      // nothing on screen to be right or wrong about — that reads `none`, and it
      // is not a failure. A declared-but-unprobed one reads `declared`, which is
      // the honest word for "models.dev says so and nobody has checked".
      vision: model.input.includes("image") ? (vision !== undefined ? "route" : "declared") : "none",
      tools: tools !== undefined ? "route" : "declared",
    },
  };
}

export interface CreateCatalogOptions {
  /** Identity + fallback field source; an already identity-mapped record. */
  readonly template: Model<Api>;
  /** D8 offline floor: the pi-ai builtin free set, used until a sync lands. */
  readonly builtinBaseline: Model<Api>[];
  readonly knownApis?: ReadonlyMap<string, Api>;
  readonly cachePath: string;
  readonly fetchImpl: FetchLike;
  /**
   * Sends one minimal request per model and classifies the answer. Injected so
   * this module keeps no transport dependency; when absent, probing is simply
   * unavailable and every probe entry point is a no-op.
   */
  readonly probe?: ((model: Model<Api>, question?: EffortQuestion) => Promise<ProbeResult>) | undefined;
  /**
   * The ids Zen currently serves, from one `GET /zen/v1/models` — the same cheap
   * availability check 9router performs for its free provider, and the reason
   * that check is worth doing before anything expensive.
   *
   * A model missing from this list is not available, full stop, and saying so
   * costs one GET instead of one inference request per model. Resolves null when
   * the fetch failed, which must never narrow anything: the round then falls
   * back to probing everything it would otherwise have probed.
   */
  readonly listZenIds?: (() => Promise<readonly string[] | null>) | undefined;
  /**
   * Requests one model may cost inside a MANUAL round.
   *
   * A knob rather than a constant so tests can pin it to one and exercise the
   * round's sampling logic without a budget-sized probe bill per click; the
   * shipped default is {@link MANUAL_SAMPLE_BUDGET}. Nothing in the host sets it.
   */
  readonly manualSampleBudget?: number | undefined;
  /**
   * Is this model switched OFF in the picker? A round asks only about the
   * models the user has on: a probe costs a request from a bucket shared by
   * everything behind this egress, so spending one on a model that is hidden
   * is an answer nobody will read, taken at the expense of the ones that will
   * be. Read live, so a toggle mid-round is honoured on the next round.
   */
  readonly hidden?: ((id: string) => boolean) | undefined;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly userAgent?: string;
}

/**
 * Everything a Catalogue owns, in one place.
 *
 * These were fourteen separate `let` bindings captured by the factory closure,
 * which made the round scheduler reachable only by building a whole Catalogue,
 * driving a round and reading the result. One owner object is what lets the
 * scheduler take (state, deps) instead of capturing a dozen variables.
 *
 * `probeRun` stays a mutable object replaced wholesale at the start of every
 * round: the panel polls a copy while the round mutates the original, and no
 * verdict logic ever reads it.
 */
export interface CatalogState {
  cache: CatalogCacheRecord | null;
  models: Model<Api>[];
  source: CatalogSource;
  updatedAt: number;
  zenIds: ReadonlySet<string> | null;
  inflight: Promise<void> | null;
  gateInflight: Promise<ReadonlySet<string> | null> | null;
  /** Set when the last catalogue fetch was a 304 rather than a body download. */
  lastFetchWasNotModified: boolean;
  /** When Zen last answered the availability question; 0 = never this boot. */
  gateCheckedAt: number;
  probes: ProbeMap;

  lastProbeAt: number;
  probeUntrusted: boolean;
  probeRun: {
    running: boolean;
    /** Requests sent so far this round; the models-vs-requests counterpart of `done`. */
    requests: number;
    total: number;
    done: number;
    current: string | null;
    results: Record<string, ProbeProgressResult>;
    startedAt: number;
    targets: string[];
  };
  probeInflight: Promise<void> | null;
}

/** Everything a Catalogue needs from the outside world. */
export interface CatalogDeps {
  readonly path: string;
  readonly fetchImpl: FetchLike;
  readonly now: () => number;
  readonly userAgent: string | undefined;
  readonly ttlMs: number;
  readonly probe: CreateCatalogOptions["probe"];
  readonly listZenIds: CreateCatalogOptions["listZenIds"];
  readonly hidden: CreateCatalogOptions["hidden"];
  readonly template: Model<Api>;
  readonly knownApis: ReadonlyMap<string, Api> | undefined;
  /** Bounds how long a sync waits for the warm cache read to land. */
  readonly warmReadTimeoutMs: number;
  /** Resolves once the warm cache read has settled. */
  readonly warm: Promise<void>;
}

export function initialState(builtinBaseline: readonly Model<Api>[]): CatalogState {
  return {
    cache: null,
    models: builtinBaseline.slice().sort(byId),
    source: "builtin-fallback",
    updatedAt: 0,
    zenIds: null,
    inflight: null,
    gateInflight: null,
    lastFetchWasNotModified: false,
    gateCheckedAt: 0,
    probes: {},
      lastProbeAt: 0,
    probeUntrusted: false,
    probeRun: {
      running: false,
      requests: 0,
      total: 0,
      done: 0,
      current: null,
      results: {},
      targets: [],
      startedAt: 0,
    },
    probeInflight: null,
  };
}
/**
 * What was MEASURED about a model's context window, and what the plugin may
 * therefore do about it.
 *
 * `raisedTo` is a PROPOSAL the measurement produced, not a substituted value:
 * models.dev's declaration is always the default, and this only ever raises.
 */
export interface MeasuredContext {
  /** The window to advertise in place of the declared one. */
  readonly raisedTo: number;
  /** Fingerprint of `limit`, so a revised declaration voids the measurement. */
  readonly fp: string;
  readonly at: number;
  /**
   * How the number was obtained, which decides how far it may be trusted.
   *
   * `measured` — the endpoint stated this limit about itself, in its own refusal
   * body ("This endpoint's maximum context length is 1048576 tokens") or by
   * accepting a request of that size. First-party, so it is bounded only by the
   * absolute ceiling.
   *
   * `inferred` — derived from the clamp signature, i.e. from observing that a
   * conversation hit the floor. That signal also fires on a HEALTHY model whose
   * context is genuinely full, so it stays behind the `declared x 4` valve.
   * Absent (older records) reads as `inferred`, the conservative side.
   */
  readonly source?: "measured" | "inferred";
}

/** Stable fingerprint of the limits a context measurement is about. */
export function contextFingerprint(record: CatalogRecord): string {
  const limit = isPlainObject(record.limit) ? record.limit : {};
  return `${String(limit.context ?? "-")}:${String(limit.output ?? "-")}`;
}

/**
 * Ceilings the route has stated about one model, and when it last said so.
 *
 * `fp` is the fingerprint of the declaration the statement was made against —
 * the same {@link contextFingerprint} the context axis uses, because both
 * statements are about the same record. A changed declaration discards them
 * rather than keeping a number that was stated about something else.
 */
export interface MeasuredLimits {
  readonly output?: number;
  readonly context?: number;
  readonly fp: string;
  readonly at: number;
}

/** Defensive read of the truncation counters; a count is never inferred. */
function readBudgetHits(value: unknown): ProbeRecord["budgetHits"] | undefined {
  if (!isPlainObject(value)) return undefined;
  const count = (n: unknown): number | undefined =>
    typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
  const output = count(value.output);
  const context = count(value.context);
  if (output === undefined && context === undefined) return undefined;
  return {
    ...(output === undefined ? {} : { output }),
    ...(context === undefined ? {} : { context }),
    ...(typeof value.at === "number" && Number.isFinite(value.at) ? { at: value.at } : {}),
  };
}

/**
 * Defensive read of harvested ceilings; a partial one is no measurement.
 *
 * A DATED silence is kept: "asked at T, the route named nothing" is a real fact
 * about the route, and it is the only thing that stops the next round from
 * paying for the same question again. It can never become a measurement — an
 * empty fingerprint matches no `contextFingerprint`, so every consumer that
 * applies a ceiling skips it — and the projection checks the empty string
 * separately so it never reaches the panel as a number.
 */
export function isMeasuredLimits(value: unknown): value is MeasuredLimits {
  if (!isPlainObject(value)) return false;
  if (typeof value.fp !== "string") return false;
  if (typeof value.at !== "number" || !Number.isFinite(value.at)) return false;
  if (value.fp === "") return value.at > 0;
  const output = value.output;
  const context = value.context;
  const ok = (n: unknown): boolean => n === undefined || (typeof n === "number" && Number.isFinite(n) && n > 0);
  return ok(output) && ok(context) && (output !== undefined || context !== undefined);
}

/**
 * Whether the witnessed generation behind the advertised figure was taken against
 * the declaration models.dev publishes today.
 *
 * False does not mean the number is wrong — it was watched happening. It means
 * the pointer moved since, and nobody has re-watched. The panel says so rather
 * than presenting an unre-checked figure as current.
 */
export function observedOutputIsStale(record: CatalogRecord, id: string): boolean {
  const seed = SEED_OUTPUT[id];
  if (seed === undefined || seed.observed === undefined) return false;
  const declared = finitePositive(isPlainObject(record.limit) ? record.limit.output : undefined);
  return seed.declared !== undefined && seed.declared !== declared;
}

/** Defensive read of a persisted context measurement. */
export function isMeasuredContext(value: unknown): value is MeasuredContext {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.raisedTo === "number" &&
    Number.isFinite(value.raisedTo) &&
    value.raisedTo > 0 &&
    typeof value.fp === "string" &&
    typeof value.at === "number"
  );
}

/** Consecutive clamp observations required before a window may be raised. */
export const CLAMP_HITS_REQUIRED = 2;

/**
 * The bound a raise may reach, as a multiple of what was declared.
 *
 * This is the false-positive safety valve. A wrong raise cannot make the clamp
 * stop firing, which would cost capability; it can only send a request that is
 * too large and have it refused VISIBLY, which the user can act on. That
 * bounded, loud failure is what makes an unknown error rate shippable.
 */
export const CLAMP_RAISE_FACTOR = 4;
export const CLAMP_RAISE_CEILING = 1_048_576;

/**
 * Context windows this plugin has MEASURED, by the model id they were measured
 * on. Not a band, not a heuristic — a value the upstream stated about itself.
 *
 * Measured 2026-10-06 by over-sending one request per model and reading the
 * endpoint's own answer; the verbatim bodies are in
 * `.scratch/probe/context-results-sweep.json` and ADR 0004 §四:
 *
 *   mimo-v2.6-flash-free / mimo-v2.5-free
 *     `[400] This endpoint's maximum context length is 1048576 tokens. However,
 *      you requested about 1048659 tokens (1048516 of text input, 79 of tool
 *      input, 64 in the output).`
 *     (byte-identical on both, so it is the DECLARATION that is stale, not one
 *     model that moved)
 *
 *   nemotron-3.5-lightning-free
 *     the same sentence with 1000000 — while `ling-3.1-flash-free`, declaring the
 *     SAME 262144, really has 262144. Same declaration, different truth, which
 *     is why the decimal-vs-binary heuristic was thrown out and the table is
 *     keyed by id.
 *
 *   big-pickle — **WITHDRAWN 2026-10-07.** This entry existed on an ACCEPTANCE
 *     ("1048576 accepted, 1572864 and 2097152 refused, all generic") and was
 *     read as a lower bound worth shipping. Four hours later the same endpoint,
 *     asked for 2,000,000, said it outright:
 *       `[invalid_request_error] Requested token count exceeds the model's
 *        maximum context length of 262139 tokens.`
 *     and by the next probe it was refusing requests as small as 210,000 while
 *     still answering 200,000 a few minutes earlier. So the acceptance was one
 *     lucky sample from an unstable route, and shipping it advertised a window
 *     up to FOUR TIMES the model's own — which is not a mild overstatement: DSH
 *     would compact at ~839K estimated tokens and every request past the real
 *     ceiling would be refused. An acceptance is not a measurement, on either
 *     axis. The entry is gone, and the declaration ships.
 *
 *     The general rule this earns: **seed a window from a number the endpoint
 *     STATES about itself, or do not seed it.** Refusals name limits for free
 *     (they cost zero output tokens and return a number); acceptances name
 *     nothing, and a route that is quietly failing will happily accept a few
 *     times before it stops.
 *
 * `clampProposalFor` caps every entry, so a stale table can never advertise more
 * than four times what models.dev claims; a raised window that is too large
 * produces a VISIBLE upstream 400, while the un-raised state is silent death
 * (max_tokens collapses to 1, HTTP 200, zero characters — measured, ADR §九).
 * That asymmetry is the whole reason this table exists.
 *
 * Every entry is fingerprinted against `limit`, so a changed declaration
 * discards it rather than keeping a number that was measured about something
 * else — the same rule the live measurements obey.
 */
const SEED_CONTEXT: Readonly<Record<string, { readonly declared: number; readonly measured: number }>> = {
  // Every entry below is a number the endpoint STATED about itself in a refusal.
  // `big-pickle` was here on an acceptance and was withdrawn the same day — see
  // the table's own documentation, which is the shortest post-mortem this repo has.
  "mimo-v2.6-flash-free": { declared: 200000, measured: 1048576 },
  "mimo-v2.5-free": { declared: 200000, measured: 1048576 },
  "nemotron-3.5-lightning-free": { declared: 262144, measured: 1000000 },
};

/** The seed for one model, or undefined when it declares something else now. */
export function seededContextFor(record: CatalogRecord, id: string): MeasuredContext | undefined {
  const seed = SEED_CONTEXT[id];
  if (seed === undefined) return undefined;
  const declared = finitePositive(isPlainObject(record.limit) ? record.limit.context : undefined);
  // A measurement is about the MODEL, and the declaration is only a pointer to
  // which model this id meant. When the pointer moves we cannot tell a typo fix
  // from a different model behind the same id — so the measurement is not thrown
  // away (that is how a models.dev typo fix silently deleted the only witnessed
  // number in the table), it is DEMOTED: first-party becomes inferred, which puts
  // it behind the `declared x 4` valve and the ceiling, and the panel says
  // `inferred` instead of claiming a first-party statement that was never made
  // about this declaration.
  if (declared !== seed.declared) {
    return { raisedTo: seed.measured, fp: contextFingerprint(record), at: 0, source: "inferred" };
  }
  // The endpoint stated this about itself, or accepted a request of this size —
  // see SEED_CONTEXT. It is first-party evidence, so it is not held to the
  // inferred-raise valve.
  return { raisedTo: seed.measured, fp: contextFingerprint(record), at: 0, source: "measured" };
}

/** The window a confirmed clamp would raise a model to. */
export function clampProposalFor(declared: number): number {
  if (!Number.isFinite(declared) || declared <= 0) return 0;
  return Math.min(declared * CLAMP_RAISE_FACTOR, CLAMP_RAISE_CEILING);
}

/**
 * The OUTPUT BUDGET to put on the wire, by the model id it was measured on — the
 * `limit.output` counterpart of {@link SEED_CONTEXT}.
 *
 * Read the name carefully: this is a budget, not an output length. It is the
 * largest `max_tokens` the route would take without refusing, and that is exactly
 * what this field should be, because pi-ai sends it
 * (`options.maxTokens ?? model.maxTokens`, and DSH sends no `maxTokens` of its
 * own for this provider) and the route ENFORCES it. When the declaration is too
 * low the reply is cut at the declaration with `finish_reason: "length"` and
 * nothing anywhere says why — so the budget must not be smaller than the route
 * permits.
 *
 * **It is not evidence that the model can WRITE that much**, and calling it that
 * was a real mistake (ADR 0004 §43). Two measurements keep the two apart:
 *
 *   · the route honours the field — asked for 8 with a prompt that wanted
 *     thousands, `mimo`, `space-bunny-free`, `longcat-2.5-preview-free`,
 *     `nemotron-3-ultra-free` and `big-pickle` all returned exactly 8/64 tokens
 *     with `finish_reason: "length"`. So a refusal at N is evidence and an
 *     acceptance at N is a budget, not a promise.
 *   · what a model actually PRODUCES is {@link observedOutputFor}, and today that
 *     exists for one model only: mimo, 40,000 tokens, `stopReason: "length"`,
 *     about 152 tokens/second.
 *
 * What the 2026-10-07 acceptance sweep DID establish, kept here because it is the
 * reason the declaration can be wrong at all: asked for `max_tokens: 8` with a
 * prompt that wanted thousands, `mimo-v2.6-flash-free`, `space-bunny-free`,
 * `longcat-2.5-preview-free`, `nemotron-3-ultra-free`, `big-pickle` and
 * `nemotron-3.5-lightning-free` all returned exactly the number asked for with
 * `finish_reason: "length"`. The route enforces this field, so a budget that is
 * too low really does cut a reply at the declaration and nothing reports it.
 *
 * What it did NOT establish, and why it is not in the table: that any of those
 * models writes a million tokens. Acceptance is a fact about the request. The
 * sweep's own rows are in `.scratch/verify/output-ceiling2-results.txt`; the
 * argument against shipping them is ADR 0004 §44.

 * Measured 2026-10-07 on the live set, one request per step, reading the number
 * off the outgoing body rather than off the declaration: the prompt is one word,
 * so the ask decides only the CEILING and each step costs ~30 output tokens.
 * Verbatim rows in `.scratch/verify/output-ceiling2-results.txt`:
 *
 * pi-ai clamps what it sends with `min(maxTokens, context − estimate − 4096)`, so
 * the bytes never carry more than this function returns: a conversation with room
 * asks for the whole budget, and a long one automatically asks for less.
 *
 * What this does NOT claim: that any model writes that much. Time is the real
 * ceiling — mimo writes about 152 tokens/second, so the ten-minute request
 * timeout ends a reply near 91,000 tokens whatever the budget says.
 */
/**
 * Evidence for one model's output ceiling, and there are THREE kinds, because
 * three different institutions are entitled to state one and they disagree.
 *
 *   `named`    — a ceiling the VENDOR published, or the ROUTE stated in a
 *                 refusal. Both are first-party statements about the thing
 *                 itself, and both cost nothing to obtain: a refusal returns a
 *                 number for zero output tokens.
 *   `observed` — a generation this plugin watched to its budget, or watched end
 *                 a long reply on its own. Lower bound evidence, and the only
 *                 kind that proves the model actually writes.
 *
 * The BUDGET follows `named` first and `observed` second, and never exceeds
 * either: a budget above a ceiling the route refuses is a guaranteed failure, and
 * a budget below what the model writes truncates it. A model with neither keeps
 * models.dev's declaration (ADR 0004 §48).
 */
const SEED_OUTPUT: Readonly<
  Record<string, { readonly declared: number; readonly named?: number; readonly observed?: number }>
> = {
  // DELIVERY evidence only — a generation this plugin watched to its budget, with
  // `stopReason: "length"`. Both measured 2026-10-07 with the integer prompt
  // ("print the integers from 1 to 100000"), asking for more than the model
  // declares:
  //
  //   mimo-v2.6-flash-free  ask 64000 → produced 64000, length, 346s, 185 tok/s
  //   big-pickle            ask 48000 → produced 48000, length, 132s, 365 tok/s
  //
  // Three measurement traps cost more requests than these two observations did,
  // and all three are reasons a naive version of this table would be wrong:
  //
  //   1. A MODEL CHOOSES WHEN TO STOP. The same model, the same ask, one sample
  //      produced 892 tokens with `stop` and the next produced 64,000 with
  //      `length`. A single short reply is evidence about that sample, not about
  //      the ceiling — so every entry here is a WITNESSED generation, and the
  //      protocol retries rather than trusting one.
  //   2. THE ADMISSION GATE PUTS TOOLS ON EVERY REQUEST, and a model that calls
  //      one ends its generation: `longcat-2.5-preview-free` produced 121 tokens
  //      with `stopReason: "toolUse"` on a 64,000 budget, which reads exactly
  //      like a route that caps output. The measurement says so in a system
  //      message instead.
  //   3. RATE IS THE CEILING NOBODY SEES. 34 tok/s (nemotron-3.5) to 365
  //      (big-pickle): inside the ten-minute request timeout that is roughly
  //      28,000 to 295,000 tokens, so for several models the DECLARED budget
  //      (128,000 / 262,144 / 524,288) is not the constraint — the clock is.
  //
  // The 2026-10-07 acceptance sweep (every route taking `max_tokens` from 8 up to
  // 1,040,384) is deliberately NOT here. It proved the route enforces the field —
  // which is why a declaration that is too low really does cut a reply — but an
  // accepted budget is not a thing any model was seen to write, and shipping it
  // as one is the mistake this table was corrected for (ADR 0004 §44).
  //
  // No other model has an entry because none has been watched past its
  // declaration. Several stopped on their own well below it, which is a fact
  // about those samples and not a ceiling.
  "mimo-v2.6-flash-free": {
    declared: 32000,
    // Xiaomi's own model page, fetched 2026-10-07:
    //   https://mimo.mi.com/models/en-US/mimo-v2.6-flash
    //   "Context Window 1M tokens" / "Max Output 128K tokens"
    // 128K = 131072. It is a vendor statement, so it outranks anything measured
    // here — and it independently confirms the CONTEXT seed (1M = 1048576) that
    // came from the endpoint's own refusal.
    named: 131072,
    // What the route accepts: asked for 1,048,577, 2,000,000 and 8,000,000 and
    // got three 200s. There is no output cap on this route at all, so the vendor
    // number — not the acceptance — is what bounds the budget.
    //
    // 79,722 and not 64,000: both were watched, and the larger one is the one
    // that answers "how long a reply has this model actually written". Asked for
    // 131,072 it wrote 79,722 and stopped BY ITSELF (762s), so nothing truncated
    // it; the 64,000 sample ended on the budget instead. The budget is unchanged
    // (131,072 comes from the vendor either way) — this only corrects the figure
    // the panel reports, which is a lower bound and should be the strongest one
    // we have rather than a rounder one.
    observed: 79722,
  },
  "big-pickle": { declared: 32000, observed: 48000 },
  "longcat-2.5-preview-free": {
    declared: 131072,
    // Watched 2026-10-07: asked for 64000, produced 64000 with `stopReason:
    // "length"` in 947s (~67 tok/s). So the route names 262144 AND the model
    // demonstrably writes 64000 — the budget does not move (the named ceiling is
    // higher), but the panel can stop implying this model has never been watched
    // writing a long reply.
    observed: 64000,
    // The route, in its own words, 2026-10-07:
    //   "[invalid_parameter] 参数校验失败: /max_tokens: 995834 is not less or
    //    equal to 262144"
    // So 262144 is enforced by the upstream, and models.dev publishes half of
    // it. Sending more is refused; sending 131072 truncates a reply that wants
    // more. No production has been witnessed past 32770 — the model stops when it
    // has said what it came to say — which is why there is no `observed` here
    // even though the budget still moves.
    named: 262144,
  },
};

/**
 * The largest reply this plugin has actually SEEN this model produce.
 *
 * This is the number that answers "how much can this model write", and it is not
 * the number above. Measured 2026-10-07: `mimo-v2.6-flash-free`, asked for
 * 40,000 output tokens, produced 40,000 with `stopReason: "length"` at about 152
 * tokens/second. Every other model in the table has NO entry, because no
 * generation has been watched for them — which is the whole reason the budget
 * and the observation are kept apart. Absent means "never watched", not "cannot".
 */
export function observedOutputFor(
  record: CatalogRecord,
  id: string,
  budget: number | undefined,
): number | undefined {
  const declared = finitePositive(isPlainObject(record.limit) ? record.limit.output : undefined);
  const seed = SEED_OUTPUT[id];
  // A witness SURVIVES a moved declaration, deliberately: it was watched
  // happening, and the cost of forgetting it is a models.dev typo fix erasing the
  // only production anyone has ever watched. What the move does cost is
  // PROVENANCE, which is what {@link observedOutputIsStale} reports — the number
  // stays, and the panel says it has not been re-checked against this
  // declaration.
  if (seed === undefined || seed.observed === undefined) return undefined;
  // Bounded by the budget we would send, and NOTHING else.
  //
  // There used to be a guard here that dropped an observation BELOW the
  // declaration, on the reasoning that a smaller number would be "a demotion
  // dressed as a measurement". It hid the truth on the one model with the most
  // evidence: `longcat-2.5-preview-free` was watched writing 64,000 against a
  // declared 131,072, and the panel showed nothing at all — as though nobody had
  // ever watched it write. And it could not have protected anything: the budget
  // is `max(declaration, named, observed)`, so an observation below the
  // declaration cannot lower it. The guard blocked facts, not risk.
  if (budget !== undefined && seed.observed > budget) return budget;
  return seed.observed;
}

/**
 * The `max_tokens` budget to send: models.dev's declaration, raised only where a
 * generation has been WATCHED reaching past it.
 *
 * The rule, in one line: **only delivery evidence moves this field.** An accepted
 * budget does not, a refusal does not, and "the route would probably take more"
 * does not — because none of those is a thing the model was seen to write, and a
 * number this plugin cannot point at an observation for is a number it is making
 * up. One model has such an observation today, and one model is therefore the one
 * whose budget differs from its declaration.
 *
 * `window` is the window this plugin advertises for the same model, passed in
 * rather than read so the two numbers cannot disagree — a budget above the
 * context it has to fit in is unreachable by construction.
 */
export function maxTokensFor(
  record: CatalogRecord,
  id: string,
  window: number | undefined,
  limits?: MeasuredLimits | undefined,
): number | undefined {
  const declared = finitePositive(isPlainObject(record.limit) ? record.limit.output : undefined);
  if (declared === undefined) return declared;
  // A number the ROUTE stated about itself outranks every seed: it is
  // first-party, current, and it cost nothing. It is also the only one that can
  // exist for a model the plugin has never seen before.
  const stated =
    limits !== undefined && limits.fp === contextFingerprint(record) ? finitePositive(limits.output) : undefined;
  const seed = SEED_OUTPUT[id];
  const seeded = seed !== undefined && seed.declared === declared ? seed : undefined;
  const ceiling = Math.max(stated ?? 0, seeded?.named ?? 0, seeded?.observed ?? 0);
  if (ceiling === 0) return declared;
  const bounded = window === undefined ? ceiling : Math.min(ceiling, window);
  return bounded > declared ? bounded : declared;
}

/**
 * The advertised context window.
 *
 * C1: models.dev's value is the value. It is never substituted from a band, and
 * decimal-vs-binary formatting was measured to carry no predictive power —
 * ling-3.1-flash-free declares 262144 and is exactly right, while
 * nemotron-3.5-lightning-free declares the same 262144 and really has 1000000.
 *
 * C4: a measured, fingerprinted raise may lift it, and only upward.
 */
export function contextWindowFor(record: CatalogRecord, measured?: MeasuredContext): number | undefined {
  const limit = isPlainObject(record.limit) ? record.limit : {};
  const declared = finitePositive(limit.context);
  if (measured === undefined || declared === undefined) return declared;
  if (measured.fp !== contextFingerprint(record)) return declared;
  // The two evidence strengths get two different ceilings. The x4 valve exists
  // to stop an INFERRED raise from retiring capability on a healthy model; it has
  // no business clipping a number the endpoint stated about itself. Measured
  // 2026-10-07: the endpoint's own sentence says 1048576 for
  // `mimo-v2.6-flash-free`, and the plugin was advertising 800000 — 248K of
  // real context withheld by a valve built for a different kind of evidence.
  const cap =
    measured.source === "measured"
      ? CLAMP_RAISE_CEILING
      : Math.min(declared * CLAMP_RAISE_FACTOR, CLAMP_RAISE_CEILING);
  const bounded = Math.min(measured.raisedTo, cap);
  return bounded > declared ? bounded : declared;
}

/**
 * What one request observed about the clamp.
 *
 * `floorHit` is read straight off the outgoing body — the number pi-ai emitted
 * AFTER `clampMaxTokensToContext` ran — so it is a fact about the request, not an
 * inference about why it was small.
 */
export interface ClampObservation {
  /** The emitted `max_tokens` / `max_completion_tokens`, if the body carried one. */
  readonly emitted: number | undefined;
  /** `stopReason === "length"` with no usable content. */
  readonly starved: boolean;
  /**
   * `stopReason === "length"` WITH usable content: a reply that was cut off
   * mid-answer.
   *
   * This is the only free measurement of whether the budget the plugin advertises
   * is actually BINDING in real use — every synthetic probe either stops early
   * or costs tens of thousands of tokens to find out, while this rides on a
   * request that was being made anyway. Whether the budget or the CONTEXT clamp
   * did the cutting is decided by comparing `emitted` with the model's own.
   */
  readonly truncated?: boolean;
}

/**
 * Whether one observation is the clamp signature, and whether it is enough.
 *
 * The signature is arithmetic, not an error-body inference: `clampMaxTokensToContext`
 * is `min(maxTokens, max(1, contextWindow - estimate - 4096))`, so an emitted
 * value of exactly 1 means the conversation passed the declared window minus
 * 4096. That is one-directional — an OVERSTATED window cannot make the clamp
 * fire at all — so a hit is positive evidence of an understated window and
 * nothing else.
 *
 * `starved` is the second conjunct because `max_tokens: 1` was measured to
 * return HTTP 200 with zero characters and no error anywhere: without it the
 * signature would also match a request that simply ran out of room honestly.
 *
 * Repeated agreement is required because a single observation cannot
 * distinguish an understated window from a genuinely full conversation, and
 * because a probe here has been seen returning 200 while proving nothing.
 */
export function clampVerdict(
  previous: ProbeRecord | undefined,
  observation: ClampObservation,
  declared: number,
): { kind: "none" } | { kind: "hit"; hits: number } | { kind: "confirmed"; raisedTo: number } {
  if (!observation.starved || observation.emitted !== 1) return { kind: "none" };
  const hits = (previous?.contextHits ?? 0) + 1;
  if (hits < CLAMP_HITS_REQUIRED) return { kind: "hit", hits };
  // Only ever upward, and never past the cap. A model whose context really was
  // full keeps a correct window: raising it there would only send a request
  // that is too large and get it refused visibly.
  const proposal = clampProposalFor(declared);
  return proposal > declared ? { kind: "confirmed", raisedTo: proposal } : { kind: "hit", hits: 0 };
}

export interface Catalog {
  current(): CatalogSnapshot;
  /** Post-Zen-gate models — the single list the picker and the panel share. */
  effectiveModels(): Model<Api>[];
  /** Fire-and-forget revalidation; shared by concurrent callers. */
  ensureFresh(): Promise<void>;
  /** Ignores the TTL and waits for the sync to settle. */
  forceRefresh(): Promise<void>;
  /** One ordered probe round; at most one per local day (D2). */
  runProbes(): Promise<void>;
  /** Ignores the daily gate; used by the panel button (D8). */
  forceProbes(): Promise<ProbeStart>;
  /**
   * Requests one model may cost inside a MANUAL round.
   *
   * A knob rather than a constant so tests can pin it to one and exercise the
   * round's sampling logic without spending a budget per click; the shipped
   * default is {@link MANUAL_SAMPLE_BUDGET}. Nothing in the host sets it.
   */
  readonly manualSampleBudget?: number | undefined;
  /** `null` means Zen failed: keep the current gate rather than narrowing. */
  applyZenGate(ids: readonly string[] | null): void;
  /**
   * The live progress of the current (or last) probe round, for the panel's
   * progress pill and per-row badges. In-memory only — it is a transient fuel
   * gauge, not a verdict, so it is never persisted and never narrows anything.
   */
  probeProgress(): ProbeProgress;
  /**
   * Report what one real request observed about the clamp.
   *
   * The seam exists because the observation can only be made where the bytes
   * are: the transport reads the emitted `max_tokens` and the terminal
   * `stopReason`, and neither is visible to the catalogue. Fire-and-forget by
   * design — a request must never wait on bookkeeping — and it can only ever
   * RAISE a window, so a spurious observation costs a visible upstream refusal
   * rather than capability.
   */
  observeClamp(id: string, observation: ClampObservation): void;
  /**
   * Record how long this model's real replies took to produce their first token.
   *
   * Separate from {@link observeClamp} because it is a measurement, not a
   * verdict: nothing branches on it, and the newest sample is kept alongside the
   * last few so the panel can show a median instead of one unlucky request.
   */
  observeFirstToken(id: string, ms: number): void;
}

/**
 * What the panel polls while a round is running — and reads again after it
 * ends, so the last round's outcome is still on screen instead of vanishing.
 * `results` holds one entry per FINISHED model; the in-flight one is `current`;
 * everything else is waiting. `ms` is the wall time that model's probe took,
 * for the "✓ 142ms" badge.
 *
 * A failure carries `code` (a {@link ProbeFailureCode} the card localizes) and
 * `http` (0 when no status ever arrived). A red badge that only says "failed"
 * is the thing this type exists to prevent.
 */
/**
 * What a manual round actually did.
 *
 * The floor between two manual rounds is a quota decision, but it used to be an
 * invisible one: `forceProbes()` returned nothing and the route answered 202
 * either way, so a refused click looked exactly like a started one and the panel
 * waited out its grace period in silence. The caller needs the difference, and
 * the user needs the number.
 */
export type ProbeStart =
  | { readonly started: true }
  | { readonly started: false; readonly reason: "cooldown"; readonly retryAfterMs: number }
  | { readonly started: false; readonly reason: "running" | "unavailable" };

/**
 * What a round is allowed to ask about.
 *
 * `visible` — the models the user has switched on. A manual round spends up to
 * `MANUAL_SAMPLE_BUDGET` requests on each of them, and the answers are the ones
 * somebody is watching for.
 *
 * `served` — every model the Zen gate still lists, hidden ones included. The
 * daily round spends ONE request each and nobody asked for it; its value is
 * catalogue hygiene, which a hidden model needs just as much as a visible one.
 */
export type ProbeScope = "visible" | "served";

export interface ProbeProgress {
  readonly running: boolean;
  /**
   * Requests this round actually sent.
   *
   * Not the same as `done`: a round may take several samples of one model, so
   * the tally counts models and this counts what the shared anonymous bucket
   * paid. Someone who presses "Probe now" is spending that bucket and is
   * entitled to the number.
   */
  readonly requests: number;
  readonly total: number;
  readonly done: number;
  readonly current: string | null;
  readonly results: Readonly<Record<string, ProbeProgressResult>>;
  /**
   * The ids this round accounts for — its whole scope, asked or not-yet-asked.
   *
   * A round now only asks about the models the user has switched ON, so "no
   * result yet" means two different things: queued, or not in this round at
   * all. The panel cannot tell them apart from `results` alone, and calling a
   * skipped model "waiting" is a claim about a round that will never reach it.
   */
  readonly targets: readonly string[];
  /** When the current (or last) round started; 0 means no round has ever run. */
  readonly startedAt: number;
  /**
   * Models whose reasoning measurement is still open.
   *
   * "Still measuring" is a claim about the future, so it is computed by the same
   * predicate the loop uses rather than inferred from a missing verdict: absence
   * also means the axis is undecidable, and that model is not one the panel
   * should keep asking the user to click for.
   */
  readonly pending: readonly string[];
}

/** One model's outcome in a round: answered (with latency) or not (with why). */
export type ProbeProgressResult =
  | { readonly status: "ok"; readonly ms: number }
  | {
      readonly status: "failed";
      readonly ms: number;
      readonly code: string;
      readonly http: number;
      /**
       * Present only on a `dead` verdict: did THIS round take the model out of
       * the list, or did it only re-confirm a death that had already removed
       * it? A re-confirmation is a real answer and worth showing, but calling it
       * a removal reports a change the round did not make. Omitted by older
       * backends, which the card reads as "removed" — its own behaviour.
       */
      readonly removed?: boolean | undefined;
      /** Which anonymous-gate marker the refusal carried, when it named one. */
      readonly marker?: string | undefined;
      /** The body said the request SHAPE is not supported for this model. */
      readonly formatScoped?: boolean;
    };

/**
 * D2: at most one round per LOCAL calendar day — the plan's rule, compared
 * against the previous round's local day via the injected `now` so a test can
 * place both ends exactly.
 *
 * Calendar day, not a rolling 24h window: the bound is on how much of the
 * shared anonymous bucket one day's sweep may spend, and "same day" is what a
 * user reading the panel would expect. The known edge is a round at 23:50
 * followed by one at 00:10 — different days, so both run. That is deliberate,
 * not an oversight; `forceProbes` bypasses this gate entirely, so a manual
 * click is never blocked either way.
 */
export function probedToday(lastProbeAt: number, now: () => number): boolean {
  if (lastProbeAt <= 0) return false;
  const previous = new Date(lastProbeAt);
  const today = new Date(now());
  return (
    previous.getFullYear() === today.getFullYear() &&
    previous.getMonth() === today.getMonth() &&
    previous.getDate() === today.getDate()
  );
}

/**
 * The one list the picker and the panel share: the catalogue, narrowed by
 * Zen's gate, minus everything a probe judged dead. A dead model is dropped
 * from here and named nowhere — the user asked for it to simply not be in the
 * list, so there is deliberately no companion "unavailable" list to restore
 * or to go stale.
 *
 * `models` itself still carries dead entries, and that is load-bearing rather
 * than untidy: `adopt` prunes verdicts for models the catalogue no longer
 * has, so a dead model physically removed from `models` would lose its
 * verdict on the next sync, come back as a fresh candidate, and be re-probed
 * to the same answer. Keeping the record is what makes the verdict final.
 */
export function effectiveList(
  models: readonly Model<Api>[],
  zenIds: ReadonlySet<string> | null,
  probes: ProbeMap,
): Model<Api>[] {
  const gated = zenIds === null ? [...models] : models.filter((model) => zenIds.has(model.id));
  // Order comes from where the catalogue is born (derive / the offline
  // floor); this only filters, so it cannot drift from it.
  return gated.filter((model) => probes[model.id]?.verdict !== "dead");
}

function effectiveVisible(list: readonly Model<Api>[]): string[] {
  return list.map((model) => model.id);
}

/**
 * Models Zen serves, that the catalogue has never heard of, and whose id
 * claims to be on the free tier.
 *
 * This is the one blind spot the two-source design cannot see past: membership
 * comes from models.dev, so an id Zen has started serving before models.dev
 * publishes it is invisible here — not "judged dead", not "gated out", simply
 * never a candidate. On 2026-09-30 that was one live model
 * (`jev-1.13-free`), while 24 ids models.dev still called free were correctly
 * gated out, so the gate is demonstrably working and this is not a symptom of
 * a broken intersection.
 *
 * It is reported rather than fixed, deliberately. Making these models usable
 * needs an `api` channel and a `limit.context`/`limit.output`, and NEITHER is
 * obtainable from any source available here: Zen's listing carries only
 * `id`/`object`/`created`/`owned_by`, and matching a "-free"-suffixed id
 * against other providers' records is a guess. A wrong number is worse than a
 * conservative one, because a claimed context length is acted on. So the
 * honest move is to say the model exists and that we will not guess for it.
 */
export function unknownFree(models: readonly Model<Api>[], zenIds: ReadonlySet<string> | null): string[] {
  if (zenIds === null) return [];
  const known = new Set(models.map((model) => model.id));
  const out: string[] = [];
  for (const id of zenIds) {
    if (known.has(id) || !FREE_ID_PATTERN.test(id)) continue;
    out.push(id);
  }
  // Same order as everything else the panel shows, and the same comparison
  // that produces it: a locale-sensitive sort would make this list differ
  // from the catalogue's own on a machine with a different ICU default.
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Which freshness window applies: a caller-pinned `ttlMs` is honoured verbatim
 * (tests pin it), so only the default path shortens, and only after a 304 has
 * proved the upstream honours the conditional header.
 */
export function effectiveTtl(
  pinnedTtl: number | undefined,
  fallbackTtl: number,
  lastFetchWasNotModified: boolean,
): number {
  return pinnedTtl ?? (lastFetchWasNotModified ? CATALOG_TTL_ACTIVE_MS : fallbackTtl);
}

export function catalogueIsStale(updatedAt: number, now: () => number, ttl: number): boolean {
  return now() - updatedAt > ttl;
}

/**
 * "Never asked this boot" is stale by definition, not by arithmetic. Testing
 * it as an inequality would let a small or injected clock read 0 as fresh,
 * which is exactly the case where a real question is still outstanding.
 */
export function gateIsStale(gateCheckedAt: number, now: () => number): boolean {
  return gateCheckedAt === 0 || now() - gateCheckedAt > GATE_TTL_MS;
}

/**
 * How one probe outcome becomes the row the panel paints.
 *
 * This used to live inline in the round loop, where the interesting rule was
 * invisible between the transport plumbing: the card cannot say "failed" without
 * a `code`, and it must not call a re-confirmed death a removal. Both are
 * load-bearing — a row with no reason is the bug this field exists to prevent,
 * and reporting an old verdict as a fresh removal dates a change to this round
 * that happened in an earlier one.
 *
 * `priorVerdict` is read BEFORE the round writes the new one, which is the only
 * reason the `removed` flag can be answered at all.
 */
export function probeRowFor(
  outcome:
    | {
        readonly kind?: string;
        readonly code?: string;
        readonly http?: number;
        readonly marker?: string | null;
      }
    | null
    | undefined,
  elapsed: number,
  priorVerdict: string | undefined,
): ProbeProgressResult {
  if (outcome !== undefined && outcome !== null && outcome.kind === "ok") {
    return { status: "ok", ms: elapsed };
  }
  // A prober that predates the coded outcome still gets a reason: the verdict
  // itself is the coarse fallback, never a silent failure.
  const code =
    typeof outcome?.code === "string" && outcome.code !== ""
      ? outcome.code
      : outcome?.kind === "dead"
        ? "dead"
        : "unknown";
  return {
    status: "failed",
    ms: elapsed,
    code,
    http: typeof outcome?.http === "number" && isFinite(outcome.http) ? outcome.http : 0,
    ...(code === "dead" ? { removed: priorVerdict !== "dead" } : {}),
    // Which gate marker the body carried, so the refusal names itself instead of
    // arriving as one anonymous "未测到".
    ...(typeof outcome?.marker === "string" && outcome.marker !== "" ? { marker: outcome.marker } : {}),
  };
}

/**
 * A dead verdict is final ONLY once it has been earned by asking every channel.
 * A verdict without that marker predates the sweep, so it gets one re-check:
 * those are precisely the verdicts that may have been a wrong channel refused
 * rather than a model that is gone — and a permanent verdict on a wrong channel
 * is how a working model goes missing for good.
 */
/**
 * A death is final, and `nextProbeAt` is the field that says when it stops being
 * final.
 *
 * The field was documented and never read, so a model that was wrongly retired —
 * swept on a channel the route happened to be serving wrong, while an upstream
 * outage was in progress — stayed suppressed for ever with no path back. A dead
 * verdict that is older than the interval is asked once more, which costs one
 * request for the models nobody is using and is the only way a name Zen has
 * re-published can come back at all.
 */
export const DEAD_RECHECK_MS = 7 * 24 * 60 * 60_000;

/**
 * How long "asked, and the route named nothing" is worth keeping.
 *
 * A round used to ask every model for its ceiling and then DROP the silence on
 * the next warm start, so every restart of DSH spent a request per model
 * re-asking a question whose answer has been silence 10 times out of 11 — on a
 * shared anonymous bucket, where the route's silence does not change because the
 * process restarted. A day is long enough to catch an upstream that starts
 * declaring a ceiling, and short enough that the daily round still means daily.
 */
export const CEILING_SILENCE_TTL_MS = 24 * 60 * 60_000;

function isSettled(id: string, probes: ProbeMap, now: number): boolean {
  const record = probes[id];
  if (record === undefined || record.verdict !== "dead") return false;
  if (record.swept !== true) return false;
  const due = record.nextProbeAt;
  return typeof due === "number" && due > now ? true : typeof due !== "number" || now - record.at < DEAD_RECHECK_MS;
}

/**
 * What one round will ask, split into the two buckets the panel needs to tell
 * "queued" from "skipped".
 *
 * `targets` are the models the user has switched ON that no earned verdict has
 * settled — a probe costs a request from a bucket shared by everything behind
 * this egress, so asking about a hidden model is an answer nobody will read.
 *
 * `notListed` are models Zen has dropped: out of the picker without ever being
 * asked, zero requests spent. They still count toward the round's total,
 * because the panel's tally has to add up and a silent hole in the list is
 * exactly what a reader cannot explain.
 */
/**
 * A model's row for THIS round.
 *
 * A round may take several samples of one model, so the shot count and the row
 * count stopped being the same thing: `done` was incremented per SAMPLE (the
 * panel read "53/27"), and each shot overwrote the row, so a model that
 * produced three good baseline samples and then hit a 429 was painted red — the
 * round's actual finding about it discarded by its last request.
 *
 * So: the tally counts MODELS (a row per model, which is what `total` counts),
 * and the row reports the round's finding about that model — ok if any sample
 * answered, because that is what the round learned. `dead` and a removal stay
 * loud; only a later failure stops being able to bury an earlier answer.
 */
function roundRowSoFar(last: ProbeProgressResult, okShots: number, elapsed: number): ProbeProgressResult {
  if (okShots === 0 || last.status === "ok") return { ...last, ms: elapsed };
  return { status: "ok", ms: elapsed };
}

export function planRound(
  models: readonly Model<Api>[],
  live: readonly Model<Api>[],
  servedSet: ReadonlySet<string> | null,
  probes: ProbeMap,
  hidden: ((id: string) => boolean) | undefined,
  now: number,
  scope: ProbeScope = "visible",
): { targets: Model<Api>[]; notListed: Model<Api>[] } {
  // `served` — the daily round — asks about every model Zen still lists, hidden
  // or not: its job is to keep the catalogue honest, and a hidden model whose
  // free tier has ended is exactly the thing nobody will discover by looking at
  // the picker. `visible` — the manual round — stays on what the user has
  // switched on, because that round spends a budget per model and the answers
  // are ones they are actually watching for.
  const isShown = (id: string): boolean => scope === "served" || hidden?.(id) !== true;
  return {
    targets: live.filter(
      (model) => isShown(model.id) && !isSettled(model.id, probes, now),
    ),
    notListed:
      servedSet === null
        ? []
        : models.filter((model) => !servedSet.has(model.id) && probes[model.id]?.verdict !== "dead"),
  };
}

/**
 * The one derivation of the catalogue: models.dev's dictionary plus whatever
 * this process has measured.
 *
 * Two callers, and they must not drift: the warm start, and the end of a probe
 * round — a verdict the round just wrote changes what the user is offered, so
 * the list has to be rebuilt from it rather than waiting for the next sync or a
 * restart. Everything a measurement can add (the Off row, a harvested
 * vocabulary) is applied HERE, which is why neither caller may do it itself.
 */
function deriveWithEvidence(state: CatalogState, deps: CatalogDeps, section: CatalogRecord): DerivedCatalog {
  const base = derive(section, { knownApis: deps.knownApis, template: deps.template });
  const evidence = measuredEffortMap(base.candidates, section, state.probes);
  // A live measurement outranks the recorded one: it is newer and it was taken
  // against this very record. The seed fills in only what nobody has measured.
  const windows = measuredContextFor(base.candidates, section, state.probes);
  const limits = measuredLimitsFor(base.candidates, section, state.probes);
  return evidence.size === 0 && windows.size === 0 && limits.size === 0
    ? base
    : derive(section, {
        knownApis: deps.knownApis,
        template: deps.template,
        measuredEffort: evidence,
        measuredContext: windows,
        measuredLimits: limits,
      });
}

/**
 * Measured windows for the candidates: the live measurement where there is one,
 * the recorded one otherwise.
 *
 * Mirrors {@link measuredEffortMap} so both axes read the same way — a live
 * verdict outranks a recorded one, and both are checked against the record they
 * are about before they are applied.
 */
export function measuredContextFor(
  models: readonly Model<Api>[],
  section: CatalogRecord,
  probes: ProbeMap,
): Map<string, MeasuredContext> {
  const out = new Map<string, MeasuredContext>();
  for (const model of models) {
    const raw = section[model.id];
    if (!isPlainObject(raw)) continue;
    const record = { ...raw, id: model.id } as CatalogRecord;
    const live = probes[model.id]?.context;
    out.set(model.id, live !== undefined && live.fp === contextFingerprint(record) ? live : (seededContextFor(record, model.id) ?? { raisedTo: 0, fp: "", at: 0 }));
  }
  for (const [id, entry] of out) if (entry.raisedTo === 0) out.delete(id);
  return out;
}

/**
 * Ceilings the route has stated about each candidate, fingerprinted against the
 * record they were stated about.
 *
 * A statement whose fingerprint no longer matches is dropped rather than applied:
 * it was about a declaration this model no longer has, and the ceiling it named
 * belonged to that one.
 */
export function measuredLimitsFor(
  models: readonly Model<Api>[],
  section: CatalogRecord,
  probes: ProbeMap,
): Map<string, MeasuredLimits> {
  const out = new Map<string, MeasuredLimits>();
  for (const model of models) {
    const raw = section[model.id];
    if (!isPlainObject(raw)) continue;
    const limits = probes[model.id]?.limits;
    if (!isMeasuredLimits(limits)) continue;
    if (limits.fp !== contextFingerprint({ ...raw, id: model.id })) continue;
    out.set(model.id, limits);
  }
  return out;
}

// Warm start: a valid state.cache restores the catalogue without any network.
/**
 * Restore a cached record into the running state.
 *
 * `restoreRound` is for STARTUP, and it is the only thing that puts a previous
 * round's finished report back on screen. It must never do that to a round that
 * is in flight: replacing a live `probeRun` (running, requests counting, done
 * climbing) with the previous one sends `requests` back to 0, `done` back to
 * the old total and `running` to false, so the panel adopts a finished-looking
 * report immediately and stops following — the round the user just started runs
 * on invisibly. Measured 2026-10-06: "click probe, it flashes, then nothing
 * happens", with the endpoint reporting `running:false, requests:0, done:35/35`
 * while a round was demonstrably in flight.
 *
 * The guard lives HERE rather than at the call site because this is where the
 * clobbering happens, and every future caller inherits it.
 */
export function adopt(
  state: CatalogState,
  deps: CatalogDeps,
  record: CatalogCacheRecord,
  // Restoring the finished-round report belongs to STARTUP. It is what makes a
  // restarted host show the last outcome instead of an empty progress area —
  // but it is a snapshot of a round that already ended, and an ordinary sync
  // re-adopting it mid-round replaced a live `probeRun` (running:true) with
  // the previous one (running:false, done:2). The round then carried on
  // incrementing `done` on that swapped-in object, so the panel reported 4/2 and
  // the wrong tally was persisted. A refresh updates the
  // catalogue and the verdicts; it has nothing to say about a round in flight.
  restoreRound = false,
): void {
  // The Off evidence a previous process MEASURED, threaded into the derivation
  // itself rather than patched onto the result: the map is a function of the
  // record plus the evidence, so patching afterwards would leave two places that
  // decide `off` — which is how the two authorities drifted apart before.
  const derived = deriveWithEvidence(state, deps, record.models);
  // An empty state.models dictionary is NOT a catalogue — it is a fetch that failed
  // and got persisted anyway (a round writes one when the catalogue fetch
  // never succeeded, see runProbeRound). Adopting it empties the picker on
  // the next start, which is strictly worse than the missing verdicts that
  // write was meant to preserve. Keep the offline floor and take only the
  // probe state; this is the same fail-safe direction every other "we could
  // not tell" path in this file already takes.
  if (derived.candidates.length > 0) {
    state.models = derived.candidates;
    state.source = "models.dev";
    state.updatedAt = record.fetchedAt;
  }

  if (Object.keys(record.probes).length > 0) state.probes = { ...record.probes };
  // A channel a previous process MEASURED, re-applied. Without this the
  // measurement is on disk and ignored, so a restart silently reverted every
  // model to its inferred channel and the very failure the probe ruled out
  // came back.
  applyMeasuredChannel(state.models, state.probes);
  if (record.lastProbeAt > state.lastProbeAt) state.lastProbeAt = record.lastProbeAt;
  // The report of a round that already finished, so a restart shows the
  // outcome instead of an empty progress area. `running` stays false: this is
  // a completed round, not one to follow.
  const restored = record.lastRound;
  if (restoreRound && state.probeRun.running !== true && restored !== undefined && restored.total > 0) {
    state.probeRun = {
      running: false,
      requests: 0,
      total: restored.total,
      done: restored.done,
      current: null,
      results: { ...restored.results },
      targets: Array.isArray(restored.targets) ? restored.targets.slice() : [],
      startedAt: record.lastProbeAt,
    };
  }
  // Verdicts for state.models the catalogue no longer carries are dropped: a
  // vanished model is not in any round's target list, so keeping its verdict
  // would only grow the state.cache file across upstream removals. This is also
  // why a DEAD model is not removed from `state.models` above — see effectiveList.
  const present = new Set(state.models.map((model) => model.id));
  for (const id of Object.keys(state.probes)) if (!present.has(id)) delete state.probes[id];
}

function refreshGate(state: CatalogState, deps: CatalogDeps): Promise<ReadonlySet<string> | null> {
  if (state.gateInflight !== null) return state.gateInflight;
  state.gateInflight = (async () => {
    const { listZenIds } = deps;
    if (listZenIds === undefined) return null;
    const raw: unknown = await listZenIds().catch(() => null);
    const served = admissibleGate(state, raw);
    if (served === null) return null;
    state.zenIds = served;
    state.gateCheckedAt = deps.now();
    return served;
  })().finally(() => {
    state.gateInflight = null;
  });
  return state.gateInflight;
}

/**
 * The ONE rule for "may this answer narrow the gate?".
 *
 * Three shapes are "could not tell", and all three must leave the gate alone:
 * a failure (null), a non-array (this seam is also filled by a host refresh and
 * by tests — iterating a bare string turns it into a set of single characters,
 * i.e. a well-typed, well-formed, entirely wrong gate), and an empty list
 * (`fetchZenModelIds` already collapses one to null, but the invariant belongs
 * here, not at the state.source).
 *
 * DISJOINT is the fourth, and the one a list-emptiness check misses. A response
 * that is perfectly well-formed and names NONE of the state.models we hold is far more
 * likely to be a changed shape, a wrong egress, or a different tenant than it is
 * to be a simultaneous withdrawal of every free model — and acting on it empties
 * the picker outright, which is the one outcome this decision exists to prevent.
 *after the `[]` guard shipped believing it was
 * sufficient.
 *
 * This was previously written TWICE — once in `refreshGate`, once in
 * `applyZenGate` — and only the first was ever executed, so "change one, forget
 * the other" would have accumulated silently until some future host actually
 * called `refreshModels`. One owner, both callers.
 */
function admissibleGate(state: CatalogState, raw: unknown): ReadonlySet<string> | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (state.models.length > 0) {
    const held = new Set(state.models.map((model) => model.id));
    let overlap = 0;
    for (const id of raw) if (typeof id === "string" && held.has(id)) overlap += 1;
    if (overlap === 0) return null;
  }
  const served = new Set<string>(raw.filter((id): id is string => typeof id === "string" && id !== ""));
  return served.size > 0 ? served : null;
}

async function sync(state: CatalogState, deps: CatalogDeps): Promise<void> {
  const { path, fetchImpl, userAgent, warmReadTimeoutMs } = deps;
  // Never fetch before the warm read settles: the response below is built
  // from `state.cache` (for the conditional etag) and adopted over whatever the
  // warm start installed, so letting the two interleave either resurrects a
  // removed model or drops the persisted probe history.
  await Promise.race([
    deps.warm,
    new Promise<void>((resolve) => setTimeout(resolve, warmReadTimeoutMs).unref?.()),
  ]);
  // R5: without a state.cache there is nothing a 304 could rebuild, so the
  // conditional header must not be sent at all.
  const result = await fetchSection({ fetchImpl, etag: state.cache?.etag, userAgent });
  if (result.kind === "failed") return; // failure preserves the current catalogue
  const stamp = deps.now();
  if (result.kind === "not-modified") {
    state.updatedAt = stamp;
    // The endpoint honoured the header, so the short window is now earned.
    state.lastFetchWasNotModified = true;
    // Carry the new freshness into the state.cache file too, otherwise every boot
    // would revalidate again despite the catalogue being current.
    if (state.cache !== null) {
      state.cache = { ...state.cache, fetchedAt: stamp };
      await writeCacheAtomic(path, {
        etag: state.cache.etag,
        fetchedAt: stamp,
        models: state.cache.models,
        probes: state.probes,
        lastProbeAt: state.lastProbeAt,
        // Carried, not re-derived: a catalogue revalidation is not a probe
        // round and has nothing new to report, but DROPPING it would delete
        // the last round's report from disk.—
        // the field predates the 6h window, which is what made the loss
        // frequent enough to notice (up to four syncs a day instead of one).
        lastRound: state.cache.lastRound,
      });
    }
    return;
  }
  // Retain the etag: without this every revalidation would be a full
  // 5.2MB download instead of a conditional request.
  // A real body means the short window is withdrawn until a 304 earns it back.
  state.lastFetchWasNotModified = false;
  // Carry `lastRound` across the rebuild, exactly as the 304 branch above does.
  // The 304 branch spreads the old record and so kept it; this branch built a
  // fresh object and silently dropped the field, so the very next write
  // deleted the last round's report from disk. The comment here used to claim
  // the opposite of what the code did. Reproduced 2026-09-30: a second full
  // sync after a round left `lastRound` absent.
  const previousRound = state.cache?.lastRound;
  state.cache = {
    version: CACHE_VERSION,
    etag: result.etag,
    fetchedAt: stamp,
    models: result.section,
    probes: state.probes,
    lastProbeAt: state.lastProbeAt,
    lastRound: previousRound,
  };
  adopt(state, deps, state.cache);
  // A sync is not a round and has nothing new to report, but its write replaces
  // the whole record — so omitting the field deletes the report. Carried, not
  // re-derived.
  await writeCacheAtomic(path, {
    etag: result.etag,
    fetchedAt: stamp,
    models: result.section,
    probes: state.probes,
    lastProbeAt: state.lastProbeAt,
    lastRound: previousRound,
  });
}

function runSingle(state: CatalogState, deps: CatalogDeps): Promise<void> {
  if (state.inflight !== null) return state.inflight;
  state.inflight = sync(state, deps).finally(() => {
    state.inflight = null;
  });
  return state.inflight;
}

function runProbeSingle(
  state: CatalogState,
  deps: CatalogDeps,
  options: { samplesPerModel?: number; scope?: ProbeScope } = {},
): Promise<void> {
  if (state.probeInflight !== null) return state.probeInflight;
  state.probeInflight = runProbeRound(state, deps, options).finally(() => {
    state.probeInflight = null;
  });
  return state.probeInflight;
}

/**
 * Exported for tests, and for that is the whole point of the extraction: a round
 * can now be driven with two plain objects, with no factory, no temp directory
 * and no network. Everything else in this file moved for the same reason.
 */
/**
 * Keeps the vocabulary a refusal enumerated, without keeping the refusal.
 *
 * A refusal is worthless as a verdict and valuable as a vocabulary: it says the
 * model exists and what it accepts. Recording it as a verdict would be exactly
 * the "absence read as a claim" mistake; discarding it would throw away the
 * only evidence of a level models.dev under-declares.
 */
function harvestSelfReport(state: CatalogState, id: string, outcome: ProbeResult): void {
  const reported = outcome.selfReported;
  if (reported === undefined || reported.length === 0) return;
  const previous = state.probes[id]?.selfReported;
  if (previous !== undefined && previous.length === reported.length && previous.every((l, i) => l === reported[i])) return;
  state.probes = {
    ...state.probes,
    [id]: { ...(state.probes[id] ?? { verdict: "ok", at: 0 }), selfReported: [...reported] },
  };
}

export async function runProbeRound(
  state: CatalogState,
  deps: CatalogDeps,
  options: { samplesPerModel?: number; scope?: ProbeScope } = {},
): Promise<void> {
  const samplesPerModel = options.samplesPerModel ?? 1;
  const scope = options.scope ?? "visible";
  const { path, hidden, probe } = deps;
  // The raw models.dev record behind a derived model, so an effort measurement
  // is fingerprinted against what it is actually ABOUT. Absent before the first
  // sync, which is exactly when there is nothing to fingerprint yet.
  const rawById = (id: string): CatalogRecord | undefined => {
    const section = state.cache?.models;
    const raw = section === undefined ? undefined : section[id];
    return isPlainObject(raw) ? ({ ...raw, id } as CatalogRecord) : undefined;
  };
  // A round reads `state.probes` twice — to decide what is already settled, and
  // to answer `priorVerdict`, which is the only thing that lets it tell a fresh
  // removal from a re-confirmed old one — and `state.models` to decide what to
  // ask. All of it arrives with the warm cache read, which is fire-and-forget.
  //
  // A round that started before that read landed therefore computed every prior
  // verdict as "unknown": it re-asked models it already knew the answer for, and
  // reported old deaths as removals that had just happened. `sync()` already
  // waits on this same promise for this same reason; a round has to as well.
  await Promise.race([
    deps.warm,
    new Promise<void>((resolve) => setTimeout(resolve, deps.warmReadTimeoutMs).unref?.()),
  ]);
  const stamp = deps.now();
  // Cheap authoritative availability first. One `GET /zen/v1/state.models` answers
  // "does Zen serve this id at all" without spending inference quota, so a
  // withdrawn model costs one GET instead of one completion — and the answer
  // is Zen's own, not a reading of error prose. This is the same check 9router
  // makes for its free provider, and it is the reason its availability test
  // is fast.
  //
  // It is deliberately NOT recorded as a `dead` verdict. `dead` is permanent
  // and learned by asking the model; membership is recomputed from the
  // authority on every round, so a model Zen puts back simply reappears.
  // Conflating the two is how a model that came back stays suppressed forever.
  const servedSet = await refreshGate(state, deps);
  const live = servedSet === null ? state.models : state.models.filter((model) => servedSet.has(model.id));
  // A `dead` verdict is final ONLY once it has been earned by asking every
  // channel. A verdict without that marker predates the sweep, so it gets one
  // re-check: those are precisely the verdicts that may have been a wrong
  // channel refused rather than a model that is gone — and a permanent verdict
  // on a wrong channel is how a working model goes missing for good.
  // The round's scope, decided by one pure function below.
  const { targets, notListed } = planRound(state.models, live, servedSet, state.probes, hidden, deps.now(), scope);
  // The panel polls this while the round runs: a progress pill ("4/10") and
  // one badge per row (ok with latency / failed / probing / waiting). It is
  // replaced wholesale at the start of every round and frozen when the round
  // ends, so a late poll never shows a previous round's leftovers as live.
  state.probeRun = {
    running: true,
    requests: 0,
    // The round's whole scope, so the panel can tell "queued" from "skipped".
    targets: [...targets, ...notListed].map((model) => model.id),
    total: targets.length + notListed.length,
    done: 0,
    current: null,
    results: {},
    startedAt: stamp,
  };
  let untrusted = false;
  for (const model of notListed) {
    // At zero cost, with the reason that is actually known: Zen does not list
    // it. This is what lets the panel say so rather than leave a gap.
    state.probeRun.results[model.id] = {
      status: "failed",
      ms: 0,
      code: "not-listed",
      http: 0,
      removed: true,
    };
    state.probeRun.done += 1;
  }
  try {
    for (const model of targets) {
      // A model is asked until this axis has an answer, not until the round
      // ends. Every `continue` below leaves the SHOT loop, which is what it has
      // always meant: this model is done for this round. The budget is the only
      // hard stop, and `effortMeasurementPending` is what stops it early — so the
      // cost follows the evidence rather than the calendar.
      // One row and one tally tick per MODEL, however many samples it takes.
      let okShots = 0;
      let elapsedTotal = 0;
      // Requests spent on THIS model. `state.probeRun.requests` is the round's
      // total, and comparing that against the per-model budget silently stopped
      // asking the ceiling and capability questions after the round had spent
      // nine requests anywhere — four models in, seven never heard the question.
      let shots = 0;
      // Separate from `shots` on purpose: the effort ladder and the capability
      // axes are different questions with different budgets, and one starving the
      // other is how the ceiling harvest ended up manual-only.
      let capabilityShots = 0;
      for (let shot = 1; shot <= samplesPerModel; shot += 1) {
      shots += 1;
      state.probeRun.requests += 1;
      state.probeRun.current = model.id;
      const started = deps.now();
      let outcome: ProbeResult;
      // Declared here so the bookkeeping below reads THE question that was sent,
      // never a second derivation of it.
      let question: EffortQuestion = "baseline";
      try {
        const raw = rawById(model.id);
        const record0 = state.probes[model.id];
        const settled = raw !== undefined && effortVerdictFresh(record0, reasoningFingerprint(raw), deps.now());
        // THE question, derived once. It used to be derived twice — once to send
        // (with this model's own lowest published level as the fallback) and
        // once to label the verdict (with a hardcoded `minimal`) — and after a
        // disagreement the two answers differ. The stored label then changed the
        // question itself, so a measurement taken at `low` ended up filed, and
        // finally frozen, as a claim about `minimal`: a level this model does not
        // publish, measured once while the tally said three.
        question = nextEffortQuestion(record0, raw === undefined ? "minimal" : fallbackLevelFor(raw), settled);
        outcome = await probe!(model, question);
      } catch {
        untrusted = true;
        state.probeRun.results[model.id] = {
          status: "failed",
          ms: Math.max(0, deps.now() - started),
          code: "error",
          http: 0,
        };
        break;
      }
      // The row badge reports whether the model ANSWERED, not what the
      // verdict was: `dead` removes the model from the list, but from this
      // round's point of view it is still "did not answer usably". Only
      // `ok` earns the green badge; everything else is red — and red carries
      // WHY, because a red badge with no reason is not a report.
      const elapsed = Math.max(0, deps.now() - started);
      elapsedTotal += elapsed;
      const row = probeRowFor(outcome, elapsed, state.probes[model.id]?.verdict);
      if (row.status === "ok") okShots += 1;
      state.probeRun.results[model.id] = roundRowSoFar(row, okShots, elapsedTotal);
      // A refusal of a spelling THIS probe injected is a sample about that
      // spelling, not a failure to reach the model. Measured 2026-10-06:
      // space-bunny-free answers `none` with a hard 400 on both channels while
      // the same model answers the omitted request normally — so the refusal is
      // evidence, and it is exactly the evidence that moves the round to the
      // model's own lowest level (ADR 0004 §31). Treating it as a round that
      // concluded nothing both threw that away AND silenced the model for six
      // hours, so the fallback could never be reached.
      //
      // Only 400/422 qualify, and only for a question this probe actually asked:
      // a 403/429 is about the caller, a 404/410 is about the model, and both are
      // already classified upstream. The probe's own request is `hi` with a
      // 1024-token budget, so ADR 0004 §7's "a generic 400 also means context
      // overflow" shape does not apply to it.
      const spellingRefused =
        outcome !== undefined && outcome !== null && outcome.kind === "inconclusive"
        && question !== "baseline" && question !== "settled"
        // 400/422 are the ordinary "I will not take this parameter" statuses;
        // a FORMAT-scoped refusal says the same thing in a 401, which would
        // otherwise be read as a credential problem and end the model up
        // permanently unmeasurable.
        //
        // The attribution is safe here because the round only asks a spelling
        // AFTER three successful omitted samples on this same channel: the
        // request differs from one that worked by exactly the injected field.
        // Measured 2026-10-06 on `space-bunny-free`: `low` answered 200 five
        // times out of five, `none` was refused every time, and the model sat in
        // the panel as "unmeasurable" instead of falling back to its own level.
        && (outcome.http === 400 || outcome.http === 422 || outcome.formatScoped === true);
      if (outcome === undefined || outcome === null || (outcome.kind === "inconclusive" && !spellingRefused)) {
        untrusted = true;
        // A round that concluded nothing writes NO verdict: a model we could
        // not reach has no verdict to give it, and giving it one would be the
        // same "absence read as a claim" mistake this change set exists to
        // remove. It is still asked next round — there is no cadence.
        harvestSelfReport(state, model.id, outcome);
        break;
      }
      if (outcome.kind !== "ok" && outcome.kind !== "dead" && !spellingRefused) {
        untrusted = true;
        harvestSelfReport(state, model.id, outcome);
        break;
      }
      const prior = state.probes[model.id];
      // A refusal carries no usage and no channel of its own, but it was still
      // answered on the channel this round asked — which is what a confirmed
      // verdict needs to be fingerprinted against.
      if (spellingRefused) harvestSelfReport(state, model.id, outcome);
      // The Off verdict the same request observed, held back until it agrees
      // with what came before. `big-pickle` accepted `none` on six of nine
      // identical requests and 400'd the rest while its liveness stayed `ok`, so
      // a single sample would persist the wrong row a third of the time with
      // nothing downstream able to notice.
      // The probe reports an OBSERVATION; what it means is decided here, because
      // the baseline arrives on a different round and only the round holds both.
      const observation = outcome.kind === "ok" ? outcome.effort : undefined;
      // A SETTLED model is asked for liveness only. Its reading is real but it
      // answers a question nobody asked, so filing it as a baseline grew that
      // array on every round for ever — and a median over a silently growing set
      // is the drift ADR 0004 §38 warns about, one array further down.
      const isBaseline = question !== "settled" && observation?.kind === "baseline";
      // A candidate is judged against the model's OWN omitted baseline, never
      // against an absolute count: longcat's floor of 36 sits above big-pickle's
      // baseline of 14, so any fixed number collides on the third model.
      // A settled model contributes nothing: no sample is appended, so its
      // verdict cannot drift while it waits for the TTL.
      const tokens =
        question === "settled" ? prior?.effortTokens : observation === undefined ? undefined : [...(prior?.effortTokens ?? []), observation.tokens];
      const baseTokens =
        observation?.kind === "baseline" ? [...(prior?.effortBaselineTokens ?? []), observation.tokens] : prior?.effortBaselineTokens;
      // Judged on medians, once enough of both sides exist. Per-sample
      // classification would measure the classifier's fragility — big-pickle's
      // `minimal` alternates 0 and 8 — rather than the model's.
      const working =
        observation?.kind === "candidate" && (tokens?.length ?? 0) >= EFFORT_SAMPLES
          ? effortVerdictFrom(tokens, baseTokens)
          : undefined;
      // A refusal IS a sample: `rejected` is the one kind that needs no token
      // count, and it is what the fallback branch is waiting for.
      const sample: MeasuredEffort["kind"] | undefined =
        question === "settled"
          ? undefined
          : spellingRefused
            ? "rejected"
            : working === true
              ? "none-works"
              : working === false
                ? "noop"
                : undefined;
      const tally = sample === undefined ? undefined : effortVerdict(prior?.effortSamples, sample);
      // How many times the CURRENT question has failed.
      //
      // `EFFORT_FALLBACK_AFTER` counts failures, not disagreements. It had to
      // count whatever `effortVerdict` calls a discord — and that function has to
      // call the very first sample one, because there is no prior to agree with.
      // So one measurement of `none` was enough to move the round off `none`,
      // including when `none` was exactly what works: mimo-v2.6-flash-free would
      // have been asked `minimal` instead, and `minimal` measures 16 against a 37
      // baseline — a miss of 0.09 tokens against the 15.91 threshold — so a model
      // with a perfect Off would have ended with no Off row at all.
      //
      // A question switch also resets the count: the fallback level is a fresh
      // attempt, and the failures recorded against `none` say nothing about it.
      const failed = sample !== undefined && sample !== "none-works";
      const movedOn = prior?.effortQuestion !== undefined && prior.effortQuestion !== question;
      const discord =
        tally === undefined
          ? (prior?.effortDiscord ?? 0)
          : tally.kind === "confirmed"
            ? 0
            : movedOn
              ? 0
              : (prior?.effortDiscord ?? 0) + (failed ? 1 : 0);
      // A refusal names no channel of its own, but it WAS answered on the one
      // this round asked — and a verdict that cannot say which channel it was
      // taken on is a verdict `thinkingLevelMapFor` will refuse to apply.
      const channel = isMeasuredChannel(outcome.api) ? outcome.api : spellingRefused && isMeasuredChannel(model.api) ? model.api : undefined;
      const confirmed =
        sample !== undefined && tally !== undefined && tally.kind === "confirmed" && channel !== undefined && rawById(model.id) !== undefined
          ? sample
          : undefined;
      // The record is REBUILT every round, so it starts from the previous one:
      // evidence this round does not re-derive — the other side of the effort
      // tally, a vocabulary a refusal enumerated, a measured window — is the
      // only copy that exists, and a baseline round used to erase the candidates
      // while a candidate round erased the baseline. Alternating rounds then
      // erase half the tally each time, which no number of rounds can satisfy.
      //
      // `reason` is the one field deliberately NOT carried: it describes this
      // verdict, so a model that answers again must not keep displaying the
      // refusal that used to retire it. Everything else survives untouched, and
      // the fingerprints on the measurements are checked where they are applied.
      const { reason: _staleReason, ...carried } = prior ?? {};
      const next: ProbeRecord = {
        ...carried,
        // Whatever this round concluded about effort, it concluded it with THIS
        // instrument. Recorded on the samples it touched, so a record written by
        // an older one is recognisable on the way back in.
        ...(observation !== undefined || carried.effortReading !== undefined || tally !== undefined
          ? { effortReading: EFFORT_READING }
          : {}),
        // A round that only measured a refusal learned nothing new about
        // LIVENESS, so the verdict it already earned stands; writing
        // `inconclusive` here would both be a value `ProbeVerdict` does not
        // admit and throw away a verdict the model did earn.
        verdict: outcome.kind === "ok" || outcome.kind === "dead" ? outcome.kind : (prior?.verdict ?? "ok"),
        at: stamp,
        ...(typeof outcome.reason === "string" && outcome.reason !== "" ? { reason: outcome.reason } : {}),
        // Only an answer names a channel. A refusal is evidence that the
        // channel did not work, not evidence that another one would — except a
        // refusal to OUR OWN spelling, which was answered on the channel we
        // asked and therefore keeps it.
        ...(outcome.kind === "ok" && isMeasuredChannel(outcome.api)
          ? { api: outcome.api }
          : spellingRefused && channel !== undefined
            ? { api: channel }
            : {}),
        // Reaching here means the prober exhausted every channel before
        // concluding, so this `dead` is earned and can be final — but "final"
        // needs an end, and the end is a date rather than never.
        ...(outcome.kind === "dead" ? { swept: true, nextProbeAt: stamp + DEAD_RECHECK_MS } : {}),
        // The tally is kept even when nothing was confirmed, so the next round
        // continues the count instead of restarting it.
        ...(tally !== undefined && question !== "settled"
        ? { effortSamples: tally.kind === "confirmed" ? [] : tally.samples, effortDiscord: discord }
        : {}),
        // The baseline is the reference every later candidate is judged against,
        // so it is kept even when nothing was concluded.
        ...(isBaseline && observation !== undefined ? { effortBaseline: observation.tokens } : {}),
        // The raw samples are what the verdict is drawn from; keeping them is
        // what lets a later round judge the MEDIAN rather than the last value.
        ...(isBaseline && baseTokens !== undefined ? { effortBaselineTokens: baseTokens } : {}),
        ...(observation?.kind === "candidate" && tokens !== undefined ? { effortTokens: tokens } : {}),
        // Written ONLY on agreement. A disagreement empties the tally and leaves
        // the map unmeasured, which offers no Off row rather than a wrong one.
        // The fallback question stays put: it answered the question, so
        // switching back would re-open a settled matter.
        ...(tally !== undefined ? { effortQuestion: question } : {}),
        ...(confirmed && tally !== undefined && channel !== undefined
          ? {
              effort: {
                // The KIND is the confirmed sample, not the spelling we were
                // asking about. Re-deriving it from `question` is how a
                // confirmed `noop` became `level-works` on 2026-10-06:
                // `longcat-2.5-preview-free` kept samples [1,36,36,36,36]
                // against a baseline of [36,36,36] — median 36, threshold 15.48,
                // so it reduced NOTHING — and was handed an Off row at
                // `minimal` anyway. A verdict that names a level it did not
                // demonstrate is the one kind of lie this axis cannot ship.
                //
                // `level-works` is the same verdict as `none-works`, spoken in
                // the words of the level that was asked: the sample said the
                // spelling WORKS, and the spelling was `minimal`.
                kind: confirmed === "noop" || confirmed === "rejected"
                  ? confirmed
                  : question === "none"
                    ? "none-works"
                    : "level-works",
                ...(confirmed === "noop" || confirmed === "rejected" || question === "none" ? {} : { level: question }),
                fp: reasoningFingerprint({ ...rawById(model.id)!, id: model.id }),
                api: channel,
                at: stamp,
              },
              effortDiscord: 0,
              effortFrozenAt: stamp,
              // Frozen: the samples that produced this verdict are KEPT, and
              // the tally is emptied — two different things, and the comment here
              // used to claim the first while the code did the second.
              //
              // The tally is what would keep growing (a settled model is still
              // probed for liveness, and `effortSamples` would otherwise count
              // judgements made against a frozen verdict). The samples are the
              // ONLY evidence the verdict rests on: clearing them made every
              // frozen verdict unauditable, which is how a classifier can be
              // wrong with no way to notice — and on 2026-10-06 that is exactly
              // where `longcat-2.5-preview-free` landed, confirmed at a level
              // the recorded measurement says does nothing.
              effortSamples: [],
            }
          : {}),
      };
      state.probes[model.id] = next;
      // Another shot only while this axis still has no answer. A round that
      // concluded nothing at all left the shot loop above, so this cannot turn a
      // failing model into a quota drain.
      const raw = rawById(model.id);
      const pending = effortMeasurementPending(
        model,
        next,
        nextEffortQuestion(next, raw === undefined ? "minimal" : fallbackLevelFor({ ...raw, id: model.id })),
      );
      if (!pending) break;
      // Applied HERE, not when the round ends. A row is painted the moment its
      // verdict lands, so a model shown as working must already be routed the
      // way it worked — waiting for the last model to finish left a visibly
      // successful model still going down the channel the probe had just ruled
      // out. The cache write stays once per round.
      if (outcome.kind === "ok") {
        applyMeasuredChannel(state.models, state.probes);
      }
      } // shot loop
      // The capability axes this model has never been asked about. Asked AFTER the
      // effort shots and on the same budget, for two reasons: a model that did not
      // answer at all is not asked a second question (the round already knows
      // nothing about it), and a capability sample can never be filed against the
      // effort tally because it is not produced by the shot loop at all.
      //
      // `capabilityQuestionsFor` reads the SAME evidence the panel reads, so an
      // axis the panel already shows as measured is not asked again — the round
      // cannot re-measure what it already knows, which is what keeps this from
      // turning into a permanent per-round tax.
      const axisQuestions = capabilityQuestionsFor(model, rawById(model.id), state.probes, deps.now());
      // The CEILING question goes first, and it is the only one whose cost is
      // zero when it works: it asks for the whole advertised window, so a route
      // with a limit refuses and NAMES it, and a refusal produces no output
      // tokens at all. A route that answers instead is recorded as having stated
      // nothing — which is itself the answer for a model whose ceiling is above
      // anything this conversation could ask for.
      // Asked when there is nothing stored OR when what is stored cannot be
      // applied. The second half is the one that matters: an entry written under
      // the old fingerprint reads as a valid measurement (`isMeasuredLimits`
      // only checks that `fp` is a non-empty string) and is then dropped by the
      // fingerprint comparison on the way into the catalogue — so it would never
      // be asked again and never be applied. A permanent silent drop, found live:
      // `longcat-2.5-preview-free` had been sitting in exactly that state, its
      // budget coming from the seed table while the panel showed no `stated`.
      //
      // `fp: ""` is the record of "asked, and the route named nothing". It is
      // worth keeping for {@link CEILING_SILENCE_TTL_MS} — long enough that a
      // restart does not re-pay for a question already answered in silence, short
      // enough that an upstream which starts declaring a ceiling is noticed
      // within a day.
      const storedLimits = state.probes[model.id]?.limits;
      const ceilingApplies =
        storedLimits !== undefined && storedLimits.fp !== "" && rawById(model.id) !== undefined && storedLimits.fp === contextFingerprint(rawById(model.id)!);
      const ceilingAnswered =
        storedLimits !== undefined &&
        storedLimits.fp === "" &&
        storedLimits.at > 0 &&
        deps.now() - storedLimits.at < CEILING_SILENCE_TTL_MS;
      if (storedLimits === undefined || (!ceilingApplies && !ceilingAnswered)) {
        for (const _attempt of [0]) {
          if (capabilityShots >= CAPABILITY_SAMPLE_BUDGET) break;
          if (state.probes[model.id]?.verdict !== "ok") break;
          const recordCeil = rawById(model.id);
          if (recordCeil === undefined) break;
          capabilityShots += 1;
          state.probeRun.requests += 1;
          try {
            const ceilingOutcome = await probe!(model, "ceiling");
            const stated = ceilingOutcome.kind === "inconclusive" ? ceilingOutcome.ceilings : undefined;
            const priorC = state.probes[model.id];
            state.probes[model.id] = {
              ...priorC,
              // Recorded even when nothing was named: "asked, and the route said
              // no more" is what stops the next round from asking again, and it
              // is the honest state of a route that enforces nothing.
              limits:
                // Dated, so it survives a warm start and the next round can
                // tell "asked an hour ago" from "asked last week".
                stated === undefined
                  ? { fp: "", at: deps.now() }
                  : {
                      ...(stated.output === undefined ? {} : { output: stated.output }),
                      ...(stated.context === undefined ? {} : { context: stated.context }),
                      // `contextFingerprint`, NOT `capabilityFingerprint`: the two
                      // are different strings ("1000000:131072" versus
                      // "1000000:131072:text+image") and the check on the way
                      // back in compares against this one. Storing the other meant
                      // every harvested ceiling was silently dropped, and the
                      // number in the panel came from the seed table instead —
                      // which looks exactly like the mechanism working.
                      fp: contextFingerprint(recordCeil),
                      at: deps.now(),
                    },
            };
            // A context ceiling the route just NAMED is the strongest evidence
            // there is for that axis — first-party, current, free — so it is
            // applied immediately rather than at the end of the round.
            if (stated?.context !== undefined) {
              const m = state.models.find((x) => x.id === model.id);
              if (m !== undefined && stated.context > m.contextWindow) {
                (m as { contextWindow: number }).contextWindow = stated.context;
              }
            }
          } catch {
            // A prober that throws has learned nothing; the axis stays open and
            // the next round asks again.
          }
        }
      }
      // The two DECLARED-capability questions cost real output tokens — a vision
      // question can spend 4096 of them on thinking — and the daily round covers
      // every model Zen serves, including the ones the user switched OFF. Paying
      // that daily for models nobody is looking at is the wrong bill, so the axis
      // questions stay on the manual round, which is scoped to what is on screen.
      // The ceiling question above is the cheap one and runs on every round: a
      // refusal produces no output tokens at all.
      for (const axis of scope === "served" ? [] : axisQuestions) {
        if (state.probes[model.id]?.verdict !== "ok") break;
        if (capabilityShots >= CAPABILITY_SAMPLE_BUDGET) break;
        const record1 = rawById(model.id);
        if (record1 === undefined) break;
        capabilityShots += 1;
        state.probeRun.requests += 1;
        const askedAt = deps.now();
        try {
          const capabilityOutcome = await probe!(model, `capability:${axis}`);
          const judged = capabilityOutcome.kind === "ok" ? capabilityOutcome.capability : undefined;
          // Nothing is written when the request taught us nothing — the model
          // said nothing, the upstream refused, the bucket was spent. An absent
          // verdict means the panel shows "not measured" and the next round
          // tries again, which is the honest state of an unanswered question.
          if (judged === undefined) continue;
          const prior1 = state.probes[model.id];
          state.probes[model.id] = {
            ...prior1,
            capabilities: {
              ...prior1?.capabilities,
              [axis]: { ok: judged.ok, at: askedAt, fp: capabilityFingerprint(record1) },
            },
          };
        } catch {
          // Same rule as the shot loop: a prober that throws has learned nothing,
          // and a capability axis is never worth failing a round over.
        }
      }
      state.probeRun.done += 1;
    }
  } finally {
    state.probeRun.running = false;
    state.probeRun.current = null;
  }
  // Republish what this round just measured. `state.models` was derived before
  // the round, so a verdict that landed here was on disk but not in the list the
  // picker and the panel read — the user clicked "Probe now" and watched a round
  // confirm an Off row that stayed invisible until the next catalogue sync or a
  // restart. The derivation is the SAME one the warm start uses, so the two
  // cannot answer differently about the same evidence.
  //
  // `adopt()` is deliberately not called: it restores the probe map FROM the
  // record, which would roll back what this very round just wrote.
  if (state.cache !== null) {
    const derived = deriveWithEvidence(state, deps, state.cache.models);
    if (derived.candidates.length > 0) state.models = derived.candidates;
    applyMeasuredChannel(state.models, state.probes);
  }
  // The round marker is written even when nothing concluded: it is the only
  // thing that stops a fully-gated day from re-probing on every single read.
  state.lastProbeAt = stamp;
  state.probeUntrusted = untrusted;
  // One atomic write per round, never per model: a half-finished round must
  // not be read back as a complete set of verdicts.
  //
  // Written even when `state.cache` is null — i.e. a first boot whose catalogue
  // fetch failed, where the round is running against the pi-ai offline floor.
  // That round may spend up to 34 real requests from the shared anonymous
  // bucket, and the guard used to throw all of it away, so the next DSH restart
  // bought the same 34 again. `state.models` degrades to an empty dictionary, which
  // `readCache` accepts and `adopt` treats as "nothing to derive", leaving the
  // offline floor in place while the verdicts survive.
  const report: NonNullable<CatalogCacheRecord["lastRound"]> = {
    total: state.probeRun.total,
    done: state.probeRun.done,
    results: state.probeRun.results,
    targets: state.probeRun.targets,
  };
  await writeCacheAtomic(path, {
    etag: state.cache?.etag,
    fetchedAt: state.cache?.fetchedAt ?? 0,
    models: state.cache?.models ?? {},
    probes: state.probes,
    lastProbeAt: state.lastProbeAt,
    // The report, so the panel's progress area survives a restart.
    lastRound: report,
  });
  // Mirror the write back into the in-memory record. Every sync path carries
  // `state.cache.lastRound` forward rather than re-deriving it, so a round that
  // writes the report to disk without recording it here leaves the NEXT sync
  // carrying `undefined` — which deleted the very report it had just written.
  // Two writers of one field, only one of which updated the state.source of truth:
  // reproduced 2026-09-30 (fixing the sync branch alone was not enough).
  if (state.cache !== null) state.cache = { ...state.cache, lastRound: report };
}

export function createCatalog(options: CreateCatalogOptions): Catalog {
  const {
    template,
    builtinBaseline,
    knownApis,
    cachePath: path,
    fetchImpl,
    ttlMs = DEFAULT_TTL_MS,
  } = options;
  const now = options.now ?? Date.now;
  const userAgent = options.userAgent;
  const probe = options.probe;
  const listZenIds = options.listZenIds;
  const hidden = options.hidden;

  const state = initialState(builtinBaseline);

  /**
   * Resolves once the warm state.cache read has settled.
   *
   * The warm start is deliberately fire-and-forget — a container must answer
   * synchronously — but that left it free to land AFTER a sync and replace the
   * fresher section with the older cached one, holding a removed model in the
   * picker for a whole TTL. `sync(state, deps)` therefore waits for this before fetching.
   * The wait is one local `readFile` of the state.cache (megabytes, not a download)
   * and is bounded, so a wedged filesystem delays a sync rather than hanging
   * it forever.
   */
  const WARM_READ_TIMEOUT_MS = 2_000;
  let settleWarm: () => void = () => undefined;
  const warm = new Promise<void>((resolve) => {
    settleWarm = resolve;
  });

  // Three one-liners over the pure rules above. They exist so the call sites
  // read as questions ("is the catalogue stale?") rather than as expressions,
  // and so the rules themselves can be exercised without a container.
  const currentTtl = (): number => effectiveTtl(options.ttlMs, ttlMs, state.lastFetchWasNotModified);
  const stale = (): boolean => catalogueIsStale(state.updatedAt, now, currentTtl());
  const gateStale = (): boolean => gateIsStale(state.gateCheckedAt, now);

  const warmStart = (): void => {
    void readCache(path)
      .then((found) => {
        if (found === null) return;
        state.cache = found;
        // Adopted whatever its age: a stale state.cache is still a far better answer
        // than the offline floor, and `ensureFresh` revalidates on the first read
        // in the background rather than making the user wait for 5.2MB.
        //
        // …unless a round is already in flight. `restoreRound` exists for the
        // startup case, and this read is the startup read — but it resolves on
        // its own schedule, and a round started from `getModels()` can begin
        // before it lands. Restoring then replaces a LIVE `probeRun`
        // (running, requests counting, done climbing) with the previous round's
        // finished report: `requests` back to 0, `done` back to 35/35,
        // `running` false. The panel adopts that at once and stops following, so
        // the round the user just started runs on invisibly and the card shows
        // nothing changing. Measured 2026-10-06: "click probe, it flashes, then
        // nothing happens" with the live endpoint reporting `running:false,
        // requests:0, done:35/35` while a round was demonstrably in flight.
        adopt(state, deps, found, true);
      })
      .catch(() => undefined)
      .finally(settleWarm);
  };
  warmStart();

  // An explicit `ttlMs` is a caller asking for exactly that window (tests pin
  // it), so it is honoured verbatim and the adaptive step is skipped. Only the
  // default path shortens, and only after a 304 proved the header works.

  /**
   * Ask Zen, right now, which ids it serves — and remember the answer.
   *
   * The ONE writer of `state.zenIds` and `state.gateCheckedAt`. Three call sites used to
   * write the gate independently (`runProbeRound`, `applyZenGate`, and the host
   * refresh); with two independent cadences now running, two writers would mean
   * whichever finished last silently overwrote the other's answer, and a stale
   * one winning that race would look exactly like an upstream change.
   *
   * Single-flight, because a poll and a probe round can reach it together and
   * one GET answers both.
   *
   * `null` means "could not tell" and is the only reading that leaves the gate in
   * force. A narrowed gate is the one update here that can empty a picker, and a
   * timeout, a region refusal or a malformed body must never be read as "these
   * state.models are gone".
   */
  // The outside world, named once so the lifted functions can take it.
  const deps: CatalogDeps = {
    path,
    fetchImpl,
    now,
    userAgent,
    ttlMs,
    probe,
    listZenIds,
    hidden,
    template,
    knownApis,
    warmReadTimeoutMs: WARM_READ_TIMEOUT_MS,
    warm,
  };

  /**
   * D2/D6b: one ordered round over the state.models that are still unjudged.
   *
   * Sequential `for…await` on purpose (no concurrency, no batching): the round
   * spends a shared anonymous-quota bucket, and firing 30+ requests at once
   * would both exhaust it faster and hammer upstream.
   *
   * A model already judged `dead` is NOT re-probed. The verdict is final by
   * design: re-asking a model the route has already refused spends quota to
   * re-learn a settled fact, and on this provider that is the difference
   * between ~34 requests a day and ~10. A Zen key does not change this — it
   * raises the quota, not the model list, so a refused model is refused with a
   * key too. Recovery is manual and is for upstream changes (a model coming
   * back, a channel being fixed): delete
   * `$DSH_HOME/dsh-opencode-free/catalog.json` and the next start re-derives
   * and re-state.probes the whole catalogue.
   *
   * Only conclusive verdicts are recorded. An `inconclusive` — or a prober that
   * rejects — leaves the model exactly as it was (D5): one gated IP must never
   * empty the picker.
   */

  /**
   * Keeps the vocabulary a refusal enumerated, without keeping the refusal.
   *
   * A refusal is worthless as a verdict and valuable as a vocabulary: it says the
   * model exists and what it accepts. Recording it as a verdict would be exactly
   * the "absence read as a claim" mistake; discarding it would throw away the
   * only evidence of a level models.dev under-declares.
   */
  function harvestSelfReport(state: CatalogState, id: string, outcome: ProbeResult): void {
    const reported = outcome.selfReported;
    if (reported === undefined || reported.length === 0) return;
    const previous = state.probes[id]?.selfReported;
    if (previous !== undefined && previous.length === reported.length && previous.every((l, i) => l === reported[i])) {
      return;
    }
    state.probes = { ...state.probes, [id]: { ...(state.probes[id] ?? { verdict: "ok", at: 0 }), selfReported: [...reported] } };
  }

  /** Records one clamp observation and, once they agree, raises the window. */
  /**
   * Write the catalogue cache with whatever the state holds RIGHT NOW.
   *
   * Shared because the truncation counters are written from the request path,
   * not from a round: they accumulate over days of ordinary use, and a counter
   * that a restart erases cannot answer the question it exists to answer. The
   * round's own write stays where it is — it is a milestone, this is not — but
   * both go through here so the record they produce cannot differ.
   *
   * Fire-and-forget on purpose: a reply must never wait on bookkeeping, and the
   * write is atomic, so the worst a crash costs is one increment.
   */
  let persistInFlight: Promise<void> | null = null;
  let persistQueued = false;
  function persistCache(): void {
    if (state.cache === null) return;
    // SERIALISED, because the record is a whole-file replace and two concurrent
    // writes lose one of the increments: three truncations in quick succession
    // produced three overlapping writes, and the one that landed last was
    // whichever had read the state earliest — so a count went missing. Caught by
    // the test that reads the file back, not by the panel, which never saw the
    // number at all.
    if (persistInFlight !== null) {
      persistQueued = true;
      return;
    }
    // Built at WRITE time, not at call time, so a queued write carries the state
    // as it is when it goes out rather than as it was when it was asked for.
    persistInFlight = writeCacheAtomic(path, {
      etag: state.cache.etag,
      fetchedAt: state.cache.fetchedAt,
      models: state.cache.models,
      probes: state.probes,
      lastProbeAt: state.lastProbeAt,
      lastRound: state.cache.lastRound,
    })
      .catch(() => undefined)
      .then(() => {
        persistInFlight = null;
        if (persistQueued) {
          persistQueued = false;
          persistCache();
        }
      });
  }

  function observeFirstToken(id: string, ms: number): void {
    const record = state.probes[id];
    const previous = record?.firstTokenMs ?? [];
    state.probes = {
      ...state.probes,
      [id]: {
        ...(record ?? { verdict: "ok", at: now() }),
        // Newest first, five deep: enough to stop one cold request from becoming
        // the model's reputation, and small enough that a stale entry expires on
        // its own within a normal week of use.
        firstTokenMs: [ms, ...previous].slice(0, 5),
      },
    };
    persistCache();
  }

  function observeClamp(id: string, observation: ClampObservation): void {
    const model = state.models.find((m) => m.id === id);
    if (model === undefined) return;
    const record = state.probes[id];
    // Counted FIRST, and independent of `starved`: a reply cut off mid-answer is
    // not the clamp signature (which needs an empty one), and it is the fact
    // that says whether the advertised budget is too low. `emitted` below the
    // model's own ceiling means the CONTEXT clamp cut it, which is a different
    // question and is counted apart — a conversation running out of room is not
    // an output budget that is too small.
    if (observation.truncated === true) {
      const byContext =
        observation.emitted === undefined || observation.emitted < model.maxTokens;
      const hits = record?.budgetHits ?? {};
      state.probes = {
        ...state.probes,
        [id]: {
          ...(record ?? { verdict: "ok", at: now() }),
          budgetHits: {
            ...hits,
            ...(byContext ? { context: (hits.context ?? 0) + 1 } : { output: (hits.output ?? 0) + 1 }),
            at: now(),
          },
        },
      };
      // Persisted, not held in memory: the answer this counts towards is "has a
      // reply ever wanted more than we send", and a counter a restart erases
      // cannot answer it — this session alone restarted six times.
      persistCache();
    }
    if (!observation.starved) return;
    const verdict = clampVerdict(record, observation, model.contextWindow);
    if (verdict.kind === "none") return;
    if (verdict.kind === "hit") {
      // In-memory only. Losing it on restart costs one more round, never a
      // wrong verdict, which is the same bargain the round's counters make.
      state.probes = { ...state.probes, [id]: { ...(record ?? { verdict: "ok", at: now() }), contextHits: verdict.hits } };
      return;
    }
    // The raw section the derivation came from, so the measurement is fingerprinted
    // against what it is actually about rather than against whatever is on hand.
    const section = state.cache?.models;
    const record0 = section !== undefined && isPlainObject(section[id]) ? { ...(section[id] as CatalogRecord), id } : undefined;
    const measured: MeasuredContext = {
      raisedTo: verdict.raisedTo,
      fp: record0 === undefined ? "" : contextFingerprint(record0),
      at: now(),
      // Derived from the clamp signature, never from the endpoint's own words —
      // so it stays behind the `declared x 4` valve.
      source: "inferred",
    };
    state.probes = {
      ...state.probes,
      [id]: { ...(record ?? { verdict: "ok", at: now() }), context: measured, contextHits: 0 },
    };
    // Only ever upward, and re-derived from the same function that produced it,
    // so the live list and the next warm start cannot disagree.
    const raised = record0 === undefined ? verdict.raisedTo : contextWindowFor(record0, measured) ?? verdict.raisedTo;
    if (raised > model.contextWindow) (model as { contextWindow: number }).contextWindow = raised;
  }

  return {
    observeClamp,
    observeFirstToken,
    current(): CatalogSnapshot {
      // One pass over the single effective list feeds both `visible` and
      // `capabilities`, so the ids and the cards can never disagree.
      const effective = effectiveList(state.models, state.zenIds, state.probes);
      // The raw records behind the derived models, so a card can say what
      // models.dev published next to what the plugin actually advertises — and
      // so the two provenance flags come from the same seed tables and probe
      // records the request path reads, rather than from a second opinion formed
      // here. A panel that recomputes "measured" on its own is exactly the kind
      // of second authority that drifts.
      const rawById = (id: string): CatalogRecord | undefined => {
        const raw = state.cache?.models?.[id];
        return isPlainObject(raw) ? ({ ...raw, id } as CatalogRecord) : undefined;
      };
      const section = state.cache?.models;
      const efforts = section === undefined ? new Map<string, MeasuredEffort>() : measuredEffortMap(effective, section, state.probes);
      const harvested = section === undefined ? new Map<string, MeasuredLimits>() : measuredLimitsFor(effective, section, state.probes);
      const measured = section === undefined ? new Map<string, MeasuredContext>() : measuredContextFor(effective, section, state.probes);
      return {
        models: state.models.slice(),
        visible: effective.map((model) => model.id),
        capabilities: effective.map((model) => {
          const record = rawById(model.id);
          const limit = isPlainObject(record?.limit) ? record.limit : {};
          const declaredContext = finitePositive(limit.context);
          const declaredOutput = finitePositive(limit.output);
          return modelCapability(model, {
            record,
            probes: state.probes,
            // "Measured" means the number on the wire is not the number that was
            // published — stated plainly rather than re-derived from the seed
            // tables, because this is the only reading a reader of the panel can
            // check: they can see both numbers.
            measured: measured.get(model.id),
            measuredEffort: efforts.get(model.id),
            limits: harvested.get(model.id),
            budgetHits: state.probes[model.id]?.budgetHits,
            firstTokenMs: state.probes[model.id]?.firstTokenMs,
            now: Date.now(),
          });
        }),
        source: state.source,
        updatedAt: state.updatedAt,
        gateCheckedAt: state.gateCheckedAt,
        unknownFree: unknownFree(state.models, state.zenIds),
        refreshing: state.inflight !== null,
        probedAt: state.lastProbeAt,
        probeInconclusive: state.probeUntrusted,
      };
    },
    effectiveModels(): Model<Api>[] {
      return effectiveList(state.models, state.zenIds, state.probes);
    },
    async ensureFresh(): Promise<void> {
      // Two independent expiry axes. Both are STARTED before the first await,
      // so they overlap rather than interleave; neither waits on the other,
      // because the failure modes are unrelated — a Zen outage must not delay
      // the catalogue, and a 5.2MB download must not delay a one-request gate.
      const catalogue = state.inflight ?? (stale() ? runSingle(state, deps) : null);
      const gate = gateStale() ? refreshGate(state, deps) : null;
      // The gate is awaited first because it cannot reject: letting a catalogue
      // failure skip it would silently drop the cheap, quota-free check.
      if (gate !== null) await gate;
      if (catalogue !== null) await catalogue;
    },
    async forceRefresh(): Promise<void> {
      return runSingle(state, deps);
    },
    async runProbes(): Promise<void> {
      if (probe === undefined) return;
      if (state.probeInflight !== null) return state.probeInflight;
      if (probedToday(state.lastProbeAt, now)) return;
      // One request per model, over every model Zen still lists: nobody asked
      // for this round, and its job is to keep the catalogue honest rather than
      // to answer a question someone is watching.
      return runProbeSingle(state, deps, { samplesPerModel: 1, scope: "served" });
    },
    async forceProbes(): Promise<ProbeStart> {
      if (probe === undefined) return { started: false, reason: "unavailable" };
      if (state.probeInflight !== null) return { started: false, reason: "running" };
      // A manual round still costs one request per model from a bucket shared
      // per egress IP, and the POST route has no rate limit of its own — so
      // repeated clicks spent the whole office's quota. A short floor keeps the
      // button honest without making it useless: the user asked for a fresh
      // answer, not a second one five seconds later.
      //
      // The floor is REPORTED rather than swallowed. Returning nothing made a
      // refused click indistinguishable from a started one: the route answered
      // 202 either way, and the panel spun until its grace period expired with
      // no word about why.
      const wait = FORCED_PROBE_MIN_INTERVAL_MS - (now() - state.lastProbeAt);
      if (wait > 0) return { started: false, reason: "cooldown", retryAfterMs: wait };
      await runProbeSingle(state, deps, {
        samplesPerModel: options.manualSampleBudget ?? MANUAL_SAMPLE_BUDGET,
        scope: "visible",
      });
      return { started: true };
    },
    probeProgress(): ProbeProgress {
      // A copy: the round mutates `state.probeRun` while the panel reads this.
      return {
        running: state.probeRun.running,
        total: state.probeRun.total,
        done: state.probeRun.done,
        current: state.probeRun.current,
        results: { ...state.probeRun.results },
        targets: state.probeRun.targets.slice(),
        startedAt: state.probeRun.startedAt,
        requests: state.probeRun.requests,
        pending: pendingEffortIds(state),
      };
    },
    applyZenGate(ids: readonly string[] | null): void {
      // The host's own refresh is a SECOND writer of `state.zenIds`, and the review
      // that shipped the 30-minute gate is what made that worth saying out
      // loud. Today only `refreshGate` runs — the host never calls
      // `provider.refreshModels`, verified 2026-09-30 — so nothing can race. If
      // a future host does call it, these two paths can interleave and the
      // slower one can overwrite the newer answer, which is indistinguishable
      // from an upstream change. Fold this into `refreshGate` before relying on
      // it.
      //
      // Same admissibility rules meanwhile: a null, empty, non-array or wholly
      // disjoint answer is not a membership decision, it is an absent one.
      const served = admissibleGate(state, ids);
      if (served === null) return;
      state.zenIds = served;
      // A host refresh answered the same question this poll would, so the
      // freshness stamp moves too — otherwise the next read would spend a
      // second GET on an answer already in hand.
      state.gateCheckedAt = now();
    },
  };
}
