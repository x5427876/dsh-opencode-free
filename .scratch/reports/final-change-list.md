# Final change list — capability alignment (effort axis + context axis)

**Owner:** align-design · **Basis:** `.scratch/reports/scheme.md` (audit trail; three parts
superseded — see §0) · **Read-only on `src/` and `tests/`; this document edits neither.**

An implementer should be able to work from this file without returning for a design
decision. Where a rule rests on assumption rather than measurement it says so **in those
words**, because that difference is what tells the reviewer where to push back.

---

## 0. What is superseded, and why

| was | now | evidence |
|---|---|---|
| scheme §3.3 R3: no published ladder → `off:"none"` by shape | **R5 split**, and R3/R4 decided **per-model** | `ling-3.1-flash-free` (`[toggle]`) → `"none"` gives 0 reasoning tokens. `longcat-2.5-preview-free` (`[toggle]`) → `"none"` gives 71/71, reasoning still present. **Identical shape, opposite behaviour.** |
| scheme §3.3 R3b: inert keeps the row, sends nothing | **withdrawn** | A row sending something the model ignores is the same lie as one it rejects. `off` is only ever `"none"` or `null`. |
| scheme §3.6: `[]` and `toggle` as one shape | **re-split** | The only measured `[]` model works; the two measured `toggle` models split. |
| scheme §1: the offered list is never empty | **empty is a permitted conclusion** | `dsh-llm-pi-ai/lib/index.js:1710-1726` — omitting `reasoning` is the seam's way of saying the capability is unavailable, leaving the provider default. `dsh-client-ui-model-selection/lib/client.js:568-575` renders exactly one provider-default row. **Designed behaviour, not an edge case.** |

Still standing from the scheme: always-return-a-map, fingerprint invalidation, the
`400 + positive control` discriminator, the guard-as-mirror principle, and §4's argument
that silence is not a default ladder.

---

## 1. Effort axis — final rule table

`off` is only ever the string `"none"` or the value `null`. Never `"off"` (a string value
is the trigger for pi-ai to emit the field, and `"off"` is not in Zen's validated set
`minimal|low|medium|high|xhigh|max|none`).

### The channel gate — a precondition on R1, R3 and R5a

> **`"none"` may only be emitted when a measurement on *this model's channel* supports
> it.** With no measurement for that channel, fall through to the `null` rows.

**Justification, measured:** on the **responses** channel `none` is **rejected**, and
omission means **maximum** reasoning.

| `muse-spark-1.3-contributor-free`, `POST /zen/v1/responses` | result |
|---|---|
| no `reasoning` field | 200, `reasoning_tokens = 360` (**maximum**) |
| `reasoning {effort:"none"}` | **HTTP 400** — `reasoning_effort 'none' is not supported for model 'muse-spark-1.3-contributor'. Supported values: [minimal, low, medium, high, xhigh, max]`, `param: "reasoning.effort"` |
| `reasoning {effort:"low"}` | 200, `reasoning_tokens = 180` |
| `reasoning {effort:"minimal"}` | 200, `reasoning_tokens = 68` |

So `"none"` is correct on completions and a **hard 400** on responses — the opposite
outcome for the same spelling. R1/R3 would have 400'd every turn on muse-spark.

**The gate is belt-and-braces, and deliberately so.** I verified that today
**0 of 10** active free models reach `openai-responses` without an `effort` ladder —
`channelFor` routes to responses only when `reasoning_options` contains an `effort`
entry, so **every responses model has a ladder by construction and R2 already covers all
of them**. R1/R3/R5a cannot fire there today. But that is an *emergent property of
`channelFor`'s tier ordering*, not a guarantee: a future change to the channel rules, or a
tier-1 pi-ai builtin routing a no-ladder id to responses, would silently put R3 on a
channel where it 400s. The gate makes it **structural**, and change 26 in §4 is the test
that keeps it that way.

### R0–R5

