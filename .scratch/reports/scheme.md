# Capability alignment: published capability vs. actual capability

> **SUPERSEDED IN PART — see §12.** Three conclusions below were overturned by
> measurements taken after this document was written. It is kept intact as the audit
> trail; **the decision-ready document is
> [final-change-list.md](final-change-list.md)**. Where the two disagree, the final
> change list is correct.

**Owner:** align-design · **Shared task:** #3 · **Read-only on `src/`.**
**Verdict target:** after this change, does every model offer *exactly* the controls
that measurably work on it, and nothing else?

Every ladder below is **computed**, not asserted: each map was built by the rule in
§3.3 and passed through the pinned `@earendil-works/pi-ai`'s
`getSupportedThinkingLevels` / `clampThinkingLevel`, against the live models.dev
opencode section read from `$DSH_HOME/dsh-opencode-free/catalog.json` (36 free
records, 10 active). The "today" column is the same function on the map
`thinkingLevelMapFor` emits today.

**Evidence incorporated.** The A/B probe in task #1 (12/12 requests, sequential,
completions channel) established the four facts §3 leans on:

| model | published shape | omit | `reasoning_effort:"none"` | declared level |
|---|---|---|---|---|
| `nemotron-3-ultra-free` | `[]` | **49 reasoning tokens** | **0 reasoning tokens**, answer returned (115→12 completion tokens), reproduced ×2 | — |
| `space-bunny-free` | effort `low…max` | **35 reasoning tokens** | **HTTP 400 `invalid_request_error`** | `"low"` → 200, **9 reasoning tokens** |
| `ling-3.1-flash-free` | toggle | **unmeasured** — 3× HTTP 429 `Endpoint is unavailable` (upstream outage, not a gate) | — | — |
| `ling-3.0-flash-fin-free`, `longcat-2.5-preview-free` | toggle | **unmeasured** | **unmeasured** | — |

---

## 1. The invariant this scheme is built to hold

> **A control appears in the picker if and only if the plugin has positive evidence
> that selecting it changes what the model does.**
>
> Absence of evidence never widens the control set. Where evidence is missing, the
> control set is the smallest one that is *measured-correct or measured-neutral* —
> and the capability card says which.

Two corollaries the rest of this document keeps pointing at:

- **A map is not a claim, it is a claim *and* a wire translation.** pi-ai's
  `thinkingLevelMap` is `Partial<Record<ModelThinkingLevel, string | null>>`: the
  **key set** says which levels exist; the **value** says what string goes on the
  wire. Two different assertions, currently made by one code path.
- **models.dev is an approximation of a server-side allowlist nobody can read.** The
  sibling project states this more plainly than we do
  (`/tmp/oc2dsh/docs/design.md` §4: OpenCode gates on a model-schema
  `allowAnonymous` flag no client can enumerate). Everything models.dev publishes is
  a claim about that flag, not an observation of it.

---

## 2. What the code gets actively wrong today

### 2.1 `undefined` does not mean "make no claim". It means "claim everything".

`thinkingLevelMapFor` (`src/catalog.ts:170`) returns `undefined` for `[]`,
`[{type:"toggle"}]` and for an absent key, and the docstring says *"models.dev
published no level list, so make no claim"*. Both halves are wrong:

```js
// node_modules/@earendil-works/pi-ai/dist/models.js:554
return EXTENDED_THINKING_LEVELS.filter((level) => {
  const mapped = model.thinkingLevelMap?.[level];
  if (mapped === null) return false;            // only an explicit null removes
  if (level === "xhigh" || level === "max") return mapped !== undefined;
  return true;                                  // ← absent means OFFERED
});
```

`undefined` is not silence; it is the most permissive claim available. The code
knows the null-encoding rule — it uses it correctly at `src/catalog.ts:192-193` — then
declines to use it for the seven records that need it most. Seven of ten active free
models publish four levels models.dev has said nothing about.

### 2.2 The chain the lead confirmed: Off is decided in two files, and on completions it is dead

Verified end to end:

1. `openai-completions.js:524` — `const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;`
2. `openai-completions.js:713-721` — with `reasoningEffort` undefined the first branch is skipped; the **only** way anything is emitted is the else-branch, which requires `typeof model.thinkingLevelMap?.off === "string"`.
3. `src/catalog.ts:191` — `if (level === "off") continue;` → **no `off` key is ever written**.

**Therefore: on completions, selecting Off emits no reasoning field at all.** And the
plugin's `onPayload` guard (`src/zen-provider.ts:1318-1333`) inspects
`payload.reasoning.effort` — a nested object this channel never produces — so **the
guard cannot fire**. On completions it is dead code.

Combined with the measurement: omitting the field leaves `space-bunny-free` at 35
reasoning tokens and `nemotron-3-ultra-free` at 49. **Today's Off is a lie on every
completions model, and the plugin reports success because the request succeeded.**

That is the user's named worry, exactly.

### 2.3 The lever this opens

`thinkingLevelMap.off = "none"` makes **pi-ai itself** emit `reasoning_effort:"none"`
at `openai-completions.js:719`. `getSupportedThinkingLevels` still offers `off` (the
rule only removes `null`, and `xhigh`/`max`), and `clampThinkingLevel` operates on
level names, not map values — verified:

```
space-bunny-free  off:"none"  → offered ["off","low","medium","high","xhigh","max"],  clamp("off") → "off"
nemotron-3-ultra  off:"none"  → offered ["off"],                                      clamp("off") → "off"
```

So the fix is **catalogue-side**. No transport patch, no host change, no surgery on
pi-ai. The entire question is which records get `off:"none"` — and the measurement
answers it by shape.

### 2.4 A published `"none"` is silently discarded

`north-mini-code-free` publishes `[{type:"effort", values:["none","high"]}]`.
`thinkingLevelMapFor` filters values against `THINKING_LEVELS`
(`src/catalog.ts:179`), which lacks `"none"`, so it is dropped. `"none"` is not a
foreign spelling that looks odd — it is models.dev reporting that this model's effort
axis **has an off position**, and naming it. Today we read it, discard it, and keep
`off` offered for an unrelated reason.

### 2.5 The template fallback is the same bug in another field

