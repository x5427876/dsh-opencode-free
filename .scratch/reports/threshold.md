# The effort classifier: what should "Off works" actually mean?

**Owner:** align-design · **Design only — `src/` and `tests/` untouched.**
**Fixes a shipped defect**, adds no new axis.

---

## 0. The defect, restated precisely

The probe writes `reasoning_effort:"none"` at the payload boundary and classifies each
**sample** as `none-works` when `reasoning_tokens === 0`, `noop` when above zero. The
round requires **three concordant samples** before persisting.

`big-pickle` with `minimal` produced `0, 8, 0, 0, 8, 0` — so the per-sample verdicts
alternate `none-works / noop / none-works / none-works / noop / none-works` and three
concordant samples **never occur**. The fallback is therefore dead for the only model it
was built for, even though `minimal` is a genuinely working Off there.

Two separate faults, and they must be fixed separately:

1. **The statistic is wrong.** "Is it exactly zero" discards the only thing that
   distinguishes a floor from a partial reduction. A candidate that reliably lands at
   0–8 tokens *is* at the floor; the classifier cannot see that.
2. **The aggregation order is wrong.** Classify-then-aggregate asks "did every sample
   agree?" — which is a question about **variance**, and variance is not what we need to
   know. Aggregate-then-classify asks "what is the candidate's typical behaviour?", which
   is. On `big-pickle` the mean of the six `minimal` samples is **2.7** and the median
   is **0**, while the mean of the six `none` samples is **198.7** and the median is
   **173**. The two populations are not close.

---

## 1. Candidate discriminators, ranked

### 1 — Ratio of medians against a measured omitted baseline  ← **recommended**

`ratio = median(candidate samples) / median(omitted samples for the same model)`.
Working iff `ratio ≤ BOUNDARY`.

- **Cost:** the baseline is **free** — see §3.1. Three candidate samples per candidate.
- **What it fixes:** every case in the dataset, with a symmetric 1.86× margin (§2).
- **What it breaks:** baseline variance. `big-pickle`'s own omitted samples are
  `[14, 16, 55]` — a 3.9× spread — so the denominator is not a constant. Mitigated by
  median-over-3 rather than a single sample, and by the fact that a zero numerator is
  immune to denominator error.

### 2 — Aggregate-then-classify instead of classify-then-aggregate

Not a threshold choice; a **statistic** choice that composes with #1. Median of n
samples, decided once per round, rather than n per-sample verdicts required to agree.

- **Cost:** none. It *removes* the concordance requirement that is currently costing
  three rounds and never converging.
- **What it fixes:** `big-pickle` `minimal` immediately — median 0, ratio 0.000.
- **What it breaks:** it cannot distinguish a candidate that is *usually* at the floor
  from one that is *occasionally* at the floor. That residual is handled by §5's
  ambiguity band, not by per-sample voting.

### 3 — Absolute near-floor threshold

"Working iff `median(candidate) ≤ N` tokens."

- **Cost:** zero. No baseline at all, so it works for `ling-3.1-flash-free` where the
  baseline is missing.
- **What it breaks — demonstrably, and fatally:**

| | median | class |
|---|---|---|
| `longcat-2.5-preview-free` `minimal` | **36** | non-working |
| `space-bunny-free` `low` | 9, max 37 | working |
| `muse-spark-1.3-contributor-free` `minimal` | **38** | **working** |

A working Off at **38** tokens and a non-working candidate at **36** tokens. **The two
populations overlap by two tokens.** No absolute cut separates them. This is not a
threshold-tuning failure; there is no cut.

### 4 — "Some" and "none" as one class

This is discriminator #3 with an arbitrary `N` instead of a stated one, and it inherits
the identical 36-vs-38 collision. Unusable, and worse than #3 because the arbitrariness
is hidden inside a natural-sounding phrase.

### 5 — Ratio against the model's lowest observed non-off sample

Requires sweeping the ladder to find the floor, then comparing against it. Rejected: the
candidate *is* usually the lowest sample, so it is circular, and a ladder sweep is the
quota cost we already refused (≈80 requests/day).

### 6 — A statistical test on the two distributions (Mann-Whitney / rank separation)