| row | condition | `map.off` | evidence | status |
|---|---|---|---|---|
| **R0** | `reasoning === false` | *(no map)* | Publication (`ling-2.6-flash-free`, `trinity-large-preview-free`). **Never exercised against live Zen** — both `dead`, HTTP 401. | **ASSUMPTION** |
| **R1** | published `effort` values contain an off member (`"none"` or a `FOREIGN_EFFORT_SPELLINGS` key) | `"none"` | Publication: `north-mini-code-free` = `["none","high"]`. **Never measured** — that model is `dead` (401). The spelling is inferred from the completions measurements under R3. | **ASSUMPTION on a measured mechanism** |
| **R2** | published `effort` ladder, **no** off member | `null` | **MEASURED on both channels.** completions, `space-bunny-free`: `"none"` → HTTP 400 `invalid_request_error`, declared `"low"` → 200. responses, `muse-spark-1.3-contributor-free`: `"none"` → HTTP 400 listing the ladder, `"low"`/`"minimal"` → 200. | **MEASURED, n=1 per channel** |
| **R3** | no published ladder **+** measured `none` works on this channel | `"none"` | **MEASURED, n=2, both completions.** `nemotron-3-ultra-free` (`[]`): 49 → 0 reasoning tokens, answer returned, completion 115 → 12, reproduced ×2. `ling-3.1-flash-free` (`[toggle]`): 32 → 0. | **MEASURED (completions only)** |
| **R4** | no published ladder **+** measured `none` does not work on this channel | `null` | **MEASURED**, `longcat-2.5-preview-free` (`[toggle]`, completions): 76/77 → 71/71, HTTP 200, reasoning still present — accepted but ineffective. The *rejected* variant inside the no-ladder shape is **NOT MEASURED**; the only measured 400s are R2's shape. | **MEASURED (ineffective, n=1)** |
| **R5** | no published ladder, **unmeasured** | split below | — | **ASSUMPTION, deliberately conservative** |

### R5 split by shape, because the measurements force it

| sub-row | condition | `map.off` | evidence |
|---|---|---|---|
| **R5a** | `reasoning_options` is `[]` (present, empty), unmeasured, channel = completions | `"none"` | Backed by R3's `[]` representative: `nemotron-3-ultra-free` measured 49 → 0, same shape, same spelling. |
| **R5b** | `reasoning_options` contains a `toggle` (with or without `budget_tokens`), unmeasured — **or any unmeasured model on the responses channel** | `null` | **MEASURED THAT THIS SHAPE CANNOT PREDICT:** `ling-3.1-flash-free` works, `longcat-2.5-preview-free` does not, both `[toggle]`. Plus the channel gate: responses 400s on `"none"`. |

Day-one cost, stated plainly: the four toggle-family models
(`ling-3.0-flash-fin-free`, `ling-3.1-flash-free`, `longcat-2.5-preview-free`,
`qwen3.6-plus-free`) ship with **no effort row of their own**; they render the host's
single **provider default** row. R5b knowingly under-offers for `ling-3.1-flash-free`,
where `"none"` was measured to work — the price of not being able to predict the shape.
Bounded: the existing daily probe round converts R5b → R3/R4 per id within one round.

### Empty offered lists are correct, and the host renders them

R4 and R5b yield `off:null` with every ladder level null — an **empty** offered list.
Per `dsh-llm-pi-ai/lib/index.js:1710-1726`, omitting `reasoning` entirely *"is the seam's
way of saying the capability is unavailable, which leaves the surface offering only the
provider's default"*, and `dsh-client-ui-model-selection/lib/client.js:568-575` builds
`effortChoices = reasoning === undefined ? [] : [...(defaultEffort === undefined ?
[{provider-default}] : []), ...efforts.map(...)]` — so `efforts: []` renders **exactly one
row, the provider default**. `resolveReasoningLevel` is never reached: the only selectable
value is `undefined`, which short-circuits.

Revised invariant:

> The offered list MAY be empty. Empty is reachable **only** from R4 (a measurement) or
> R5b (a deliberate refusal to guess), and it is the host's designed rendering. Empty is
> **never** produced by an inconclusive probe, a failed probe, or a catalogue-wide event.

Enforcement: `applyMeasuredEffort` writes only from a per-id conclusive record; a round
that produced no conclusive `effort` records changes nothing.

This also settles the scheme's §3.5 dependency: the provider-default row is not an
assumption we were leaning on — it is what the host renders *in place of* an empty effort
list. The plugin cannot and need not supply it.

### Resulting table (computed through `getSupportedThinkingLevels`)