`buildModel` (`src/catalog.ts:263-264`) falls back to `template.reasoning` /
`template.input`. `catalogTemplate()` resolves to **`mimo-v2.6-flash-free`**
(verified by running it; `mimo-v2.5-free` is gone from pi-ai 0.87's builtin set), whose
record is `reasoning: true, input: ["text","image"]`. Any free record omitting
`modalities` therefore inherits a claim that it accepts images. Not firing today
(all 36 free records publish `modalities.input`) — but *"models.dev did not tell us"*
resolved to *"inherit the most capable thing we know"* is §2.1's error in a different
field, and both get fixed together or the plugin keeps one foot in each trap.

---

## 3. The mapping

### 3.1 The control shape comes first

`reasoning_options` is not one field, it is a **control shape**, and the shape decides
what pi-ai's vocabulary can say:

| shape | free-set examples | means | expressible? |
|---|---|---|---|
| `effort` | `space-bunny-free`, `fledge-alpha-free`, `muse-spark-1.3-contributor-free` | discrete ladder of effort values | **yes** |
| `effort` incl. `"none"` | `north-mini-code-free` | a ladder **with an off member** | **yes** — §2.4 |
| `toggle` | `ling-3.0-flash-fin-free`, `ling-3.1-flash-free`, `longcat-2.5-preview-free` | binary on/off | **off only** — no bare `on` in `ModelThinkingLevel` |
| `toggle + effort` | `hy3-free` | binary *and* a ladder | **the ladder**; the toggle is subsumed |
| `toggle + budget_tokens` | `qwen3.6-plus-free` | binary *and* a token budget | **off only** (§8) |
| `[]` | `big-pickle`, `mimo-v2.6-flash-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free` | reasoning exists, no axis published | **off only** |
| absent | every `reasoning:false` record | models.dev has no opinion | **off only** |
| `reasoning: false` | `ling-2.6-flash-free`, `trinity-large-preview-free` | does not reason | **n/a** |

`toggle + effort` resolves to `effort`. Any ladder row *is* an on state, so refusing
`hy3-free`'s `low/medium/high` because a toggle is also present would bury three levels
of real capability over a control already covered — the exact failure the user is
asking us to prevent.

`[]` vs absent is empirical, not specified: in the opencode section every record with
any reasoning publication carries the key, `[]` always sits beside `reasoning: true`,
and the two `reasoning: false` records carry no key. So `[]` = *"models.dev looked and
found no selectable axis"*, absent = *"models.dev did not describe the knob"* — the
latter being the likelier publication gap. Same map, different panel text.

### 3.2 The three states of `off`, and the encoding

This is the table that makes §3.3 readable. `off` has **three** legal encodings and
they are not interchangeable:

| state | `map.off` | offered? | wire (completions) | wire (responses) |
|---|---|---|---|---|
| **`none` works** | `"none"` | yes | `reasoning_effort:"none"` | `reasoning:{effort:"none"}` |
| **nothing works** | **absent** | yes | *(nothing)* | `{effort:"none"}` → guard strips |
| **no off position** | `null` | **no** | *(nothing)* | *(nothing — pi-ai skips it)* |

Three things follow, and each is a bug if got wrong:

**(a) `off: null` and `off` absent send the same bytes and differ only in whether the
row is shown.** On responses, `openai-responses.js:264` tests
`model.thinkingLevelMap?.off !== null`, so `null` suppresses the object at source and
absent goes through the guard. Same result, two mechanisms. That is why the guard must
be a mirror of the map and never a second policy (§7).

**(b) `off: "off"` is a trap and must never be produced.** `inert` was originally
specified as `map.off = "off"` — "the row stays offered". But a **string** value is
precisely the trigger for `openai-completions.js:719` to emit the field, and `"off"` is
not a wire-valid effort value: the sibling's 2026-09-18 probe established Zen validates
`reasoning_effort` against `minimal|low|medium|high|xhigh|max|none` and **hard-400s
anything else**. So encoding "inert" as `"off"` would trade a silent lie for a hard
400. **Inert is encoded as `off` ABSENT**, where "offered" and "emits nothing" are the
same fact.

**(c) The row set is never empty — structurally, not by test.**

> `off: null` is emitted in exactly one branch (§3.3 R2), and that branch requires at
> least one published ladder level. Every other branch leaves `off` offered.
> Therefore `getSupportedThinkingLevels(model).length >= 1` always.

Running the rule across the whole free set with all three `off` states: **0 empty-list
violations.** (This is not theoretical — an earlier draft nulled `off` for `inert` and
produced `[]` for seven of ten models, i.e. the whole-catalogue empty-out rebuilt one
level up.)

### 3.3 The rule

```ts
/** models.dev effort spellings pi-ai's vocabulary lacks, and the level they mean. */
const FOREIGN_EFFORT_SPELLINGS: Record<string, string> = { none: "off" };

/** "none" works | "inert" = measured that nothing stops this model | unmeasured. */
type OffEvidence = "none-works" | "inert" | "unmeasured";

function thinkingLevelMapFor(record: CatalogRecord, off: OffEvidence = "unmeasured")
    : Record<string, string | null> | undefined {

  // R0 — not a reasoning model: say nothing at all. getSupportedThinkingLevels
  //      returns ["off"] on its own; a map here would be decoration.
  if (record.reasoning === false) return undefined;

  const published = new Set<string>();
  let hasLadder = false;
  for (const option of Array.isArray(record.reasoning_options) ? record.reasoning_options : []) {
    if (!isPlainObject(option) || option.type !== "effort") continue;
    hasLadder = true;
    for (const value of Array.isArray(option.values) ? option.values : []) {
      if (typeof value !== "string") continue;
      if ((THINKING_LEVELS as readonly string[]).includes(value)) published.add(value);
      else if (FOREIGN_EFFORT_SPELLINGS[value] !== undefined) published.add(FOREIGN_EFFORT_SPELLINGS[value]);
    }
  }

  const map: Record<string, string | null> = {};

  if (published.has("off")) {
    // R1 — the published vocabulary HAS an off member and names it. Publication
    //      decides; no probe needed.
    map.off = "none";
  } else if (hasLadder) {
    // R2 — a published effort vocabulary with NO off member. Measured: "none" on
    //      space-bunny-free is HTTP 400 invalid_request_error. The model has no
    //      off position; do not offer one. See §3.4.
    map.off = null;
  } else if (off === "inert") {
    // R3b — measured: nothing we can send stops this model. Row stays offered,
    //      nothing is sent (§3.2b). Card reads thinkingOff:"inert".
    map.off = undefined;
  } else {
    // R3a/R3c — no published ladder, and either measured good (R3a) or not yet
    //      measured (R3c). Same value: "none". See the evidence argument below.
    map.off = "none";
  }

  for (const level of THINKING_LEVELS) {
    if (level === "off") continue;
    map[level] = published.has(level) ? level : null;
  }
  return map;   // ALWAYS a map. Never `undefined` for a reasoning model.
}
```

#### Why R3 is not a guess, and why the asymmetry is the evidence

The asymmetry — `[]`/toggle gets `"none"`, a published ladder does not — is not a
convenience split. It is one A/B measurement in each direction:

- **No-ladder shape → `"none"` works.** `nemotron-3-ultra-free` (`[]`): omit → 49
  reasoning tokens; `"none"` → 0 reasoning tokens, answer returned, 115→12 completion
  tokens. Reproduced twice. And the mechanism is the same on any no-ladder model:
  there is no published effort vocabulary to collide with, so the gateway's off member
  is `"none"`.
- **Published-ladder shape → `"none"` is refused.** `space-bunny-free`:
  `"none"` → HTTP 400 `invalid_request_error`; the declared `"low"` → 200 with 9
  reasoning tokens. A model that enumerates `low…max` and omits any off member has
  told us its effort vocabulary has no off member, and the gateway agrees.

So R1 and R2 are decided by **publication** (a claim we can read), and R3 is decided by
**one measurement per shape** (a claim we had to spend quota on). `[]` and `toggle` are
one shape for this purpose because pi-ai's vocabulary cannot make us do anything
different with them — in both cases the only expressible control is the off spelling.
`toggle` is honestly **unmeasured** (3× 429 `Endpoint is unavailable`); it inherits R3c
from its sibling shape, and §5 is what converts that from an assumption into a
measurement on the first round that endpoint answers.

**What is *not* claimed.** That R3 applies uniformly to all future no-ladder models. The
A/B bought one representative per shape, and R3 says no more than that. §5 bounds the
cost of being wrong: the first probe round either confirms R3 for that id (200 with no
reasoning) or flips it to inert (R3b) and, from then on, sends nothing. The blast
radius of a wrong shape default is **one probe round, not forever** — and it is a loud
failure (HTTP 400 on a parameter) rather than a silent one, which is the right way
round given the user has told us a silent lie about Off is what they cannot have.

### 3.4 The ladder case: why `off: null` rather than the two alternatives

For `space-bunny-free` the plugin must either send no off value, send a value the
gateway refuses, or offer nothing. Measured: omitting leaves it at 35 reasoning tokens,
`"none"` is a 400, `"low"` works at 9 tokens. The options were (a) omit, or (b) map Off
onto the lowest published level.

**Neither. `off: null` — do not offer the row at all** — is strictly better than both,
and the reason is the host's default row (Lead's third item, §3.5): DSH's picker already
prepends a **provider default** row whenever `defaultEffort` is absent, and the plugin
declares no `reasoning` key, so that row is permanently present. That row already means
*"send nothing"* — 35 reasoning tokens, the model's own behaviour.