Rejected, and instructively. `longcat`'s `minimal` samples are `[36, 36, 36, 36]` and its
omitted samples are `[36, 45, 77]` — these are **almost perfectly rank-separated**, and
the test would return "significantly different, the candidate works". The model plainly
still reasons at 36 tokens. **Rank separation is not the same as reaching the floor**, so
a significance test answers a question we are not asking.

---

## 2. Recommendation, boundary, and margin

> **A candidate is `none-works` iff `median(candidate) ≤ 0.43 × median(omitted)`.**
> Classify once per round from the median of 3 samples. Never per-sample.

### The measured populations

Machine-derived from `.scratch/probe/` (`results-*`, `responses-results-*`,
`liveness-results-*`, plus the lead's in-flight tallies).

**Working Off candidates:**

| model | omitted samples | base med | candidate | samples | cand med | **ratio** |
|---|---|---|---|---|---|---|
| `nemotron-3-ultra-free` | 12, 40, 49 | 40 | `none` | 0 ×6 | 0 | **0.000** |
| `nemotron-3.5-lightning-free` | 30 | 30 | `none` | 0, 0, 0 | 0 | **0.000** |
| `mimo-v2.6-flash-free` | 0, 8, 13, 37 | 10.5 | `none` | 0, 0, 0 | 0 | **0.000** |
| `mimo-v2.5-free` | 16 | 16 | `none` | 0 | 0 | **0.000** |
| `big-pickle` | 14, 16, 55 | 16 | `minimal` | 0,0,0,0,8,8 | 0 | **0.000** |
| `muse-spark-1.2-contributor-free` | 231 | 231 | `minimal` | 47 | 47 | **0.203** |
| `muse-spark-1.3-contributor-free` | 166, 184 | 175 | `minimal` | 38 | 38 | **0.217** |
| `space-bunny-free` | 35, 36, 42, 55 | 39 | `low` | 0, 0, 9, 22, 37 | 9 | **0.231** |

**Non-working:**

| model | base med | candidate | samples | cand med | **ratio** |
|---|---|---|---|---|---|
| `longcat-2.5-preview-free` | 45 | `minimal` | 36, 36, 36, 36 | 36 | **0.800** |
| `longcat-2.5-preview-free` | 45 | `low` | 36 | 36 | **0.800** |
| `longcat-2.5-preview-free` | 45 | `none` | 36, 71, 71, 80 | 71 | **1.578** |
| `big-pickle` | 16 | `none` | 37, 51, 119, 227, 370, 388 | 173 | **10.813** |

### The bracket and the boundary

```
highest ratio that WORKS      0.231   (space-bunny low)
lowest  ratio that FAILS      0.800   (longcat minimal)
                     gap      (0.231, 0.800)
geometric midpoint  sqrt(0.231 × 0.800) = 0.430
margins   0.430 / 0.231 = 1.86x above the highest working
          0.800 / 0.430 = 1.86x below the lowest non-working
```

**Symmetric 1.86× on both sides.** `0.43` is the maximum-margin cut in log space, and
because the two margins are equal by construction, the cost asymmetry (below) is
satisfied without moving the number.

### Where this is a judgement call, recorded as one

**The number 0.43 is derived; its admissibility is not.** The data *brackets* the
boundary — it does not determine it. Any value in (0.231, 0.800) classifies the entire
observed dataset correctly. What the data cannot say is *which* value inside that gap is
the right concept of "off".

The argument for being in that gap at all is definitional: a candidate that leaves
**more than half** of the model's default deliberation is, by any ordinary reading,
still thinking. 0.43 is where that reading becomes arithmetic.

The cost asymmetry is what breaks ties *inside* the gap, and it points the same way as
the standing invariant:

- **False "works"** → we offer an Off row, the model reasons anyway, the user is lied
  to. This is the failure the user named explicitly.
- **False "doesn't work"** → we withhold a row; the user gets the provider default and
  the model reasons normally. Nothing is false.

So on any future evidence that moves the bracket, **break toward rejection.** At 0.43 the
margins are already equal, so no adjustment is warranted today; the rule exists so the
next measurement does not get to choose symmetrically.

### Scope limit, stated plainly

This test is valid **only for the candidates the probe actually considers**: the off
spelling, and (as fallback) the lowest published level. It is **not** a general
"which level is cheapest" classifier. `nemotron-3-ultra-free`'s `high` sits at 0.35 and
its `low` at 0.40 — both inside the gap, both obviously not Off. Nothing in the design
ever asks that question, but a future ladder sweep must not reuse this threshold.

---

## 3. What this does to the fallback design

### 3.1 The baseline is free

**On every model where this classifier matters, the baseline request is already being
sent.** The existing liveness probe passes `reasoning: "low"`, and
`clampThinkingLevel` **degrades that to omission on exactly the no-ladder models** —
because `low` is nulled there, so it clamps to `off`, so `options.reasoningEffort`
becomes `undefined` and no reasoning parameter is emitted. Confirmed on the wire:
`liveness-results-off.json` records `wireReasoning` absent for the no-ladder models.

So for those models the liveness probe **is** the omitted request, and it already
observes `reasoningTokens`. The change is to **persist that number as the baseline**
rather than to spend a request.

One liveness sample per round, median over the last three rounds, is enough — and it
gives temporal robustness for free, since upstream conditions drift.

**Net extra cost: 3 candidate samples per candidate, nothing else.**

### 3.2 `big-pickle` converges — three rounds earlier

| round | `none` | verdict | `minimal` | verdict |
|---|---|---|---|---|
| 1 | median 173 / base 16 = **10.8** | `noop` | median 0 / base 16 = **0.000** | `none-works` |

Today this takes three failed concordance rounds on `none` before the fallback is even
tried, and then never converges on `minimal`. Under the new rule the `none`-switch is
**deleted**: a candidate rejected on a decisive round is abandoned immediately.

Note the robustness: `big-pickle`'s `none` samples span 37–388 and its omitted samples
span 14–55, so both numerator and denominator are noisy. The verdict survives because
`none`'s **minimum** (37) is still above `0.43 × 55 = 23.6` and `minimal`'s **maximum**
(8) is below `0.43 × 14 = 6.0`… except 8 > 6.0. At the worst baseline (14) one `minimal`
sample (8) would exceed the boundary — but the median of three does not, and the median
is what is thresholded.

### 3.3 `longcat` reaches a verdict and stops

| candidate | median / base 45 | verdict |
|---|---|---|
| `none` | 71 / 45 = **1.578** | `noop` |
| `minimal` | 36 / 45 = **0.800** | `noop` |

Candidates exhausted → **`off: null`**, the row is not offered, and the round records
`unreliable`-free, conclusive `noop`. **No spinning.** Two rounds of three samples and
it is done.

And the answer is *right*: `longcat`'s `minimal` genuinely halves its reasoning
(77 → 36), which is why a rank-based or "significant difference" test would have
accepted it. It is still reasoning. `0.800 > 0.43` says so.

### 3.4 `space-bunny` costs one request

`none` returns HTTP 400 on every attempt. A 400 with a marker-free body and a satisfied
control is **conclusive `rejected` at n=1** under the existing rule — no magnitude test,
no baseline, no fallback. Its working candidate `low` (ratio 0.231) is only ever
measured if we want to report the ladder, which we do not.

---

## 4. Failure modes and guards

| # | failure | guard |
|---|---|---|
| **F1** | **Overstated denominator** → a working Off is rejected → real capability buried. | Median of ≥3 omitted samples, carried forward across rounds. Additionally: if a candidate is rejected, re-check against the **max** baseline seen; only reject if it fails against *every* observed baseline. Costs nothing — the samples already exist. |
| **F2** | **Understated denominator** → a lying Off is offered. The dangerous direction. | Asymmetric boundary (§2): on ambiguity, reject. Plus the ambiguity band (§5) forces a second round rather than a coin-flip. |
| **F3** | **Baseline unavailable** (the `ling-3.1-flash-free` case: every omitted request returned 429). | **Claim nothing** — `off: null`, `effort: { off: "unmeasured" }`, retried next round. See §4.1. |
| **F4** | **Baseline drifts across rounds** while the verdict is cached. | Baseline is stored with `at`; the cached verdict carries the baseline value it was decided against, and is invalidated if the new median differs by more than 2×. |
| **F5** | **The candidate's distribution is bimodal** — sometimes at the floor, sometimes not. `big-pickle`'s `none` is exactly this (37 to 388). | Median handles the central tendency; the ambiguity band in §5 catches a candidate whose median lands near the boundary, and two disagreeing rounds produce `unreliable` rather than a coin-flip. |
| **F6** | **Metric confusion**: `fledge-alpha-free`'s "omitted baseline 54" is **completion_tokens**, not reasoning_tokens. | Type the baseline field as `reasoningTokens` end to end. A completion-token baseline silently produces garbage ratios — `93/54 = 1.72` for fledge would read as "not working" for the right answer by accident. Add a test that the baseline and the candidate are read from the same usage field. |
| **F7** | **Responses channel has no baseline.** `responses-fledge` recorded no `reasoning_tokens` at all. | Same as F3: claim nothing. `fledge-alpha-free` is a ladder model under R2, so `off: null` is the correct outcome regardless. |
| **F8** | **The boundary constant drifts from the data** as models change. | Version the constant alongside the fingerprint. Any re-measurement that produces a working ratio > 0.43 **or** a failing ratio < 0.231 is a boundary violation and must be investigated before the verdict is written — not silently absorbed. |

### 4.1 "No baseline" is a reason to claim nothing — and I am not recommending the alternative

The lead's standing invariant holds here, and the reason is specific to this classifier
rather than borrowed.

The baseline's job is to normalise *non-zero* token counts across models whose
deliberation scales differ by an order of magnitude. An **absolute** threshold cannot
substitute, because §1/3 shows the populations collide at 36-vs-38 tokens. So without a
baseline there is no threshold we could pick that is safe, and picking one anyway would be
a guess about a model's scale from data we do not have.

The obvious counter-case is real and I want it on the record: **`ling-3.1-flash-free`
measured `none` → 0 reasoning tokens**, which is precisely what a working Off looks like,
and without a baseline it gets no Off row. That *is* real capability buried, and it is
the thing the user said they cannot accept.

Two things about it though:

1. **It is caused by an outage, not by a design choice.** Every omitted request for that
   model returned HTTP 429 `Endpoint is unavailable`. One more sample when the endpoint
   recovers resolves the verdict automatically, with no code change.
2. **The tempting exception does not survive scrutiny.** "Treat an exact zero as proof
   without a baseline" fails on the model it would be built for: `big-pickle`'s `minimal`
   produced `8` on two of six samples, so *zero* is not a value that model reaches
   reliably — `minimal` is its floor, but the floor is not always literally 0. A rule
   "zero without a baseline counts" would be a rule built on one sample of one model,
   and it would fail the moment the next model is noisy near zero.

**Recommendation: `off: null`, retried next round, and the panel says "unmeasured" rather
than "unsupported"** so the distinction between "we could not ask" and "we asked and it
did not work" survives to the user. If the lead wants the zero-exception, it should ship
as an explicitly-flagged `Off-unverified` state rather than as a silent acceptance.

---

## 5. Does three-sample concordance survive?

**No. It has to be re-derived, and the replacement is better founded.**

Concordance was designed to reject *flip-flopping* candidates — a candidate that
sometimes works and sometimes does not. That instinct is right, and the lead's evidence
for keeping it is correct: `big-pickle`'s `none` being accepted on six of nine requests
is a genuine inter-request flip that a better classifier does **not** fix.

But concordance is the wrong *mechanism* for it. It asks whether three per-sample
verdicts agree, which is a statement about the variance of a binary variable, and with a
classifier that flips on an 8-vs-0 difference it measures the classifier's fragility
rather than the model's. It also costs three full rounds before it will switch candidates
— and on `big-pickle` it never finishes.

**Replacement: classify the median once per round, and re-test only when the verdict is
not decisive.**

```
candidates = ["none"]  (or the lowest published level as the fallback)
for each candidate:
    samples = 3 requests this round
    ratio   = median(samples) / baseline_median          // 1 request, already sent by the liveness probe
    if |log(ratio / 0.43)| > log(1.5):                   // decisive: outside [0.287, 0.645]
        verdict = ratio <= 0.43 ? "none-works" : "noop"
        break                                            // committed, one round
    // ambiguous: the median landed near the boundary
    repeat once (3 more samples)
    if the two rounds disagree: verdict = "unreliable" ; break
```

**Why this is better founded:** it puts the stability requirement on the *statistic that
is actually thresholded*. Concordance tested a quantity (per-sample agreement) that the
decision does not use.

**Every case in the observed dataset is decisive**, so the second round is never spent
today:

| ratio | band | rounds |
|---|---|---|
| 0.000, 0.203, 0.217, 0.231 | decisive (≤ 0.287) | 1 |
| 0.800, 1.578, 10.813 | decisive (≥ 0.645) | 1 |

The band exists for models whose medians land near 0.43, which none do yet.

**`unreliable` is a first-class outcome and it stops the fallback.** If a candidate is
ambiguous twice, we do not try a further candidate: the model's behaviour is not stable
enough to measure a second one against. Verdict `unreliable` → `off: null`, which claims
nothing. Guarded by: `unreliable` is only ever written from two genuine rounds, never
from one.

---

## 6. Residual risk

- **The bracket is n-thin at both edges.** `space-bunny low` (0.231, the upper edge) is
  n=4 candidate / n=4 baseline; `longcat minimal` (0.800, the lower edge) is n=4 / n=3.
  `muse-spark`'s ratios rest on **n=1** candidate samples. The lead's in-flight
  `big-pickle minimal` and `longcat minimal` sampling targets exactly the lower edge —
  good — but the upper edge is the one that is under-sampled.
- **Every ratio is a median of small samples.** With n=3 the median is the middle order
  statistic; its sampling distribution is wide, and the ambiguity band exists for that
  reason. A model whose true ratio sits near 0.43 will flip between rounds by
  construction.
- **`muse-spark-1.3` and `muse-spark-1.2` are the responses channel**, where reasoning is
  observable only through `usage.output_tokens_details.reasoning_tokens` and, per the
  lead, is unreliable at tiny budgets. Both ratios come from n=1 samples at
  `maxTokens: 1024`.
- **The baseline for `big-pickle` swung 55 → 16** as samples accumulated. The verdict
  survived it, but a model whose candidate is *not* at zero could have flipped. This is
  the strongest single argument for F1's "reject only if it fails against every observed
  baseline".
- **`ling-3.1-flash-free` has no baseline** and will therefore carry no Off row until its
  endpoint answers. Correct under the invariant, and a real capability withheld — §4.1.

---

## 7. Implementation shape, for the record

```ts
/** A candidate reaches the floor when it leaves at most this fraction of the
 *  model's own measured deliberation. See §2 — the number is the maximum-margin
 *  cut in log space between the measured working and non-working populations
 *  (0.231 / 0.800). Admissibility of any cut inside that gap is a judgement
 *  call; break toward rejection, because a false "works" is a lie and a false
 *  "doesn't work" is merely unhelpful. */
export const OFF_FLOOR_RATIO = 0.43;
/** Outside this band the verdict is committed on one round; inside, one more
 *  round is spent before anything is written. */
export const OFF_AMBIGUITY_BAND = 1.5;
export const OFF_SAMPLES_PER_ROUND = 3;

export type OffVerdict = "none-works" | "noop" | "rejected" | "unreliable" | "unmeasured";

export function classifyCandidate(
  candidate: readonly number[],
  baseline: readonly number[],
): OffVerdict {
  if (candidate.length === 0 || baseline.length === 0) return "unmeasured";   // F3 — claim nothing
  const ratio = median(candidate) / Math.max(1, median(baseline));
  return ratio <= OFF_FLOOR_RATIO ? "none-works" : "noop";
}
```

Persisted per model id alongside `ProbeRecord.api`, in the same additive shape already
specified in `final-change-list.md` §3 — `CACHE_VERSION` stays 1 — with the baseline
stored as its own measurement (`{ tokens, n, at }`) and the verdict recording the
baseline value it was decided against, so F4 can invalidate it.