| model | shape | channel | row | `off` | offered |
|---|---|---|---|---|---|
| `nemotron-3-ultra-free` | `[]` | completions | R3 | `"none"` | `off` |
| `nemotron-3.5-lightning-free` | `[]` | completions | R5a | `"none"` | `off` |
| `mimo-v2.6-flash-free` | `[]` | completions | R5a | `"none"` | `off` |
| `big-pickle` | `[]` | completions | R5a | `"none"` | `off` |
| `space-bunny-free` | effort `low…max` | completions | R2 | `null` | `low, medium, high, xhigh, max` |
| `fledge-alpha-free` | effort `low,high,max` | responses | R2 | `null` | `low, high, max` |
| `muse-spark-1.3-contributor-free` | effort `minimal…xhigh` | responses | R2 | `null` | `minimal, low, medium, high, xhigh` |
| `ling-3.1-flash-free` | toggle | completions | R3 | `"none"` | `off` |
| `ling-3.0-flash-fin-free` | toggle | completions | R5b | `null` | `[]` → host renders provider default |
| `longcat-2.5-preview-free` | toggle | completions | R4 | `null` | `[]` → host renders provider default |
| `qwen3.6-plus-free` † | toggle+budget | completions | R5b | `null` | `[]` → host renders provider default |
| `hy3-free` † | toggle+effort | completions | R2 | `null` | `low, medium, high` |
| `north-mini-code-free` † | effort incl. `"none"` | completions | R1 | `"none"` | `off, high` |
| `ling-2.6-flash-free` † | `reasoning:false` | — | R0 | *(no map)* | provider default |
| `trinity-large-preview-free` † | `reasoning:false` | — | R0 | *(no map)* | provider default |

† deprecated. **3 of 10 active models render no effort rows of their own before the first
probe round**, which is the host's intended rendering, not a defect.

---

## 2. Context axis — final rule

**C1 — models.dev's `limit.context` is the value. Always. Never substituted.** Not
band-corrected, not rounded, not biased. The declared/measured gap is real and large
(`mimo-v2.6-flash-free` 200000 vs measured 1048576; `big-pickle` 200000 vs >1048576;
`nemotron-3.5-lightning-free` 262144 vs 1000000) **and decimal-vs-binary formatting is
refuted** — `ling-3.1-flash-free` declares 262144 and is exactly right, so one
declaration is right on one model and 4× wrong on another. The band is **triage only**:
it orders measurement priority and never becomes a written value.

**C2 — the cliff.** `clampMaxTokensToContext`
(`node_modules/@earendil-works/pi-ai/dist/api/simple-options.js:4-9`):

```js
const CONTEXT_SAFETY_TOKENS = 4096, MIN_MAX_TOKENS = 1;
const available = model.contextWindow - estimateContextTokens(context).tokens - 4096;
return Math.min(maxTokens, Math.max(1, available));
```

On `mimo-v2.6-flash-free` (declared 200000, `maxTokens` 32000): 155k est → 32000;
186k est → 9904; 201.5k est → **1**. Confirmed.

| model | declared | measured | clamp reaches 1 at | fraction of true window |
|---|---|---|---|---|
| `mimo-v2.6-flash-free` | 200000 | 1048576 | ~195903 | ~19% |
| `big-pickle` | 200000 | >1048576 | ~195903 | <19% |
| `nemotron-3.5-lightning-free` | 262144 | 1000000 | ~258047 | ~26% |
| `ling-3.1-flash-free` | 262144 | 262144 (exact) | ~258047 | ~98% (correct) |

**Why not bias upward.** There is no recovery path — `dsh-compaction-basic` is not
installed, so DSH's reactive overflow compaction does not exist in the real deployment —
so *both* directions are locally unrecoverable, and an understated window fails
**silently**. Measured: `max_tokens: 1` → HTTP 200, `completion_tokens: 1`,
`finish_reason: "length"`, zero characters, no error anywhere. The parameter is honoured
exactly. That is the entire basis for the direction of C3, and it is weaker than a
recovery argument would have been.

**C3 — the clamp is its own detector, which is why this loop needs no error attribution.**
The clamp can only fire when `estimated ≥ contextWindow − 4097`. Therefore:

1. **A firing clamp is positive evidence of under-declaration.** An overstated window
   cannot make the clamp fire at all, so the detection is **one-directional**.
2. **The discriminator is arithmetic, not error-body inference.** "Did the clamp fire
   while `estimated < contextWindow`?" uses two numbers the plugin already holds. It is
   **not** affected by generic-400 blindness: no 400 is involved.

Signature, using fields the plugin already reads — `finish_reason:"length"` maps to
`stopReason:"length"` (`openai-completions.js:1197-1198`) and `hasAnswer()`
(`src/zen-provider.ts:976`) already reads the content:

```ts
result.stopReason === "length" && !hasAnswer(result)   // → clamp signature
```

**This fires on the production stream path, not the probe path — zero quota.**

**C4 — the self-correction.** All four must hold, on the production path:

1. `result.stopReason === "length"` **and** `!hasAnswer(result)`.
2. `estimateContextTokens(context).tokens < model.contextWindow` — the conversation had
   not reached the declared window. This separates a clamp from a legitimate exhaustion,
   and it is arithmetic.
3. `hits` has reached **2** (two consecutive observations, different requests).
4. The proposal exceeds `declared` (upward only) and is under the cap.

```ts
export function contextWindowFor(record: CatalogRecord, measured?: { raisedTo: number }): number {
  const declared = finitePositive(isPlainObject(record.limit) ? record.limit.context : undefined);
  if (declared === undefined) return 0;                       // caller keeps the template
  const cap = Math.min(declared * 4, 1_048_576);
  if (measured === undefined) return declared;                 // C1: never substitute unmeasured
  const bounded = Math.min(measured.raisedTo, cap);
  return bounded > declared ? bounded : declared;              // C4: upward only
}
```

The correction value is `max(2 ** ceil(log2(estimated + 8192)), declared * 2)` — a
*measurement record*, not a substitution from the band. C1 is untouched.

**False-positive rate, honestly: unknown and not measurable** without a ground-truth
corpus. What can be stated precisely: the clamp fires when
`estimated ≥ contextWindow − 4097`; if `estimateContextTokens` under-estimates by more
than 4097 on a request that genuinely exhausted the window, condition 2 passes and the
loop raises a window that was correct. `hits ≥ 2` roughly halves the rate from
independent noise but does nothing about correlated error. **The cap is the safety
valve:** a false positive can only make the clamp *stop firing*, converting a silent
zero-character reply into a visible upstream error or truncation. That bounded, visible
failure mode is what makes this shippable without a known error rate.

---

## 3. Capability self-reports — the two attributable error shapes

Generic 400s are byte-identical across context overflow, a nonsense
`reasoning_effort:"zzz"`, and space-bunny's `"none"` rejection (150 chars, zero
difference), so **they are not attributable**. But two error shapes *are*, because they
name a parameter and enumerate values — structurally identical to one another, and
structurally identical to the context axis's "maximum context length is N tokens":

| shape | example body | yields |
|---|---|---|
| effort ladder self-report | `param: "reasoning.effort"` + `Supported values: [minimal, low, medium, high, xhigh, max]` | the server's own ladder |
| context self-report | `maximum context length is (\d+) tokens` | the server's own window |

```ts
/** ONLY these two shapes are attributable. Everything else is an opaque 400 and
 *  follows the "inconclusive unless the control is satisfied" rule. */
export function parseCapabilitySelfReport(body: string):
  | { readonly kind: "effort-ladder"; readonly values: readonly string[] }
  | { readonly kind: "context-max"; readonly tokens: number }
  | undefined;
```

Discriminator is a predicate, not a heuristic: the body names a param path **and**
contains a bracketed value list or a `\d+ tokens` phrase. A generic 400 contains
neither.

**v1 uses these as corroboration only — they may contradict publication, never add a
capability.** Adding a level from a parsed error body would violate the scheme's §5.5
("a measurement is not a licence to add a row"), and the evidence is n=1 per channel.
The condition that would lift that restriction: **two models on the same channel whose
self-report agrees with each other and disagrees with models.dev.** Until then, a
disagreement is logged and surfaced, not acted on.

---

## 4. Ordered change list

**Files: 5.** `src/catalog.ts` (bulk), `src/zen-provider.ts`, `tests/catalog.test.mjs`,
`tests/compatibility.test.mjs`, one new `docs/adr/0005-*.md`. No `src/index.ts`, no
`src/client.js` — the `thinkingOff` card field is dropped, because with R3b withdrawn the
row's presence/absence *is* the disclosure and the host already renders the provider
default in its place.

---

**`src/catalog.ts`**

1. **NEW `type OffEvidence`** — `"none-works" | "noop" | "rejected" | "unmeasured"`.
   "Not measured" is not "measured negative"; conflating them was the original bug.
2. **NEW `const FOREIGN_EFFORT_SPELLINGS = { none: "off" }`** — replaces the membership
   test at `src/catalog.ts:179` that discards foreign names.
3. **NEW `reasoningControlShape(record)`** → `"effort" | "empty" | "toggle" | "silent"`,
   with `toggle+effort → "effort"`. Extracted from `reasoningOptionTypes`; pure,
   exported, fixture-testable.