- **(a) omit** therefore gives the user **two picker rows that produce byte-identical
  payloads**: "Off" and "provider default" both send nothing and both get 35 tokens.
  That is the fake-control failure in its purest form — two rows, one behaviour, and
  the one labelled *Off* is the one that lies about stopping.
- **(b) map Off onto `"low"`** gives one row labelled *Off* that produces 9 reasoning
  tokens. The user asked for none and got some. It is a better lie, not an honest row.
- **`off: null`** gives **five honest rows plus the host's default row**: `low` (9
  tokens), `medium`, `high`, `xhigh`, `max`, and default (35 tokens). Every row is
  labelled for what it does, and "the model's natural behaviour" is still reachable —
  through the host's row, which is where that choice belongs.

Stale preferences degrade safely, verified: `clampThinkingLevel(space-bunny-free,
"off") → "low"`. A user whose saved setting was `off` lands on the cheapest level
(9 tokens, measured) rather than on 35. **The fix improves the stale-preference path
rather than regressing it.**

On `muse-spark-1.3-contributor-free` (responses) the change is **picker-only and
wire-identical**: with `off: null`, `openai-responses.js:264` skips the reasoning object
outright; today the guard deletes it after the fact. Same bytes on the wire, one
lie removed from the picker.

> **Invariants to pin as tests:**
> 1. `getSupportedThinkingLevels(model).length >= 1` for every record, in every
>    `OffEvidence`. — the empty-out guard, one level up.
> 2. No two offered rows produce the same wire payload. — the "two rows, one payload"
>    guard.
> 3. The map a record produces contains **no string value other than a published level
>    name or `"none"`**. — the `"off"-is-a-400` guard (§3.2b).

### 3.5 The scheme depends on the host's provider-default row — say so

DSH's picker prepends a **provider default** row whenever `defaultEffort` is absent.
The plugin declares no `reasoning` key, so that row is permanently present today. It
is not decoration: **it is the only control that means "send no reasoning parameter"**
in a vocabulary whose `off` means something else. The plugin cannot supply this row
itself — pi-ai's level set has no member for "the host sent no level at all", and `off`
is precisely that member, which is the whole problem this document exists to fix.

Consequences, stated rather than assumed:

- **For the 7 no-ladder models** the plugin contributes exactly one row (`off`, wired to
  `reasoning_effort:"none"`, measured to stop reasoning). The host's default row is what
  keeps *"reason at the model's natural level"* reachable. Without it, those models
  invert: the only selectable behaviour would be **not reasoning** on a model whose
  defining capability is that it reasons.
- **For ladder models** the default row is what lets `off: null` be honest (§3.4) — it
  supplies the "send nothing" destination that R2 declines to fake.
- **If a future DSH suppresses the default row**, no-ladder models lose their natural
  reasoning level entirely, and the plugin has no way to restore it. That is a
  host-regression tripwire, and the honest mitigation is a pin in
  `tests/compatibility.test.mjs` that fails loudly if the plugin is ever shipped
  against a host that does not render the row — **not** a silent fallback.

### 3.6 The table

`off` column: `none` = sends `reasoning_effort:"none"` · `—` = `null`, not offered ·
`absent` = offered, sends nothing. Verified by running `clampThinkingLevel(m,"low")` per
row: on no-ladder models the existing probe's hardcoded `"low"` clamps to `"off"` and
degrades to omission, which makes it a ready-made control (§5.3).

| model | shape | published effort | `off` | **shipped offered set** | today | after `inert` |
|---|---|---|---|---|---|---|
| `nemotron-3-ultra-free` | `[]` | — | `"none"` | `off` | `off, minimal, low, medium, high` | `off` (sends nothing) |
| `nemotron-3.5-lightning-free` | `[]` | — | `"none"` | `off` | `off, minimal, low, medium, high` | `off` (sends nothing) |
| `mimo-v2.6-flash-free` | `[]` | — | `"none"` | `off` | `off, minimal, low, medium, high` | `off` (sends nothing) |
| `big-pickle` | `[]` | — | `"none"` | `off` | `off, minimal, low, medium, high` | `off` (sends nothing) |
| `ling-3.0-flash-fin-free` | toggle | — | `"none"` | `off` | `off, minimal, low, medium, high` | `off` (sends nothing) |
| `ling-3.1-flash-free` | toggle | — | `"none"` | `off` | `off, minimal, low, medium, high` | `off` (sends nothing) |
| `longcat-2.5-preview-free` | toggle | — | `"none"` | `off` | `off, minimal, low, medium, high` | `off` (sends nothing) |
| `qwen3.6-plus-free` † | toggle+budget | — | `"none"` | `off` | `off, minimal, low, medium, high` | `off` (sends nothing) |
| `space-bunny-free` | effort | low,medium,high,xhigh,max | `null` | `low, medium, high, xhigh, max` | `off, low, medium, high, xhigh, max` | same |
| `fledge-alpha-free` | effort | low,high,max | `null` | `low, high, max` | `off, low, high, max` | same |
| `muse-spark-1.3-contributor-free` | effort | minimal,low,medium,high,xhigh | `null` | `minimal, low, medium, high, xhigh` | same + `off` | same |
| `hy3-free` † | toggle+effort | low,medium,high | `null` | `low, medium, high` | `off, low, medium, high` | same |
| `north-mini-code-free` † | effort incl. `"none"` | none,high | `"none"` | `off, high` | `off, high` | `off, high` |
| `ling-2.6-flash-free` † | `reasoning:false` | — | *(no map)* | `off` | `off, minimal, low, medium, high` | `off` |
| `trinity-large-preview-free` † | `reasoning:false` | — | *(no map)* | `off` | `off, minimal, low, medium, high` | `off` |

