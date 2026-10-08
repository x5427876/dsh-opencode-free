# Termination: the terminal state for an effort verdict that will not settle

**Owner:** align-design · **Design only — `src/` and `tests/` untouched.**
**Structural gap in the probe round**, dependent on `threshold.md` (it assumes the
median-of-3 classifier; where this document and the shipped code disagree, the shipped
code's per-sample concordance is what is being removed).

---

## 0. The gap, and how much of it is real

The lead's framing: a model whose samples never agree never persists anything and never
stops, alternating candidates forever at one request per model per round.

**A large part of this is an artifact of the classifier, not of the state machine.** The
current design classifies each **sample** as `none-works`/`noop` and requires three
agreeing samples. A classifier that flips on an 8-vs-0 difference cannot produce
agreement, so the loop does not merely mis-conclude — it never concludes. Adopt the
median-of-3 classifier from `threshold.md` and the per-sample agreement test disappears
entirely: one round yields **one** verdict from the median, and there is nothing left to
fail to agree.

What survives is exactly one residual case: **a ratio that lands inside the ambiguity
band**, where the first round is not decisive.

> **The band case occurs zero times in the measured data.** Every observed ratio is
> 0.000–0.231 (working) or 0.800–10.813 (non-working). None is inside
> `[0.287, 0.645]`.

That fact should govern the design. The termination machinery is for a case we have
never observed, so it should be **generous with rounds** (the case is rare, and a rare
case deserves the benefit of the doubt) while still **hard-bounded** (the case is by
definition the unbounded one). Those two pull in opposite directions and the design has
to satisfy both.

**And the two observed unreliable models terminate without needing the band rule at
all**, for two different reasons:

| model | instability | how it terminates |
|---|---|---|
| `big-pickle` `none` | HTTP 400 on 3 of 9, reasoning present on every 200 | any control-satisfied 400 is **conclusive `rejected` at n=1** (existing rule) → advance to the fallback → `minimal` ratio 0.000 → `none-works`. **Round 1.** |
| `longcat-2.5-preview-free` | none — behaviour is *stable* and simply not a floor | ratio 0.800 / 1.578, both **decisive** → committed on the first round. **No spin.** |

So the genuinely unbounded case — a stable model whose ratio sits inside the band — is
**hypothetical**. It still needs a terminal state, because "hypothetical" is how
unbounded loops are born.

---

## 1. The terminal state

### What it is

> **`unreliable` — a fourth member of the effort verdict vocabulary, meaning: "we
> measured this model's Off candidates and its behaviour does not settle into a verdict
> we are willing to act on."**

It **claims nothing about capability**. `map.off` stays `null`, exactly as for `noop`.
The user sees no Off row and falls back to the host's provider-default row.

### New field, not an encoding of `effortDiscord`

The lead asked me to argue this. My answer: **a new verdict value**, because the existing
three are claims about a *candidate* while `unreliable` is a claim about the *model's
stability*, and "the ladder is exhausted" is model-level state.

Encoding it — e.g. `effortDiscord: "exhausted"`, or `effortQuestion: null` — is
tempting because it adds no vocabulary. It costs more than it saves:

- Every consumer would write the same special case: `if (discord === "exhausted") …`.
  That is the **two-authorities shape that produced the Off bug** in the first place —
  one field meaning "this value" and another meaning "the ladder is done" forces a
  reader to know both before they can answer the only two questions anyone asks:
  *what should I show* and *should I keep asking*.
- `effortDiscord` is a **counter**. Overloading it with a sentinel makes "how many
  discordant rounds" unanswerable, and that number is exactly what the invalidation rule
  (§3) needs.

```ts
readonly effort?: {
  /** "none-works" | "noop"   — a candidate was decisively classified.
   *  "rejected"              — a candidate was refused (400 + satisfied control).
   *  "unreliable"            — no candidate settled. Claims NOTHING. off stays null. */
  readonly verdict: "none-works" | "noop" | "rejected" | "unreliable";
  /** The candidate the verdict is about; `null` = the ladder is exhausted and
   *  nothing further is asked until `until`. */
  readonly candidate: string | null;
  /** The baseline the verdict was decided against, so invalidation can tell
   *  whether the question is still the same question (see §3, F4 of threshold.md). */
  readonly baseline: number;
  readonly fp: string;
  readonly api: string;
  readonly at: number;
  /** Next eligible re-measurement. All cadence decisions read this one field. */
  readonly until: number;
};
```

`candidate: null` is the whole terminal mechanism. `planRound` gains one predicate —
`record.effort !== undefined && now() < record.effort.until` → not a target — and that
single check replaces every current "have we settled this?" branch.

### It has to be visible

`unreliable` and `unmeasured` must not collapse into one user-facing state, because the
whole opening complaint was that *"this model will never converge"* and *"we have not
looked often enough yet"* are currently indistinguishable. So the capability card gains:

```ts
readonly effortState: "works" | "none" | "unreliable" | "unmeasured";
```

This is **not** the `thinkingOff` legend I argued for dropping earlier. That one was a
label for a row the user can see; this one is a statement about **what we know**, and
it is the only thing that lets the panel say "we measured this and it does not settle"
rather than showing a shrug.

---

## 2. The trigger, with arithmetic

```
BAND          = [0.287, 0.645]      // 0.43 ÷ 1.5  and  0.43 × 1.5
BAND_ROUNDS   = 3                   // consecutive in-band rounds for ONE candidate
CANDIDATES    ≤ 2                   // "none", then the lowest published level
```

**Per candidate**

| round | samples | condition | action | requests |
|---|---|---|---|---|
| 1 | 3 | ratio outside BAND | commit verdict, advance candidate | 3 |
| 2 | 3 | outside BAND | commit, advance | 3 |
| 2 | 3 | inside BAND | continue | 3 |
| 3 | 3 | outside BAND | commit, advance | 3 |
| 3 | 3 | **inside BAND on all three rounds** | verdict `unreliable` for **this candidate**, advance | 3 |

**Per model** (≤2 candidates)

| outcome | requests | rounds | then |
|---|---|---|---|
| both candidates decisive | **6** | 2 | 0 |
| one decisive, one band-sitting | 6 + 9 | 5 | 0 |
| both band-sitting (worst case) | **18** | 6 | 0 until `until` |
| both 400-rejected | **2** | 2 | 0 |

**18 is the hard ceiling.** Today it is unbounded. After one resolving episode the
steady state is **~0 requests/day**, because every model holds a verdict whose `until`
is in the future.

### Correction to the lead's instinct: `unreliable` on one candidate must not stop the ladder

The lead's instinct was *"both candidates rejected and samples still disagree"*. I
disagree with the "stop" half for one reason: **a band-sitting candidate means the model
is stable, just near the boundary.** That is a completely different situation from a
model flipping between 400 and 200.

A stable model near the boundary can still resolve cleanly on a different level:
`none` at 0.45 (in band) while `minimal` at 0.10 (decisive) is entirely plausible and
worth taking. Refusing to advance would bury a real Off on exactly the model we most
want to characterise. So:

> **`unreliable` is recorded per candidate and the ladder advances. Only ladder
> exhaustion is terminal.**

The lead's instinct is right about the *shape* — you do need both candidates resolved —
and I am correcting only where it stops.

### What the band test actually catches

It is not "the model is unstable". It is **"the model's ratio is near 0.43, so a sample
of 3 cannot tell working from not-working with confidence."** That is a statement about
our measurement, not about the model, which is why `unreliable` claims nothing about
capability and why the 14-day TTL (§3) is short.

### The asymmetry, quantified

| | cost |
|---|---|
| **stop too early** | the model is written off for up to `until` (14 days) with no Off row. The user gets the provider default, the model reasons normally, **nothing is false anywhere**. |
| **stop too late** | +3 requests per model per round, from a bucket shared per egress IP. With 10 models: **+30/day**, indefinitely. |

The second is unbounded and the first is bounded, so the ceiling must exist. But
`BAND_ROUNDS = 3` is set by the other side of the ledger: it gives a borderline-working
model **three chances to be recognised** before being written off. Given that a false
accept is a lie and a false reject is merely unhelpful, spending three rounds to avoid
the lie is the right side to err on — and since no observed model reaches the band, the
three rounds cost nothing on the set we can actually see.

---

## 3. Invalidation

### The rule

| verdict | TTL | reset to now on an upstream incident for this model? |
|---|---|---|
| `none-works`, `noop`, `rejected` | **30 days** | **No** — it was a conclusive answer |
| `unreliable` | **14 days** | **Yes** |

**Incident arm, defined precisely.** The declaring rounds saw, for this model id, any of:
an HTTP 429, 500, 502, 503; a transport failure or timeout; or the model absent from the
Zen `/models` gate.

Plus the standing fingerprint arm, which applies to every verdict equally: a
`reasoning_options` fingerprint change or a channel change voids it
(`final-change-list.md` §3), because the verdict answers a question about a declaration.

### Why hybrid, and the evidence for the incident arm

The lead asked whether this should be time-based, fingerprint-based, or something else,
and whether there is evidence. There is direct evidence for the incident arm, and it is
the reason a TTL alone is not enough:

| observation | file | what it shows |
|---|---|---|
| `ling-3.1-flash-free` — 3 × HTTP 429 `Endpoint is unavailable`, later 200s | `results-run1.json`, `results-merge2.json` | a per-model upstream outage that clears on its own |
| `big-pickle` — 4 × HTTP 500 across one boundary run | `results-boundary.json` | a per-model transient inside a single measurement window |
| `big-pickle` `none` — HTTP 400 on 3 of 9 | `results-confirm.json`, `results-r5a2.json`, `results-merge.json` | per-model flapping across rounds |

**Time alone cannot distinguish "this model is unstable" from "upstream was sick that
week."** A 14-day TTL starting inside a bad week would write off a model for a fortnight
on the strength of someone else's outage. The incident arm catches that, and it costs
nothing — the round already classifies every sample, and `ProbeResult.marker` already
exists for gate markers.

**Fingerprint alone is useless for this verdict.** `unreliable` is a claim about runtime
behaviour, not about what models.dev published. A record whose `reasoning_options` never
changes can still go from stable to unstable, so the fingerprint will not fire, and a
verdict that can only be invalidated by an upstream data change is a permanent verdict.

### Recovery

When `until` passes, the model re-enters the ladder at candidate 1 with `effort` cleared.
A decisive result supersedes immediately. There is no path by which a model stays
written off while being asked — `planRound` reads `until`, and `until` is the only gate.

---

## 4. Is this the right shape?

The lead asked me to weigh terminal state against rate-limiting-forever. My answer is
that **they are not alternatives — they are orthogonal, and I want both**:

- the **verdict** is what the user and the panel read;
- the **TTL** is the rate limit.

A 14-day TTL on an `unreliable` verdict *is* "ask weekly instead of daily". Recording the
verdict on top of it is what turns a throttle into a statement.

| | terminal verdict + TTL | rate-limit forever |
|---|---|---|
| cost ceiling | **hard: 18 requests** | unbounded: 0.43/day/model, per model, forever |
| recovers from a transient | via the incident arm, else ≤ `until` | automatic, ≤ 1 week |
| **distinguishes `unreliable` from `unmeasured`** | **yes** — the stated requirement | **no**, and never will |
| tells the user anything true about the model | yes | no |
| risk of burying a real Off | up to 14 days, then retried | none |
| risk to the shared bucket | none after terminal | slow, unbounded, shared per IP |

**Weakest case for my shape:** if upstream incidents were common and *never flagged* by
the round, a model that has become stable again waits up to 14 days. Mitigated by
defining the incident arm generously — I would include a plain `400` that is *not*
attributable to the candidate in the incident set, because the measured 400s on
`big-pickle` are not cleanly separable from its flapping.

**Weakest case for rate-limiting-forever:** it is the only option that costs nothing when
the band case does not occur — which is *every* observed model — so it looks cheaper
until you notice it never converges either. It keeps the two states conflated forever,
so the panel can never say anything true, and it is the only one of the two with no
ceiling.

**Why not a third option** — "keep asking daily until it settles, but give up after K
rounds" — is simply the same thing with `unreliable` renamed to "gave up", except that
the give-up is not recorded, so the user is told nothing. That is the state we are
leaving.

---

## 5. The failure mode of this proposal, stated plainly

**If the terminal state fires wrongly**, the user selects a model that *does* have a
working Off and finds **no Off row**. The picker shows only the provider default, the
model reasons normally, every answer is correct, and **nothing anywhere is false**. The
condition clears itself at `until` — at most 14 days, sooner if an incident is flagged.

**The opposite error is the one that hurts**, and my proposal can only make it if the
band test is bypassed: offering an Off that is honoured two-thirds of the time means the
user turns reasoning off and receives **maximum reasoning** on the requests where it is
ignored — with no error, no badge, and nothing to notice. That is `big-pickle`'s actual
`none`, and it is the failure the whole design exists to prevent.

Guard: **a verdict reached from a ratio outside `[0.287, 0.645]` can never be
`unreliable`.** The band test runs only on an in-band median, so a decisive model commits
on round 1 and has no path to the terminal state. This is a test, not a convention.

**Second-order failure:** `unreliable` recorded for the wrong *reason* — say the band is
mis-tuned and a clearly-working model at ratio 0.20 somehow reaches it. That requires the
band test to run on an out-of-band ratio, which the same guard forbids. The residual risk
is a mis-tuned `OFF_FLOOR_RATIO`, and it is shared with `threshold.md`: if that constant
moves such that the bracket no longer contains a gap, both documents break together.

**Third:** the 18-request worst case is per model. If every model in the catalogue were
band-sitting, one resolving episode would cost 10 × 18 = 180 requests. No observed model
is in the band, so this is bounded by the same unobserved-case argument as everything
else — but it is the number to watch if a new model class appears.

---

## 6. Residual risk

- **The band case has never been observed**, so `BAND_ROUNDS = 3` is calibrated against
  a model that does not exist. Every other number in this chain traces to a measurement;
  this one does not, and that is stated rather than dressed up.
- **`BAND_ROUNDS` and the TTL interact.** Three rounds of cadence is three days, against a
  14-day TTL. If the daily round is ever rate-limited (the `FORCED_PROBE_MIN_INTERVAL_MS`
  floor exists for manual rounds), `BAND_ROUNDS` should be counted in *rounds*, not days
  — which is why the field is `until` (a timestamp) rather than a round counter.
- **The incident arm is coarser than it looks.** `big-pickle`'s 400s are the same status
  code as its `none` rejection, so "incident" and "candidate refused" overlap and cannot
  be separated by status alone. I am including unattributable 400s in the incident set
  deliberately: over-flagging costs one extra round of re-measurement, under-flagging
  costs a fortnight.
- **`unreliable` is not a capability claim, so nothing downstream may treat it as one.**
  The single place that applies an effort verdict is `applyMeasuredEffort`, and
  `unreliable` must map to `off: null` there — the same as `noop`. A consumer that reads
  `verdict !== "none-works"` as "offer something" would get this wrong; a test pins it.
- **Steady state is ~0 requests/day only if every model holds a verdict.** One model whose
  endpoint never answers — `ling-3.1-flash-free` on 429s — costs 0 (it is `unmeasured`,
  not `unreliable`) but is also re-asked every round. That is `threshold.md` §4.1's cost,
  and this design does not change it; it only bounds the case where samples *were*
  obtained and did not settle.