4. **REWRITE `thinkingLevelMapFor(record, channel, off = "unmeasured")`** — R0–R5 plus
   the channel gate:
   ```
   if (record.reasoning === false) return undefined;                       // R0
   published = collect(own | FOREIGN_EFFORT_SPELLINGS) over effort values
   hasLadder = any reasoning_options entry of type "effort"
   hasToggle = any entry of type "toggle"
   measuredOk = off === "none-works" && measured on THIS channel           // the gate
   off =
     published.has("off")                       ? "none"   // R1  (gate: ladder contains "none",
                                                           //      which only occurs on completions)
   : hasLadder                                  ? null     // R2
   : measuredOk                                 ? "none"   // R3
   : off === "noop" || off === "rejected"       ? null     // R4
   : hasToggle                                  ? null     // R5b
   : channel === "openai-completions"           ? "none"   // R5a
   :                                            null;     // unmeasured on responses
   for level in THINKING_LEVELS, skip "off":
     map[level] = published.has(level) ? level : null
   return map;                                  // ALWAYS a map for a reasoning model
   ```
   The `channel` parameter is **new** and load-bearing: without it R1/R3/R5a cannot see
   that `"none"` is channel-specific. `buildModel` already computes `channelFor(record)`
   and must pass it through.
5. **NEW `reasoningFingerprint(record)`** — `${reasoning flag}:${JSON.stringify(reasoning_options) ?? "absent"}`.
6. **NEW `contextFingerprint(record)`** — `${limit.context}:${limit.output}`.
7. **NEW `isMeasuredEffort` / `isMeasuredContext`** — same defensive style as
   `isMeasuredChannel`.
8. **EDIT `ProbeRecord`** — gains `effort?` and `context?` (§5). `CACHE_VERSION` untouched.
9. **EDIT `readProbes`** — carry both through the validators, ~12 lines.
10. **NEW `contextWindowFor(record, measured)`** — C4.
11. **REWRITE `buildModel`** — five edits: `thinkingLevelMap` from the three-arg call;
    `contextWindow` from `contextWindowFor`; `reasoning` defaults to `false` rather than
    inheriting the template's `true`; `input` defaults to `["text"]` rather than
    inheriting `mimo-v2.6-flash-free`'s `["text","image"]`; `channel` threaded through.
12. **EDIT `DeriveOptions`** — `measured?: ReadonlyMap<string, ProbeRecord>`, keeping
    `derive()` pure and fixture-testable.
13. **NEW `applyMeasuredEffort` / `applyMeasuredContext`** — mirror `applyMeasuredChannel`,
    skipping any record whose `fp` or `api` no longer matches. **Two callers each**, the
    same two `applyMeasuredChannel` has: `runProbeRound` and `adopt()`. Without both the
    measurement is on disk and ignored — the exact failure its own comment warns of.
14. **EDIT `ProbeResult`** — gains `sawReasoning?: boolean`, `reasoningTokens?: number`,
    and `effort?: "none-works" | "noop" | "rejected"`.
15. **EDIT `runProbeRound`** — record reasoning observation from the control; run
    `effortProbe` for targets with no `effort` record; write `effort` **only** on
    `kind === "ok"` **and** a satisfied control **and** a passing validator. The existing
    `inconclusive` `continue` at `src/catalog.ts:1458` already blocks the write path.
16. **EDIT `adopt()`** — call both `applyMeasured*` after `applyMeasuredChannel`; drop a
    `context` record whose `raisedTo` exceeds the cap.

**`src/zen-provider.ts`**

17. **REWRITE the `onPayload` guard** — a **mirror of the map**, and specifically **not**
    a silentiser for a rejection:
    ```
    run caller onPayload first (unchanged)
    if (next?.reasoning is absent) return next;                 // R2: pi-ai emitted nothing
    if (model?.thinkingLevelMap?.off === "none") return next;   // R1/R3: the MAP decides
    const effort = next.reasoning?.effort
    if (effort === "none" || effort === "off") drop `reasoning` // R4/R5 only
    return next === payload ? undefined : next
    ```
    Drop the `model: never` annotation; pi-ai already passes the model (`types.d.ts:78`,
    called at `openai-completions.js:188` and `openai-responses.js:113`).
    **Why the clause order matters:** the current guard strips pi-ai's deliberate
    `{effort:"none"}` on responses, so selecting Off on `muse-spark` yields a 200 with
    **360 reasoning tokens — the maximum** — and a normal-looking answer. The user's
    worst-case lie: they turn reasoning off and get the most of it, with nothing
    reporting a problem. Under R2 pi-ai emits nothing for responses models, so the
    clause never fires there — but writing it so it *could not* fire there is the point.
    The `"off"` arm becomes unreachable and is removed.