† deprecated; kept in the catalogue for the probe to judge (§2 of the source docstring).

**What this changes:** seven active models lose four levels they never published. Three
models lose an `off` row that does not work (measured: omission leaves 35 reasoning
tokens). `north-mini-code-free` gains a *meaningful* `off` row for the first time — its
published `"none"` was being discarded (§2.4). **Nothing real is removed; the one row
removed everywhere was a lie.**

---

## 4. Why silence is not evidence for "supports the default ladder"

**The rejected claim.** *"models.dev published no `effort` values for
`nemotron-3-ultra-free`, therefore it accepts `minimal`–`high`."*

**What the silence is.** `reasoning_options: []` is a **populated field holding an empty
list** — not a missing key, not a parse failure. Someone constructed that array and it
came out empty. Two readings are available: *(i)* there is no effort axis and the empty
list says so, or *(ii)* the axis exists but was not enumerated. Nothing in the
observation discriminates between them, so no amount of re-reading models.dev settles
it. Only a request does.

**Why the majority reading must not be acted on.** Acting on (ii) offers four levels
whose behaviour is unknown. The failure modes are asymmetric:

- If (i) is true: the user picks `minimal` and gets `UNSUPPORTED_REASONING_EFFORT` — or
  silent acceptance with the level ignored, and the user believes they reduced
  reasoning when they did not.
- If (ii) is true and we offered only `off`: the user loses a convenience. Nothing
  breaks. The model still reasons, and the host's default row still reaches it.

**A capability you cannot demonstrate is one you are inventing.** This is the asymmetry
the plugin already reasons from elsewhere — `unknownFree()` refuses to guess
`limit.context` for an id it has never heard of: *"A wrong number is worse than a
conservative one, because a claimed context length is acted on."* A claimed reasoning
level is acted on identically. The plugin has the instinct; it does not apply it to
the field where measurement is cheapest.

**And the default ladder is not a neutral placeholder.** It is a specific claim that
these models accept `minimal`, `low`, `medium`, `high`, inherited from pi-ai's opinion
of what a reasoning model looks like. Adopting it by omission means asserting a fact
about seven models the plugin has never asked. Same failure mode as §2.5, same rule:
*an unknown is not a value.*

**The honest cost, stated so it is not lost.** If (ii) turns out to be true for some
no-ladder model, that model loses four convenience rows. That is why §5 exists: silence
is treated as **an unanswered question with a known cheap probe**, not as an answer. The
table in §3.6 is the floor, not the destination. The destination is a table where every
row is published or measured.

---

## 5. The measured fallback

### 5.1 What is measurable, and what is not

| question | measurable? | why |
|---|---|---|
| does this model answer at all? | **already measured** — `ProbeRecord.verdict` | one completion |
| which channel answers? | **already measured** — `ProbeRecord.api` | sweep both channels |
| **did that answer contain reasoning?** | **yes, free** — the control already runs | see §5.3 |
| does `reasoning_effort:"none"` stop `reasoning_content`? | **yes, one extra request** | read the stream |
| does `"minimal"` change the *amount* of reasoning? | **not affordably** | paired comparison ×4 levels ×10 models ≈ 80 requests/day off a bucket shared per egress IP — **7× the existing round** |

**So the fallback measures exactly one thing: whether the off spelling works on this
model.** That is not timidity; it is where the ambiguity actually is. Ladder rows are
*published* claims and the guard for a wrong published claim is to follow the
publication. Only the `off` row depends on something models.dev never states.

### 5.2 Cost

One extra request per **no-ladder reasoning model** (R3 — the only rows whose value is
not decided by publication): **7 of the 10 active free models**, on a round that
already costs ≤34, at most once per local calendar day, only for models the user has
switched on, through the existing `probe` transport seam — so no second network path
and no second identity/header owner. It shares the liveness probe's *result handling*,
not its *request*: entangling "is it alive" with "does Off work" makes one answer two
assertions, and a 403 on a gated IP would then become a statement about the model.

### 5.3 The control — and it is already being paid for

The decisive methodological problem: **an off-spelling response containing zero
reasoning tokens proves nothing**, because the model might not have thought on that
prompt anyway. The off-spelling answer is only interpretable against a baseline that
*did* reason.

The existing liveness probe is already that baseline, and it is already sending the
right thing. `src/zen-provider.ts:1108` hardcodes `reasoning: "low"`, and
`openai-completions.js:523` runs it through `clampThinkingLevel`:

- On a **ladder** model (`space-bunny-free`), `"low"` is offered → emits
  `reasoning_effort:"low"` → **9 reasoning tokens** (measured). A perfect baseline.
- On a **no-ladder** model (`nemotron-3-ultra-free`), `"low"` is nulled → clamps to
  `"off"` → emits **nothing** → **49 reasoning tokens** (measured). Also a perfect
  baseline, arrived at by accident.

The hardcoded `"low"` is, after clamping, *"the cheapest thing this model will
actually reason at"* — which is exactly the control the comparison needs. **The fix is
to have the existing probe report `sawReasoning: boolean` alongside `hasAnswer`, at
zero additional quota.** Today it only checks that a reply arrived, so it sees 49
reasoning tokens and discards them.

> **Conclusiveness rule:** an off-spelling result is conclusive **only if the same
> round's control request for that id observed `reasoning_content`**. If the control
> saw none either, "no reasoning in the off response" is uninterpretable → inconclusive.

This also retires the hardcoded `"low"` as an accident: replace the literal with
`getSupportedThinkingLevels(model)`'s lowest non-`off` member, so the control states its
intent rather than relying on the clamp.

### 5.4 Conclusive vs. inconclusive

Let `R` = `reasoning_content` deltas in the off-spelling response, `T` = non-empty text
arrived, `C` = the same round's control saw reasoning, `K` = the same round produced an
`ok` liveness verdict (C ⇒ K, so `C` is the stronger form and is the one to require).

| observed | verdict | written? |
|---|---|---|
| 200, `R === 0`, `T`, **`C` true** | **`none` confirmed** — the spelling stops reasoning | ✅ `off:"none"` |
| 200, `R > 0`, `T`, **`C` true** | **`inert` confirmed** — nothing stops this model | ✅ `off:"inert"` → R3b |
| **400 `invalid_request_error`**, no gate marker, **`C` true** | **`inert` confirmed** — *the spelling was rejected* | ✅ `off:"inert"` → R3b |
| 200, `R === 0`, `C` **false** | *inconclusive — an uninterpretable zero* | ❌ |
| 200, `R > 0`, `T` false | *inconclusive — an error masquerading as reasoning* | ❌ |
| 401 / 403 / gate marker / `FreeTierError` | *inconclusive — gated* | ❌ |
| **429 `Endpoint is unavailable`** | *inconclusive — per-endpoint outage, not a gate* | ❌ |
| 429 with `C` true | *inconclusive — rate limit, not a spelling verdict* | ❌ |
| 400 **without** `C` | *inconclusive — could be the gate* | ❌ |
| 429 / 5xx / timeout / no response | *inconclusive — could not tell* | ❌ |

**The 400 row is what makes R3 safe to ship unmeasured.** A bare 400 is genuinely
ambiguous — the gate produces 400s too. But `C` true means *the same round got a real
answer out of this model on this channel*: the IP was not gated, the model is alive,
the channel is right. The off-spelling request differs from the control in exactly one
way — the reasoning parameter — so a 400 there can only be that parameter being
refused. Conclusive, permanent, and it is the expected path the moment any toggle-shaped
model turns out to behave like `space-bunny-free`. Without it, such a model is retried
forever and never converges, and R3 would be a permanent 400 on it.

**`Endpoint is unavailable` is a third category, not the second.** It names an
*endpoint*, not an IP and not a parameter. `ling-3.1-flash-free` returned it 3/3 — an
upstream outage, which must not be recorded as a verdict, must not be retried inside a
round, and must leave the model exactly as it was. The plugin already carries a
`marker` field for gate classification; naming `endpoint-unavailable` in that
vocabulary is a small, honest extension rather than a new mechanism.

### 5.5 What must NEVER be inferred

The same trap the dead-verdict logic was hardened against (`swept`, `admissibleGate`'s
disjoint-answer rule, `probeUntrusted`), rebuilt one level up.

| never infer | from | because |
|---|---|---|
| `off: null` | any inconclusive, gated or failed off-probe | One gated IP would remove a row from **every** model at once. Off is the row the user explicitly asked to keep. A failed probe must leave the map byte-identical. |
| a ladder row (`low`, `high`, …) | a probe | Ladder rows are published claims. A measurement is not a licence to *add* one. |
| `offWire` for the other channel | a measurement on one channel | Off is `reasoning_effort` on completions and `reasoning.effort` on responses. A measurement of one is evidence about the other only by coincidence. |
| `offWire` for a changed record | a measurement of an older `reasoning_options` | The measurement is *of a claim*; if the claim changed, the answer is about a question no longer being asked. |
| "the model is dead" | any 400 on the off-probe | Gate refusals are what the existing `marker`/`swept` machinery exists for. Reuse it; do not invent a second death criterion. |

And the structural rule that makes those five impossible to violate by accident:

> **A model's `thinkingLevelMap` is written in one function from exactly three inputs —
> the models.dev record, the `OffEvidence` for that id, and nothing else. No fourth
> input, and nothing else in the codebase may mutate `model.thinkingLevelMap`.** An
> inconclusive probe returns the previous value unchanged; there is no partial write.

### 5.6 Persistence — additive, no `CACHE_VERSION` bump

```ts
export interface ProbeRecord {
  /* …verdict, at, reason?, swept?, api?… */
  /**
   * What was MEASURED about the Off control, for this id, on this channel, against
   * this exact models.dev declaration. `fp` and `api` are load-bearing: they are
   * what make a stale measurement DETECTABLE rather than permanent.
   */
  readonly effort?: {
    readonly off: "none" | "inert";   // only ever written on a conclusive answer
    readonly fp: string;               // fingerprint of reasoning_options
    readonly api: string;              // channel it was measured on
    readonly at: number;
  };
}
```

`CACHE_VERSION` stays **1**. `readCache` returns null only on a version mismatch and
otherwise tolerates absent fields, and `readProbes` rebuilds each record field by
field — so this needs `readProbes` to carry `effort` through (≈6 lines, validated by an
`isMeasuredEffort()` in the same defensive style as `isMeasuredChannel`) and nothing
else. **A bump would discard every `verdict` and `api` measurement each user has,
forcing a full re-probe round on upgrade — one day of degraded routing to store a few
bytes. Not worth it.** A cache written by an older build has no `effort`, which reads
as *unmeasured* — exactly right, and self-healing on the next round.

### 5.7 Invalidation

| trigger | effect |
|---|---|
| `fp` differs from the current record | void; re-measure. **Structural, not time-based** — the primary rule. |
| `ProbeRecord.api` differs from the measured `api` | void; re-measure. |
| `effort.at` older than `EFFORT_TTL_MS` (30 days) | re-measure. Slow-changing truth, not permanent truth. |
| a round in which the model was `inconclusive` | **do not touch it.** Leave `effort` exactly as it was. |
| the id leaves the catalogue | already pruned by `adopt()` |
| user deletes `catalog.json` | full reset; already the documented escape hatch |

```ts
export function reasoningFingerprint(record: CatalogRecord): string {
  const o = record.reasoning_options;
  return `${record.reasoning === false ? "no" : "yes"}:${Array.isArray(o) ? JSON.stringify(o) : "absent"}`;
}
```

Stable, dependency-free, derived only from the fields the measurement is *about*. A
record that gains, loses or reorders an effort value is re-measured; one that only
changes its context window is not.

---

## 6. Failure modes and guards