18. **NEW `sawReasoning(result)` — channel-specific.** Reasoning is **not streamed on
    responses**: the observed frames are `response.created`, `response.in_progress`,
    `response.output_item.added/done`, `response.content_part.added/done`,
    `response.output_text.delta`, `response.completed`, `ping` — no
    `response.reasoning_summary_text.delta` of any kind, even with pi-ai sending
    `summary:"auto"`. So:
    - **completions** → a content part with `type === "thinking"`
      (`openai-completions.js:287`), which is what `hasAnswer()` already inspects.
    - **responses** → `usage.output_tokens_details.reasoning_tokens > 0`.
    Caveat: `reasoning_tokens` is unreliable at tiny budgets; at 1024 it has been
    consistent. The effort probe must therefore keep `maxTokens ≥ 1024` — see change 19.
19. **NEW `effortProbe(model, deps)`** — one request through the same `streamSimple`
    path, so identity and the anonymous `read`/`bash` tool gate still apply:
    clone the model with `{ thinkingLevelMap: { ...model.thinkingLevelMap, off: "none" } }`
    and call with `reasoning: "off"`. pi-ai then renders `reasoning_effort:"none"`
    (completions `:719`) or `reasoning:{effort:"none"}` (responses `:262`).
    `maxTokens: PROBE_MAX_TOKENS` (1024) — pinned by a test, because lowering it breaks
    responses-channel reasoning detection.
    Classify via `sawReasoning` / `reasoningTokens`: none seen + text → `"none-works"`;
    reasoning seen + text → `"noop"`; HTTP 400 with a **marker-free** body **and** a
    satisfied control → `"rejected"`; anything else → `inconclusive`.
20. **EDIT `probeModel`** — replace the hardcoded `reasoning: "low"`
    (`src/zen-provider.ts:1108`) with the lowest non-`off` member of
    `getSupportedThinkingLevels(model)`; report the reasoning observation. The literal
    works today only because `clampThinkingLevel` degrades it to omission on no-ladder
    models — which is exactly the control the effort verdict needs, by accident.
21. **EDIT the production stream path** — on `stopReason === "length" && !hasAnswer()`
    with `estimateContextTokens(ctx).tokens < model.contextWindow`, increment
    `context.hits`; at 2, write `raisedTo` per C4. **Zero quota.** *(Do not import
    `clampMaxTokensToContext` from pi-ai's internal path — its `4096` and `1` constants
    are not public API. Observe the outcome, not the computation.)*
22. **EDIT the marker vocabulary** — name 429 `Endpoint is unavailable` distinctly from a
    gate. It names an *endpoint*, not an IP and not a parameter; `ling-3.1-flash-free`
    returned it 3/3. It must never be recorded as a verdict.
23. **NEW `parseCapabilitySelfReport(body)`** — §3. Used to corroborate publication and
    to log disagreements. Never to add a capability in v1.

**`tests/`**

24. **NEW tests** — §5, 16 cases across the two files.
25. **REWRITE the three disproven tests** — §5.

**`docs/adr/`**

26. **NEW `docs/adr/0005-*.md`** — the always-return-a-map rule; R0–R5 with the model and
    measurement behind each row and the **channel gate**; the withdrawal of the
    inert-row rule; C1–C4 with the measured `max_tokens: 1` signature; the withdrawal of
    the recovery-path argument (`dsh-compaction-basic` not installed); the two
    attributable self-report shapes versus the opaque 400; and that the responses-channel
    conclusions rest on **one** model, `fledge-alpha-free` having returned HTTP 500 on
    all three cases plus a retry.

**27. NEW test — the channel gate's invariant.** Assert across the whole free set that
**no model reaching `openai-responses` lacks an `effort` ladder** (verified today: 0
violations), and that R1/R3/R5a therefore cannot fire there. This is what stops a future
refactor of `channelFor` from silently putting `"none"` on a channel that 400s it.

---

## 5. Tests — add, rewrite, keep

### The three that encode disproven behaviour