| # | failure | guard |
|---|---|---|
| **FM1** | **Real capability buried by a wrong map.** `toggle+effort` refused a ladder because of its toggle; a level nulled because the map came from the template. | §3.3 nulls only what was **not published**; `toggle+effort` classifies as `effort`. Template fallback removed from `input`/`reasoning` (change 6). Test: `hy3-free` keeps `low, medium, high`; `north-mini-code-free` keeps `off, high`. |
| **FM2** | **A fake level offered that the model rejects.** The seven no-publication records inherit pi-ai's default ladder. | `thinkingLevelMapFor` never returns `undefined` for a reasoning model (§3.3). `null` is the encoding and is applied to every unpublished level, including the `xhigh`/`max` absent-means-offered trap. Pinned against `getSupportedThinkingLevels` — the *offered set*, not the map shape, exactly as `tests/catalog.test.mjs:366` already does. |
| **FM3** | **A toggle that cannot be turned off.** Off offered, nothing sent, model thinks at 49 tokens, plugin reports success. | R3 (`off:"none"`) makes pi-ai itself emit the measured-correct spelling; the 400+control row (§5.4) auto-corrects any model that refuses it; R3b keeps the row and the card honest if nothing works. One map, both channels, no second authority. |
| **FM4** | **A stale measurement pinning a changed model.** | `effort.fp` + `effort.api` + 30-day TTL (§5.7). The fingerprint needs no clock and cannot miss. |
| **FM5** | **A measurement taken while gated poisoning the cache forever.** | Four brakes: only a controlled 200 or a controlled unmarked-400 writes (§5.4); the control must have seen reasoning (§5.3); `probeUntrusted` is set and nothing is written on inconclusive (`src/catalog.ts:1458-1465`); 429 `Endpoint is unavailable` is a named non-verdict. |
| **FM6** | **A measurement about the wrong channel.** | `effort.api` stored and re-checked; `applyMeasuredEffort` skips a record whose `api` disagrees with `model.api`, mirroring `applyMeasuredChannel`. |
| **FM7** | **A whole-catalogue collapse.** | The three invariants in §3.4. A catalogue-wide map change can only come from the models.dev bytes or from `applyMeasuredEffort`, both single-source and reviewable. |
| **FM8** | **Split authority over the Off wire spelling** (today's state, §2.2). | The guard becomes a **mirror of the map** (§7), not a policy. It cannot contradict it, by construction. |
| **FM9** | **`"off"` encoded as a wire value** — a 400 waiting to happen. | §3.2(b); test: no produced map contains `off:"off"` or any string outside {published levels, `"none"`}. |
| **FM10** | **The host stops rendering the provider-default row.** | §3.5 — stated as a dependency with a compatibility pin, not a silent fallback. The plugin cannot substitute the row itself. |

---

## 7. The decision, and where it lives

> **Which records get `off: "none"`?**

The A/B settled it: **every record whose models.dev record publishes no effort ladder**
(§3.3 R3), verified good on `nemotron-3-ultra-free` and unmeasured-but-inheriting on
`toggle`. Records that publish a ladder with no off member get `off: null` — measured
400 on `space-bunny-free`. Records that publish an off member get `off: "none"` by
publication.

**§3.3 is the rule. This section does not restate it**, precisely because the first
draft had a second, disagreeing copy of it, and the disagreement was the bug.

If a future measurement moves the boundary, the edit is confined to §3.3's R2/R3
conditions. The encoding table (§3.2), the invariants (§3.4), the measurement
protocol (§5.4) and the failure guards (§6) are all independent of where the boundary
sits.

### (c) The guard: narrow it on completions, make it map-aware, do not delete it

**The lead's question, answered in three parts.**

**1. On completions it is dead code — confirmed, and it should stop pretending
otherwise.** `openai-completions.js` builds a flat `reasoning_effort`; the guard reads
`payload.reasoning.effort`, a nested object this channel never produces. It has never
fired on the channel where 7 of 10 active models live.

**2. It cannot simply be deleted, because responses still needs it.**
`openai-responses.js:260-266` emits `params.reasoning = { effort: map?.off ?? "none" }`
when no effort is selected. With `off: "none"` in the map that becomes
`{ effort: "none" }` — which today's guard **deletes**, so shipping R3 without touching
the guard would have it silently undo the fix on `muse-spark`/`fledge-alpha`.

**3. The fix is to make the guard a pure function of the map.** pi-ai already passes
the model — `onPayload?: (payload: unknown, model: TModel) => …`
(`types.d.ts:78`), called as `options?.onPayload?.(params, model)` on **both** channels
(`openai-completions.js:188`, `openai-responses.js:113`). The plugin types the parameter
`model: never` and never looks at it. There is **no host change needed** to make the
guard map-aware:

```ts
onPayload: (async (payload, model) => {
  /* …caller-provided onPayload runs first, unchanged… */
  // A MIRROR OF THE MAP, not a policy. It undoes pi-ai's PLACEHOLDER
  // (openai-responses.js:262 emits `{effort:"none"}` when no level is selected,
  // and `"off"` when one is) and never undoes the MAP'S DECISION.
  // The completions channel builds a flat `reasoning_effort` and is unaffected.
  if (model?.thinkingLevelMap?.off === "none") return next;
  const reasoning = next?.reasoning;
  if (reasoning && typeof reasoning === "object") {
    const effort = (reasoning as { effort?: unknown }).effort;
    if (effort === "none" || effort === "off") {
      const { reasoning: _dropped, ...rest } = next;
      return rest;
    }
  }
  return next === payload ? undefined : next;
})
```

Consequences, all desirable:

- **The two authorities collapse into one.** Completions is decided by the map at
  `:719`; responses is decided by the map at `:262` and merely mirrored here. They
  cannot drift.
- **The `"off"` arm becomes unreachable** — under §3.3 no produced map contains
  `off:"off"` — so it is removed, with a test asserting why.
- **The existing GUARD test** (`tests/catalog.test.mjs:394`) is rewritten to assert the
  mirror: a map with `off:"none"` passes `reasoning:{effort:"none"}` through; an absent
  `off` strips it. The A/B result therefore lands as a §3.3 edit plus a test-fixture
  flip.

---

## 8. Proposed change list

1. **`type OffEvidence = "none-works" | "inert" | "unmeasured"`** — new exported type.
   Three-valued on purpose: *"not measured"* is not *"measured negative"*, and
   conflating them is what produced §2.1.
2. **`FOREIGN_EFFORT_SPELLINGS: Record<string, string>`** — new module constant,
   `{ none: "off" }`. Replaces the membership test at `src/catalog.ts:179` that
   discards foreign names.
3. **`thinkingLevelMapFor(record, off = "unmeasured")`** — rewritten per §3.3. Always
   returns a map for a reasoning model. The 30 existing call sites and tests keep
   compiling because the new parameter is optional.
4. **`reasoningControlShape(record)`** — new, extracted from `reasoningOptionTypes`:
   returns `"effort" | "opaque" | "silent"`, with `toggle+effort → "effort"`. Pure and
   exported; §3.1's table becomes code, and a future control type is classified in one
   place. `reasoningOptionTypes` stays as `channelFor`'s input.
5. **`reasoningFingerprint(record)`** — new, exported, pure (§5.7).
6. **`buildModel`** — three edits: (a) `thinkingLevelMap` from the two-arg call;
   (b) `reasoning` defaults to `false` and `input` to `["text"]` when models.dev omits
   them, instead of falling back to the template (§2.5); (c) `measured` threaded
   through `DeriveOptions`.
7. **`ProbeRecord.effort`** — new optional field (§5.6). Additive; version unchanged.
8. **`readProbes`** — carry `effort` through, validated by a new `isMeasuredEffort()`
   beside `isMeasuredChannel`. ≈6 lines; skipping it costs every user a re-probe on
   upgrade.
9. **`applyMeasuredEffort(models, probes)`** — new, mirroring `applyMeasuredChannel`:
   skips a record whose `effort.fp` or `effort.api` no longer matches, otherwise
   re-derives the map with the measured `OffEvidence`. **Two callers**, the same two
   `applyMeasuredChannel` has — the round when it records the answer, and `adopt()` on
   the warm read. Without both, the measurement survives on disk and is ignored, which
   is exactly the bug `applyMeasuredChannel`'s comment warns about.
10. **`ProbeResult`** — add `sawReasoning?: boolean` (free: it rides the existing
    request) and `effort?: "none" | "inert"`. `runProbeRound` writes `effort` only on
    `kind === "ok"` **and** only when `sawReasoning` was true for the control. The
    `inconclusive` branch at `src/catalog.ts:1458` already `continue`s before any
    write, so the new field inherits that protection rather than needing its own.
11. **`ModelCapability`** — add `thinkingOff: "works" | "inert"`, filled from the same
    measurement. This is how FM3 stays honest with no `Model` field (pi-ai's `Model`
    has no home for it) and no cache change — capabilities are derived per snapshot.
12. **`zen-provider.ts` probe** — replace the hardcoded `reasoning: "low"` with
    `getSupportedThinkingLevels(model)`'s lowest non-`off` member (§5.3), and report
    `sawReasoning`. Same bytes, stated intent.
13. **`zen-provider.ts` guard** — map-aware mirror per §7(c); drop the `model: never`
    annotation; remove the now-unreachable `"off"` arm.
14. **`zen-provider.ts` classification** — name `Endpoint is unavailable` (429) in the
    `marker` vocabulary so it cannot be confused with a gate or a parameter verdict.

### Deliberately not in v1

- **Per-level sweeps** — 7× the daily quota to re-derive rows models.dev already
  vouched for. Rejected on cost; the guard against a wrong published row is to follow
  the publication.
- **`budget_tokens`** — pi-ai *can* express it (`compat.supportsThinkingTokenBudget` /
  `thinkingTokenBudgetField` + `ThinkingBudgets`), but `detectCompat` sets both false
  for `opencode.ai` (`openai-completions.js:1278-1282`), and the budget is reachable
  only through the **same four level names the effort axis uses**. Exposing it means
  conflating budget with effort, which no source supports. Off-only; the dropped axis
  is reported on the card rather than silently discarded.
- **Persisting `effort` in its own cache section** — it belongs beside `api` and
  `verdict`, sharing their lifetime and staleness semantics.

---

## 9. Tests (existing fixture style, `tests/catalog.test.mjs`)

Pure, no network. Four records added to `modelsDict()`: a `toggle`, a `[]`, an
`effort`-with-`"none"`, and a `toggle+effort`.

| test | pins |
|---|---|
| `a map is always returned for a reasoning model` | §2.1 regression: `typeof result === "object"` for toggle / `[]` / absent / none-in-ladder / toggle+effort / toggle+budget |
| `the offered levels never include an unpublished one` | every free-set record through `getSupportedThinkingLevels`; result ⊆ published ∪ `{off}`. Assert the **offered set**, not the map — the oracle the file already uses at :366 |
| `INVARIANT: the offered list is never empty` | all records × all three `OffEvidence` values. The empty-out guard |
| `INVARIANT: no two offered rows share a wire payload` | the "two rows, one payload" guard (§3.4) |
| `INVARIANT: no string outside {published, "none"} ever lands in a map` | the `"off"`-is-a-400 guard (FM9) |
| `a foreign spelling folds onto off instead of vanishing` | `north-mini-code-free` → `{off:"none", high:"high"}`, offered `["off","high"]` |
| `toggle+effort keeps its ladder` | `hy3-free` → `["low","medium","high"]`. The FM1 guard |
| `a ladder with no off member does not offer one` | `space-bunny-free` → `["low","medium","high","xhigh","max"]` and `clamp("off") → "low"` |
| `a measurement is applied only when it matches` | `fp` mismatch → unchanged; `api` mismatch → unchanged; match → applied. FM4/FM6 |
| `an inconclusive measurement changes nothing` | `probes` byte-identical, `effort` absent, `probeUntrusted` true. FM5 |
| `400 + a control that reasoned is conclusive; 400 alone is not` | the §5.4 discriminator, in isolation from the network |
| `GUARD: the mirror passes the map's decision and strips only the placeholder` | `off:"none"` → `{effort:"none"}` passes; absent `off` → stripped; completions' flat `reasoning_effort` untouched |

---

## 10. What cannot be fixed here

**1. A bare `on` does not exist.** A `toggle` model is reasoning on-or-off and
`ModelThinkingLevel` is `off | minimal | low | medium | high | xhigh | max`. There is no
honest way to render a two-state control in a seven-state one. Complete expressiveness
needs a **host change** — an `"on"` level, or a `reasoningMode: "binary"` model flag —
not a plugin change. Until then a toggle model gets one row, and R3 makes that row the
*correct* one. This is the largest remaining gap and it is not ours to close.

**2. `toggle` is unmeasured.** `ling-3.1-flash-free` returned 3× 429
`Endpoint is unavailable`. R3 for toggle models is inherited from the `[]` shape, not
measured on a toggle model. §5 converts it on the first round that endpoint answers; if
it never answers, the model stays unmeasured and R3 stands unverified. Named, not
papered over.

**3. `budget_tokens` is unreachable on this provider** (§8). Fixable via
`Model.compat`, which the plugin does control — but only by aliasing it onto the effort
axis, which would be a fabricated claim. Needs a host-side budget channel.

**4. The dropped models.dev fields.** The catalogue maps 10 of ~19 published fields.
Which of the remaining 9 are *droppable by choice* versus *structurally inexpressible* is
task #2's finding and is deliberately not duplicated here — this document is designed so
its answer changes **change 6, one line, and nothing else**. The rule to apply to
whatever it finds: *a field with no host channel must not be misrepresented, and a field
models.dev publishes that we drop must at least be counted as dropped.* Concretely,
`muse-spark-1.3-contributor-free` publishes `["text","image","video","pdf","audio"]`,
`buildModel` filters to `["text","image"]`, and nothing anywhere says audio/video were
dropped — a user attaching an audio file gets silence. Cheap fix, no host change: carry
the dropped modalities on the capability card as `droppedInput`. Not in v1 (it is a UI
change) but it belongs on the list.

**5. A model can change behaviour between rounds.** A measured `OffEvidence` is a
sample, not a guarantee; a model behind a shared gateway can change its reasoning
semantics with no version bump. Mitigated by the fingerprint and the TTL; not
eliminated. The only client-side detector is re-probing more often than the quota
allows.

**6. Measurements are tier- and IP-specific.** Every fact in this document was measured
on the anonymous tier from one egress. The plugin stores no key identity with the
measurement, so a value recorded anonymously is assumed to hold for a keyed session —
an assumption, not a fact. Storing the tier and re-measuring on first keyed use is
**not** in v1; stated here rather than hidden.

**7. `interleaved + effort` is exercised but not asserted.** `interleaved` determines
the channel and stream parser, not the level map. A model with `interleaved` *and* an
effort ladder is the one shape this scheme has no dedicated fixture for.
`space-bunny-free` is exactly that, so the path runs in production — but a fixture
should say so rather than leave it accidental.

---

## 11. Summary

- **The table (§3.6) is computed.** Seven active models lose four phantom levels; three
  lose an `off` row that does not work; `north-mini-code-free` gains a meaningful one
  for the first time. **Nothing real is removed.**
- **The asymmetry is evidence.** `off:"none"` for no-ladder shapes is measured
  (`nemotron`: 49 → 0 tokens). `off:null` for published ladders is measured
  (`space-bunny`: `"none"` → 400). Neither is a convention.
- **Three invariants survive every path:** the offered list is never empty; no two rows
  share a payload; no string outside {published, `"none"`} ever reaches a map.
- **One rule, one copy.** §3.3 is the only statement of the mapping. §7 points at it
  rather than restating it — the first draft's disagreement between the two was itself
  the bug the lead caught.
- **The guard becomes a mirror.** `onPayload` already receives the model on both
  channels; the plugin typed it `never`. No host change, no split authority.
- **One host dependency, named.** DSH's provider-default row is what keeps "reason at
  the model's natural level" reachable on the seven models that now contribute exactly
  one row. If it goes, the plugin cannot substitute it — §3.5 says so and pins it.
- **One thing needs the host:** an `on` level for binary toggles. Everything else is a
  plugin change.
---

## 12. Superseded — what later measurements overturned, and why it matters

This section was appended after §11 was written. Nothing above has been edited; the
audit trail stays readable. Three conclusions here are **wrong**, and a fourth is
**incomplete**. The decision-ready version is `final-change-list.md`.

### 12.1 §3.3 R3 — "no published ladder ⇒ `off:"none"` by shape" is refuted

§3.3 reasoned from `nemotron-3-ultra-free` (`[]`) and generalised the no-ladder shape.
Later measurement, both models `[toggle]`:

| model | shape | omit | `"none"` |
|---|---|---|---|
| `nemotron-3-ultra-free` | `[]` | 49 reasoning tok | **0 tok — works** |
| `ling-3.1-flash-free` | `[toggle]` | 32 reasoning tok | **0 tok — works** |
| `longcat-2.5-preview-free` | `[toggle]` | 76/77 tok | **71/71 tok, HTTP 200, reasoning still present — accepted and ineffective** |
| `space-bunny-free` | effort `low…max` | 35 tok | **HTTP 400 — rejected** |

**Two models with the identical `[toggle]` shape behave oppositely. Shape cannot predict
the outcome.** §3.3's `[]`-and-`toggle`-as-one-shape assumption (and my own later
collapse of them into a single R3 default) is wrong on its own evidence: the split is
inside the shape. R3/R4 must be decided **per model id**, never by a shape lookup.

The generalisable part survives: R5 must still split, because the split is the only thing
the evidence supports — `[]` has one measured representative that works, `[toggle]` has
two that disagree, so `[toggle]` gets no shape default at all.

### 12.2 §3.3 R3b — "an inert Off keeps the row and sends nothing" is withdrawn

§3.2 reasoned that a row the model *accepts and ignores* is not a fake level, because
the request succeeds, so `off` was left offered and nothing sent. **That is the same lie
as offering a row the model rejects** — the user selects Off and the model reasons at 71
tokens either way. `longcat-2.5-preview-free` measures 76 → 71, a ~6% reduction, which
is not "off" by any honest standard.

So `off` is now only ever the string `"none"` or the value `null`. The three-state
encoding table in §3.2 collapses to two. Consequently `longcat` and the three other
toggle-family models offer an **empty** list — which §3.4's "never empty" invariant
forbade, and which is therefore **withdrawn**.

### 12.3 §3.4 — "the offered list is never empty" is withdrawn, and it was never ours to enforce

The host answers this directly, and answers it well.
`dsh-llm-pi-ai/lib/index.js:1710-1726` says omitting `reasoning` entirely *"is the
seam's way of saying the capability is unavailable, which leaves the surface offering
only the provider's default"*, and
`dsh-client-ui-model-selection/lib/client.js:568-575` builds