| test | verdict | why |
|---|---|---|
| `tests/catalog.test.mjs:386` — `assert.deepEqual(of('big-pickle'), ['off','minimal','low','medium','high'])` and `:387` `of('ling-3.0-flash-fin-free')` | **REWRITE** | `:386` asserts the outcome of returning `undefined` — the full non-opt-in ladder for a `[]` model, four levels models.dev publishes nothing for. Under R5a, `big-pickle` offers `['off']`. `:387` is the same for a toggle model; under R5b, `ling-3.0-flash-fin-free` offers **`[]`**, which the host renders as the provider default. Both become assertions about a *rule* rather than about a fallback. `:387` is the test that proves R5b end-to-end. |
| `tests/catalog.test.mjs:394` — `test('GUARD: "off" is offered but never reaches the wire')`, incl. `:404-405` | **REWRITE** | Its premise — Off is always offered and reaching the wire is always wrong — is disproven twice: `off` is `null` for ladder models (R2) and for measured-ineffective ones (R4). Replace with the mirror test: a map carrying `off:"none"` **passes** `reasoning:{effort:"none"}` through; absent or `null` `off` strips it; the flat completions `reasoning_effort` is untouched. Add the clause-order assertion: for a model with a declared ladder the guard never strips. |
| `tests/compatibility.test.mjs:1106` — `assert.equal(bodies['explicit-off'].reasoning, undefined, 'explicit "off" sends no reasoning object')` | **REWRITE** | The disproven behaviour verbatim: explicit Off sends nothing, and on responses that is **360 reasoning tokens — the maximum**. Replace with: with `off:"none"` in the map, explicit Off emits `reasoning_effort:"none"` (completions) and `reasoning:{effort:"none"}` (responses); with `off:null` it emits nothing on either. **Keep the structure** — its `fetch` stub returns a 400 to short-circuit, but it asserts only on the *outgoing body*, so it stays a valid payload-shape test despite generic-400 blindness. |

### Add to `tests/catalog.test.mjs`

| test | pins |
|---|---|
| `a map is always returned for a reasoning model` | `typeof result === "object"` for every shape — the original regression |
| `the offered levels never include an unpublished one` | offered ⊆ published ∪ `{off}` via `getSupportedThinkingLevels` |
| `INVARIANT: no string outside {published, "none"} lands in a map` | the `"off"`-is-a-400 guard |
| `R1/R2 split on the presence of an off member` | `north-mini-code-free` → `"none"`; `space-bunny-free` → `null` |
| `R5a/R5b split on [] vs toggle` | `[]` → `"none"`; `[toggle]` → `null`. The row encoding the re-split |
| `two toggle models with opposite measurements get opposite maps` | `ling-3.1-flash-free` (`none-works`) vs `longcat-2.5-preview-free` (`noop`) → `"none"` vs `null`. Same fixture shape, different verdicts |
| **`CHANNEL GATE: "none" never reaches a responses model unmeasured`** | a responses model with no ladder and no measurement → `null`, not `"none"` |
| **`no responses model lacks a ladder`** | change 27's invariant across the free set |
| `a measurement is applied only when it matches` | `fp` and `api` mismatch → unchanged |
| `an inconclusive measurement changes nothing` | probes byte-identical, `probeUntrusted` true |
| `400 + a control that reasoned is conclusive; 400 alone is not` | the discriminator, network-free |
| `a self-reporting 400 is attributed; a generic 400 is not` | `parseCapabilitySelfReport` on both shapes and on the 150-char opaque one |
| `429 "Endpoint is unavailable" is never a verdict` | marker classification |
| `fingerprints change only for their own axis` | a `limit.output` change keeps the effort record |
| `contextWindowFor never substitutes unmeasured and never lowers` | C1 + C4 |
| `C4 caps at 4x declared and 1 MiB` | the false-positive valve |

### Add to `tests/compatibility.test.mjs`

| test | pins |
|---|---|
| `the guard mirrors the map on both channels` | `off:"none"` passes; absent/`null` strips; flat `reasoning_effort` untouched; **never strips for a declared ladder** |
| `effortProbe classifies none-works / noop / rejected / inconclusive` | four verdicts through a stubbed `fetchImpl` |
| `PROBE_MAX_TOKENS stays at or above 1024` | the responses reasoning-detection floor |
| `the clamp signature raises the window only upward` | `stopReason:"length"` + `!hasAnswer` + `estimated < contextWindow` → `hits` increments; one observation is not enough |

### Keep unchanged

- `tests/catalog.test.mjs:408` — *"the muse-spark xhigh default is no longer silently
  clamped away"*, incl. `:416`, `:420`, `:422`. **KEEP**: still correct under R2;
  muse-spark keeps `xhigh` and still does not offer `off`. It is also now the strongest
  existing statement that `off:null` is compatible with a real capability.
- `tests/catalog.test.mjs:453` — `topThinkingLevel`. **KEEP**: unchanged semantics; it
  already reads only string entries, which R2/R3 preserve.