```js
effortChoices = reasoning === undefined
  ? []
  : [...(defaultEffort === undefined ? [{ providerDefault }] : []), ...efforts.map(...)]
```

so an **empty** `efforts` array renders exactly **one row, the provider default** — no
throw, no broken row, `resolveReasoningLevel` never reached because the only selectable
value is `undefined`, which short-circuits.

An empty offered list is the host's **designed** rendering, not an edge case. This also
settles §3.5, where I flagged the provider-default row as a dependency the plugin could
not supply: it is not a dependency at all. It is what the host renders *in place of* an
empty effort list. My §3.5 worry was the right worry about the right mechanism.

### 12.4 §7 — the guard mirror is right, but its §3.3 basis was channel-blind

§7 argued the guard must mirror the map because two files disagreed about the Off wire
spelling. That still holds, and it is now sharper than §7 could be — but §7 assumed the
map's value is channel-independent. It is not:

| `muse-spark-1.3-contributor-free`, `POST /zen/v1/responses` | result |
|---|---|
| no `reasoning` field | 200, `reasoning_tokens = 360` — **maximum** |
| `reasoning {effort:"none"}` | **HTTP 400**, `param: "reasoning.effort"`, `Supported values: [minimal, low, medium, high, xhigh, max]` |
| `reasoning {effort:"low"}` | 200, 180 |
| `reasoning {effort:"minimal"}` | 200, 68 |

`"none"` is **correct on completions and a hard 400 on responses** — the opposite
outcome for the same spelling. And on responses, **omission means maximum reasoning**,
so "no Off row" there would mean "think as hard as possible", not "nothing happens".

This is the worst instance of the failure the user named, and the current guard *is*
the cause: stripping pi-ai's deliberate `{effort:"none"}` yields a 200 with 360
reasoning tokens and a normal-looking answer. The user turns reasoning off and gets the
most of it, with nothing reporting a problem anywhere.

R1/R3/R5a therefore gain a **channel gate**: `"none"` may only be emitted when a
measurement on *that model's channel* supports it. I verified this is a no-op today —
**0 of 10** active free models reach `openai-responses` without an `effort` ladder,
because `channelFor` routes to responses only when `reasoning_options` contains an
`effort` entry. But that is an emergent property of the channel rules, not a guarantee,
so it becomes a test.

### 12.5 What did *not* change

The always-return-a-map rule (§2.1, §3.3), the fingerprint invalidation (§5.7), the
`400 + positive control` discriminator (§5.4), §4's argument that silence is not a
default ladder, and the clamp insight added later — that the clamp is pure arithmetic,
so observing `max_tokens === 1` proves `estimated > contextWindow − 4097` with no
error-body inference, and is **one-directional** because an overstated window cannot
make the clamp fire. All survive, and the clamp is why the generic-400 blindness does
not touch the context axis at all.

### 12.6 One thing §4 got right that the measurements then sharpened

§4 argued that a model publishing `[]` is a populated field holding an empty list, and
that the readings "no axis" and "axis not enumerated" are **indistinguishable from the
publication** — so only a request settles it. `nemotron`, `ling-3.1` and `longcat`
confirm this exactly: three models, three outcomes, no publication-level predictor. The
argument was right, and the measurement is what it predicted would be needed.