- `tests/catalog.test.mjs:425` — *"a derived record carries all four capabilities"*.
  **KEEP, with one assertion changed**: the `bare` record's `input` expectation moves from
  `template().input` to `['text']` per change 11 (the template-fallback fix).
- `tests/catalog.test.mjs:366` — *"the levels a host offers follow models.dev, per model"*.
  **KEEP the method** (assert through `getSupportedThinkingLevels`) but its `big-pickle`
  and `ling-3.0-flash-fin-free` expectations are rewritten per row 1 above.
- Every probe, gate, cache and admissibility test in `catalog.test.mjs` and
  `compatibility.test.mjs`. **KEEP**: none of them encode reasoning-map behaviour, and the
  dead-verdict/sweep/gate machinery is exactly what the inconclusive rules depend on.

---

## 6. Residual risk

**Unmeasured, and shipping anyway:**

- **R0** (`reasoning:false` → no map) — both instance models are `dead` with HTTP 401 and
  were never reachable. Untested against live Zen.
- **R1** (`"none"` inside a published ladder) — `north-mini-code-free` is `dead` (401).
  The spelling is inferred from other models, not from this one.
- **R4's "rejected" variant** — no measured 400 inside the no-ladder shape.
- **R5a generalised past nemotron** — `big-pickle`, `mimo-v2.6-flash-free`,
  `nemotron-3.5-lightning-free` all get `"none"` on nemotron's `[]`-shape evidence. A 400
  is loud and self-corrects within one round.
- **THE RESPONSES CHANNEL RESTS ON ONE MODEL.** `muse-spark-1.3-contributor-free` is the
  only responses model that answered; **`fledge-alpha-free` returned HTTP 500 on all three
  cases plus a retry** — persistently broken, no data. Every responses-channel claim in
  this document — the `"none"` rejection, the 360-token omission maximum, the ladder
  self-report, R2's `off:null` — rests on n=1. If a second responses model behaves like
  `nemotron` rather than like muse-spark, R2 is wrong for it and the failure is a 400.
- **The entire context axis.** The clamp loop's false-positive rate is unknown:
  `estimateContextTokens` has no published error bound in the pinned build and there is no
  ground-truth corpus. `hits ≥ 2` and the 4×/1 MiB cap bound the damage; they do not
  eliminate it.
- **Every measurement is one sample from one egress IP on one day.** No re-measurement
  schedule exists for the effort axis beyond the 30-day TTL.

**What a real deployment can break on:**

1. **`dsh-better-reasoning-effort` v0.5.2 — CONFIRMED PRESENT** in the web profile at
   `~/.dsh/profiles/web/node_modules/dsh-better-reasoning-effort`, with `opencode.ai` in
   its target list and an `AUTOFILL_MARKER` write into the `llm-pi-ai` namespace. It can
   **silently override every map this change produces**, and nothing in our code observes
   it. We do not control that namespace and cannot arbitrate it. Mitigation is a **startup
   diagnostic** logging when `reasoningEfforts` for `opencode.ai` is not ours, plus a
   README note — not a fight.
2. **A first-boot no-effort-rows state** for three active models until the probe round
   resolves them. That is the host's designed rendering, but a user who opens the picker
   in the first minute sees only a provider-default row.
3. **The clamp loop raising a wrong window** — bounded by the cap, but the resulting
   failure is an upstream error the user sees, where today they see silence. That trade is
   the whole justification for the direction.
4. **A 400 in production on a model placed at R3/R5a.** That falsifies the no-ladder
   default, reopens R5, and is the one failure that reaches a user before any probe runs.

**Rollback triggers — any one of these, revert:**

- The host picker misbehaves on an empty effort list. *(Now answered "safe", but the
  answer rests on one host version — re-check on any DSH upgrade.)*
- More than one model's map changes in a single `applyMeasuredEffort` call — a systematic
  event, not ten independent measurements. Add a debug assertion and refuse the batch.
- A 400 appears in production on a model at R3/R5a, on either channel.
- The clamp loop raises a window and the upstream then refuses requests that previously
  succeeded.
- `dsh-better-reasoning-effort` writes over our map and users report reasoning controls
  that match neither models.dev nor our measurements.

**Cheapest rollback: delete `$DSH_HOME/dsh-opencode-free/catalog.json`.** Every
measurement vanishes, every model falls back to R0–R5 unmeasured, and the worst case is
the state this document describes as broken today. No code rollback required.