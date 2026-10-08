# Surface report — what capability information can actually reach the user

**Scope.** Read-only. No `src/`, `lib/`, `tests/` or `package.json` was modified. Versions inspected:
pi-ai **0.87.1** (`node_modules/@earendil-works/pi-ai`), DSH `@deepseek-ai/dsh` installed tree.

**Path legend** (used throughout, every citation is `path:line`):

| Short | Absolute root |
|---|---|
| `pi-ai/` | `<repo>/node_modules/@earendil-works/pi-ai/dist` |
| `dsh-llm/` | `$DSH_HOME/dsh/node_modules/@deepseek-ai/dsh-llm/lib` |
| `dsh-llm-pi-ai/` | `…/@deepseek-ai/dsh-llm-pi-ai/lib` |
| `dsh-picker/` | `…/@deepseek-ai/dsh-client-ui-model-selection/lib` |
| `dsh-compaction/` | `…/@deepseek-ai/dsh-compaction-basic/lib` |
| `repo/` | `<repo>` |

---

## 0. Headline

1. **The `onPayload` guard is live on exactly one channel.** `openai-completions` → the guard is
   unreachable dead code. `openai-responses` → the guard fires and is load-bearing. Details in §2.
2. **DSH does not re-shape the payload.** It hands pi-ai a *level name* in `options.reasoning` and
   pi-ai does 100% of the wire shaping. There is no DSH rewrite of `reasoning_effort` or
   `reasoning.effort` anywhere. §2.
3. **A host channel for `description` EXISTS in dsh-llm's contract but is never filled by the pi-ai
   adapter** — so it is a DSH change away, not a plugin-side change. Every other dropped field
   (structured_output, tool_call, knowledge, open-weights, non-text/image modalities) has **no
   channel at any layer**. §1 and §3.
4. **Images are not silently downgraded — the request is refused.** DSH throws `UNSUPPORTED_CONTENT`
   before pi-ai's placeholder downgrade can run. §4.
5. **`contextWindow` / `maxTokens` do not bound the request at the wire.** pi-ai never truncates the
   prompt; `maxTokens` is clamped only *downward to the remaining context*, never *to
   `model.maxTokens`*. §5.

---

## 1. Channel-existence table

The plugin's surface to DSH is **not** `LlmModelInfo`. It hands DSH a pre-built pi-ai `Model` via
`ctx.llm.registerAdapter([PROVIDER_ID], new PiAiAdapter({profiles…}))` (`repo/src/index.ts:454-466`),
with the pi-ai models attached as `profile.piProvider` (`repo/src/index.ts:441`). DSH's own
`PiAiAdapter` then derives every advertised field from that pi-ai `Model`. **So a field is
reachable only if it exists in pi-ai's `Model<TApi>` first.**

`LlmResolvedModelInfo` is produced in exactly one function — `PiAiAdapter.modelInfo`:

```js
// dsh-llm-pi-ai/index.js:1821-1829
return {
    provider,
    id: model,
    name: resolvedModel.name,
    inputModalities: [...resolvedModel.input],
    context: { contextWindow: resolvedModel.contextWindow },
    ...configuredMaxTokens === void 0 ? {} : { defaultMaxTokens: configuredMaxTokens },
    ...reasoningInfo(resolvedModel, defaultLevel)
};
```

That is the complete advertised set: **six** keys. Everything else is absent.

| Capability (models.dev field) | pi-ai `Model` field? | Reaches user? | Citation / why |
|---|---|---|---|
| **name** | ✅ `name: string` | ✅ | `pi-ai/types.d.ts:807` → `dsh-llm-pi-ai/index.js:1824` |
| **description** | ❌ absent | ❌ **but host has a slot** | `dsh-llm/types/types.d.ts:311-312` declares `description?: string` on `LlmModelInfo` (*"Optional user-facing distinction from otherwise similar models"*). `PiAiAdapter.modelInfo` never sets it (`:1821-1829`) and `pi-ai/types.d.ts:805-830` has no field to source it from. **Plugin-side fix impossible; needs a DSH change.** |
| **structured_output** | ❌ | ❌ | No field in `pi-ai/types.d.ts:805-830`, none in `dsh-llm/types/types.d.ts:291-388`, none in `modelInfo`. Clean negative. |
| **tool_call** support | ❌ | ❌ | No capability field anywhere. Tools are supplied per-request via `GenerateOptions.tools`
(`dsh-llm/types/types.d.ts:508-509`, inside `GenerateOptions` at `:489`), never advertised per
model. Clean negative. |
| **temperature** support | ⚠️ not as capability | ⚠️ per-request only | `pi-ai/types.d.ts:117` `StreamOptions.temperature`; DSH forwards it (`dsh-llm-pi-ai/index.js:1883`) and pi-ai emits it **unconditionally** (`pi-ai/api/openai-completions.js:595-596`). Nothing advertises *whether* the model accepts it. The only `supportsTemperature` is an **anthropic-messages compat gate** (`dsh-llm-pi-ai/types/catalog.d.ts:229`) that is never surfaced to the picker. |
| **modalities beyond text/image** | ❌ | ❌ **two walls** | pi-ai: `input: ("text" \| "image")[]` (`pi-ai/types.d.ts:817`). DSH: `ModelModalityMap` has only `text`/`image` (`dsh-llm/types/types.d.ts:212-215`). audio/video/pdf cannot be expressed at either layer. |
| **knowledge cutoff** | ❌ | ❌ | Clean negative — grep for `knowledgeCutoff` across `dsh-llm`, `dsh-llm-pi-ai`, `pi-ai` returns nothing. |
| **open-weights flag** | ❌ | ❌ | Clean negative — grep for `openWeights` across the same trees returns nothing. |
| **contextWindow** | ✅ | ✅ | `pi-ai/types.d.ts:823` → `dsh-llm/types/types.d.ts:317-320` (`LlmModelContext`) → `dsh-llm-pi-ai/index.js:1826` |
| **maxTokens** | ✅ but **not advertised** | ❌ as capability | `pi-ai/types.d.ts:824` is used as the *default* cap (`pi-ai/api/simple-options.js:17`). DSH only emits `defaultMaxTokens` when `profile.configuredMaxTokens` has an entry (`dsh-llm-pi-ai/index.js:1827`) — and the plugin ships an **empty Map** (`repo/src/index.ts:443`). |
| **reasoning level list** | ✅ `thinkingLevelMap` | ✅ | `pi-ai/types.d.ts:816`, `:26` → `dsh-llm-pi-ai/index.js:1726-1734` → `dsh-picker/client.js:565-573` |
| **effort wire value** | ✅ free-form string | ✅ | `ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string \| null>>` (`pi-ai/types.d.ts:26`) |

**The plugin-vs-host distinction, stated plainly:**

- **Plugin's own choice, fixable today:** `description` is dropped *and* `maxTokens` is dropped
  (empty `configuredMaxTokens`). Neither is blocked by a type — they are blocked by
  `PiAiAdapter.modelInfo` not reading them, which is a DSH change.
- **Structurally inexpressible:** `structured_output`, `tool_call` capability, `knowledge`,
  `open-weights`, non-text/image modalities.

---

## 2. The wire — thinking levels end to end

### 2.1 Full chain (all five hops, all cited)

```
GenerateOptions.reasoningEffort          dsh-llm/types/types.d.ts:494
  → resolveReasoningLevel()              dsh-llm-pi-ai/index.js:1705-1709   ← HARD-FAILS, does not clamp
  → profileOptions(): options.reasoning  dsh-llm-pi-ai/index.js:1674-1678   ← "off" → omitted here
  → pi-ai streamSimple()                 dsh-llm-pi-ai/index.js:1881        ← entry point
  → clampThinkingLevel / "off"→undefined pi-ai/api/openai-completions.js:523-524
  → buildParams()                        pi-ai/api/openai-completions.js:187
  → options.onPayload(params, model)     pi-ai/api/openai-completions.js:188  ← guard runs HERE
```

### 2.2 A — Does DSH re-shape the payload? **No.**

DSH's *only* intervention is the level-name normalisation in `profileOptions`:

```js
// dsh-llm-pi-ai/index.js:1674-1678
function profileOptions(profile, reasoning, apiKey) {
    const enabledReasoning = reasoning === "off" ? void 0 : reasoning;
    return {
        ...apiKey === void 0 ? {} : { apiKey },
        ...enabledReasoning === void 0 ? {} : { reasoning: enabledReasoning },
```

`onPayload` is passed straight through from `StreamOptions` into `buildBaseOptions`
(`pi-ai/api/simple-options.js:26`). Grepping `reasoning_effort` / `reasoning` across
`dsh-llm/` and `dsh-llm-pi-ai/` yields **no request-body rewrite of any kind** — DSH never sees
the body. **This closes question A: DSH does not touch the payload.**

### 2.3 B — Is the guard dead on completions and live on responses? **Yes, exactly that split.**

The guard itself:

```ts
// repo/src/zen-provider.ts:1324-1331
const reasoning = next?.reasoning;
if (reasoning !== null && typeof reasoning === "object") {
  const effort = (reasoning as { effort?: unknown }).effort;
  if (effort === "none" || effort === "off") {
    const { reasoning: _dropped, ...rest } = next;
    return rest;
  }
}
```

**Its position is correct.** `buildParams` runs at `openai-completions.js:187` and `onPayload` at
`:188`, so the guard sees the fully-shaped body.

**It cannot fire on completions.** For `baseUrl = https://opencode.ai/zen/v1`
(`repo/src/zen-provider.ts:23`), `detectCompat` (`pi-ai/api/openai-completions.js:1218-1302`)
evaluates `isDeepSeek`/`isZai`/`isTogether`/`isAntLing`/`isOpenRouter` all **false**, so
`thinkingFormat` falls through to `"openai"` (`:1270-1280`). `opencode.ai` sets only
`isNonStandard` (`:1244`), which affects `supportsStore`/`supportsDeveloperRole` — **not**
`thinkingFormat`, and **not** `supportsReasoningEffort`, whose exclusion list (`:1262`) omits
`opencode.ai`. So the branch taken is the OpenAI-style one:

```js
// pi-ai/api/openai-completions.js:712-721
else if (options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
    // OpenAI-style reasoning_effort
    params.reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
}
else if (!options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
    const offValue = model.thinkingLevelMap?.off;
    if (typeof offValue === "string") {
        params.reasoning_effort = offValue;
    }
}
```

**`params.reasoning` is never assigned anywhere in this branch.** The only two branches that
produce a nested `reasoning: { effort }` are `thinkingFormat === "openrouter"` (`:678-689`) and
`"ant-ling"` (`:690-695`). Therefore on completions `next?.reasoning` is `undefined`, the
`typeof === "object"` test fails, and the guard returns unchanged. **Dead code on completions.**

**It IS load-bearing on responses.** `channelFor` routes `effort`-declaring models to
`openai-responses` (`repo/src/catalog.ts:213`), and there pi-ai emits the nested object:

```js
// pi-ai/api/openai-responses.js:259-262
else if (model.provider !== "github-copilot" && model.thinkingLevelMap?.off !== null) {
    params.reasoning = {
        effort: (model.thinkingLevelMap?.off ?? "none"),
    };
}
```

Because the plugin deliberately leaves `off` **absent** from the map (`repo/src/catalog.ts:191`,
`if (level === "off") continue`), `?? "none"` fires → `reasoning: { effort: "none" }` → the guard
fires and deletes it. **So: do not delete the guard. It is dead only on the channel that does not
need it.** Its comment at `repo/src/catalog.ts:152` (*"`reasoning_effort` on completions, `effort`
on responses"*) is factually correct; the guard is the responses-side half of that sentence.

### 2.4 C — Does DSH strip/override `thinkingLevelMap.off`? **No — and DSH's own docs endorse the lever.**

Two independent confirmations:

1. `thinkingLevelMap:` is **written in exactly one place** in the whole adapter —
   `dsh-llm-pi-ai/index.js:588`, inside `resolveModelReasoning`, which handles DSH's *own catalog
   entries* (those declaring `reasoningEfforts`). The plugin does not go through it: a profile's
   `piProvider` is passed **verbatim** to `models.setProvider(...)` at
   `dsh-llm-pi-ai/index.js:1767`. Nothing normalises the map afterwards.
2. DSH's documentation for that very code path describes the intended semantics of the lever:

```js
// dsh-llm-pi-ai/index.js:558-561 (doc comment)
// A declared `off` with no value is the one exception: it stays absent from the map,
// which pi-ai reads as "supported, send nothing" — the correct dispatch where not
// thinking is the parameter's absence — while `off` with a value sends that value.
```

and the construction at `:580-585` preserves a declared string value verbatim
(`else if (wire !== null) map[level] = wire;`).

So `thinkingLevelMap.off = "none"` reaches `pi-ai/api/openai-completions.js:719` and emits
`reasoning_effort: "none"`. **DSH has no competing notion of "off" to bite.** The only thing that
would interfere is the plugin's *own* `onPayload` guard — and that guard keys on
`next.reasoning`, not `next.reasoning_effort`, so it will **not** strip it. The lever is clean.

One behavioural consequence to note: with `off = "none"` the picker will show an `Off` row whose
selecting emits `reasoning_effort:"none"`, rather than "send nothing" (`off` absent). The two are
different wire behaviours and the scheme must pick deliberately.

---

## 3. The `resolveModel` contract (question E)

```ts
// dsh-llm/types/index.d.ts:171  (abstract LlmAdapter)
resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;

// dsh-llm/types/index.d.ts:337 (typert host mirror)
"export abstract class LlmAdapter {\n    providerInfo(provider: string): LlmProviderInfo;\n ...
  resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;\n ..."
```

The contract is **`LlmResolvedModelInfo`** (`dsh-llm/types/types.d.ts:377-388`):

```ts
export interface LlmResolvedModelInfo extends LlmModelInfo {
    context?: LlmModelContext;          // { contextWindow: number }
    defaultMaxTokens?: number;
    reasoning?: LlmModelReasoningInfo;   // ← the ONLY reasoning channel
    systemPromptUpdate?: SystemPromptUpdate;
    toolUpdate?: ToolUpdate;
}
```

with (`dsh-llm/types/types.d.ts:340-358`):

```ts
export interface LlmReasoningEffortInfo {
    id: ReasoningEffortId;      // "Opaque stable value"
    name: string;
    description?: string;       // per-EFFORT description — a channel that exists!
}
export interface LlmModelReasoningInfo {
    efforts: readonly LlmReasoningEffortInfo[];   // display order
    defaultEffort?: ReasoningEffortId;            // "Absence preserves the provider's own default."
}
```

**What it constrains a provider to declare about reasoning — the hard constraint:**

- `ReasoningEffortId` is a **branded string**, not a union: `Branded<'ReasoningEffortId'>`
  (`dsh-llm/types/brand.d.ts:49`) with a `string` constructor (`:55`). So the *type* permits
  arbitrary ids — **but `PiAiAdapter` mints them only from its own closed list**:
  `efforts: getSupportedThinkingLevels(model).map(level => ({ id: ReasoningEffortId(level) …}))`
  (`dsh-llm-pi-ai/index.js:1729-1732`), and validates incoming efforts against the same list,
  **throwing rather than clamping**:

  ```js
  // dsh-llm-pi-ai/index.js:1704-1709
  /** Validate an explicit Harness/profile effort without invoking pi-ai's clamp. */
  function resolveReasoningLevel(model, effort) {
      if (effort === void 0) return void 0;
      if (getSupportedThinkingLevels(model).some((level) => level === effort)) return effort;
      throw new LlmError(`pi-ai provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`, "UNSUPPORTED_REASONING_EFFORT");
  }
  ```

- The vocabulary is closed at **7 names, identical in all three layers**:
  `off, minimal, low, medium, high, xhigh, max` —
  `pi-ai/models.js:553` (`EXTENDED_THINKING_LEVELS`), `dsh-llm-pi-ai/index.js:296-304`
  (`THINKING_LEVELS`), `repo/src/catalog.ts:136`.
  DSH's `getSupportedThinkingLevels` (`dsh-llm-pi-ai/index.js:753-761`) is a **line-for-line
  reimplementation** of pi-ai's (`pi-ai/models.js:554-565`), including the rule that `xhigh`/`max`
  are **opt-in** (`:758`: `if (level === "xhigh" || level === "max") return mapped !== void 0;`)
  while `off/minimal/low/medium/high` are offered unless explicitly `null`.
- DSH's profile/catalog schema independently constrains the keys:
  `z.dict(z.union([z.string(), z.const(null)]), z.union(THINKING_LEVELS))`
  (`dsh-llm-pi-ai/index.js:1001`) and `reasoning: z.union(THINKING_LEVELS)` (`:1029`).

**Answer: yes, it constrains the design.** A bare `"on"` cannot appear as a level *name*. The only
escape hatch is semantic reuse — map a slot such as `minimal` to the wire value `"on"` — because
`ThinkingLevelMap` *values* are free strings (`pi-ai/types.d.ts:26`) and `reasoningEfforts` values
are `z.union([z.string(), z.const(null)])`. The picker would then label that row "Minimal"
(`dsh-llm-pi-ai/index.js:1731` capitalises the level id), so this escape hatch costs label fidelity.

**DSH does not apply its own default.** `defaultEffort` comes only from `profile.reasoning`
(`dsh-llm-pi-ai/index.js:1819, 1733`), and the plugin's profile declares **no `reasoning` key**
(`repo/src/index.ts:438-452`). Consequence: `defaultEffort` is always absent for this provider, so
the picker **always prepends a "provider default" row** (`dsh-picker/client.js:565-568`) — that row
is the honest encoding for a model that publishes no level list. It is already available for free.

---

## 4. Image parts for a text-only model

**The request is refused, not downgraded.** DSH gates this *before* pi-ai is reached:

```js
// dsh-llm-pi-ai/index.js:1858-1861
const containsImage = options.messages.some((message) => contentHasImage(message.content));
if (containsImage && !model.input.includes("image")) throw new LlmError(`pi-ai model "${model.id}" does not support image input`, "UNSUPPORTED_CONTENT");
const attachments = containsImage ? this.config.resolveAttachments?.() : void 0;
if (containsImage && attachments === void 0) throw new LlmError("pi-ai image input requires the durable attachment service", "UNSUPPORTED_CONTENT");
```

pi-ai *does* have a silent placeholder downgrade:

```js
// pi-ai/api/transform-messages.js:1, 19-22
const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
function downgradeUnsupportedImages(messages, model) {
    if (model.input.includes("image")) { return messages; }
```

but on the DSH path this is **unreachable** for the text-only case — `transformMessages` is only
called from inside the adapter's `buildParams` (`pi-ai/api/openai-completions.js:894`), which is
downstream of the `:1859` throw. **Verdict: fails upstream with `UNSUPPORTED_CONTENT`; the image is
not silently dropped and no placeholder is inserted.** (A clean negative worth recording, because
"the image is downgraded to a placeholder" was a plausible-looking wrong answer.)

---

## 5. Do `contextWindow` / `maxTokens` bound requests?

**No — not at the wire.**

**Prompt is never truncated by pi-ai.** `contextWindow` is used only for *post-hoc overflow
detection*: `isContextOverflow(message, contextWindow)`
(`pi-ai/utils/overflow.js:131-158`), surfaced by DSH as `mapStopReason(message, contextWindow)`
(`dsh-llm-pi-ai/index.js:1402-1403`, called with `model.contextWindow` at `:1888`). An oversized
prompt is still transmitted and fails upstream.

**`maxTokens` is clamped to the remaining context — never to `model.maxTokens`:**

```js
// pi-ai/api/simple-options.js:4-9, 17
export function clampMaxTokensToContext(model, context, maxTokens) {
    if (model.contextWindow <= 0) return Math.max(MIN_MAX_TOKENS, maxTokens);
    const available = model.contextWindow - estimateContextTokens(context).tokens - CONTEXT_SAFETY_TOKENS;
    return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, available));
}
…
maxTokens: clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens),
```

This **is** on DSH's path (`streamSimple` → `buildBaseOptions`, `pi-ai/api/openai-completions.js:520`),
so the output cap is bounded by `contextWindow − estimate − 4096`. But a caller asking for
`999999` against a large window passes straight through: there is no `Math.min(_, model.maxTokens)`.
`model.maxTokens` is only a **default** (`:17`), never a ceiling.

**DSH bounds the conversation over time, but only if compaction is configured for that target.**
`contextWindow` reaches compaction via `info.context.contextWindow`
(`dsh-compaction/index.js:939-940`), producing `thresholdTokens =
floor(min(contextWindow * policy.thresholdRatio, pressureBudgetTokens))` (`:132`, default ratio
`0.8` at `:15`, headroom default `65536` at `:63`), plus a reactive retry when the provider returns
`CONTEXT_WINDOW_EXCEEDED` (`:861-872`). This is **opt-in per model policy**
(`resolveTargetPolicy`), and it compacts *between turns* — it does not make a single oversized
request safe.

**The Zen route enforces nothing.** No context truncation and no cap enforcement in
`repo/src/zen-provider.ts` (the only `maxTokens` the plugin sets is the probe's
`PROBE_MAX_TOKENS`, `:1105`).

**Design consequence:** an over-large `limit.context` from models.dev will *not* be caught by the
plugin; it surfaces as an upstream failure. An over-large `limit.output` is likewise uncaught.

---

## 6. Hard ceiling — what is structurally inexpressible

**Inexpressible with no host change at any layer**

1. `structured_output` support — no field in pi-ai `Model`, none in `LlmModelInfo`, none in `modelInfo`.
2. `tool_call` support as an advertised capability — tools are per-request, never per-model metadata.
3. `knowledge` cutoff, `open-weights` — clean negatives at all three layers.
4. Input modalities beyond text/image — closed at *both* pi-ai (`input: ("text"|"image")[]`,
   `pi-ai/types.d.ts:817`) and DSH (`ModelModalityMap`, `dsh-llm/types/types.d.ts:212-215`).
5. A reasoning level *named* `"on"` — the vocabulary is a closed 7-name list in all three layers,
   and DSH throws `UNSUPPORTED_REASONING_EFFORT` rather than clamping
   (`dsh-llm-pi-ai/index.js:1708`). Only semantic reuse of a slot + an arbitrary wire value works.
6. A per-model **budget_tokens** axis (e.g. qwen3.6-plus-free's `budget_tokens: 81920`) — no
   thinking-budget field on `LlmModelInfo`/`LlmResolvedModelInfo` at all. `pi-ai`'s
   `ThinkingBudgets` (`pi-ai/types.d.ts:34-39`) stops at `high` and is a *request* option
   (`thinkingBudgets`, `dsh-llm-pi-ai/index.js:1679`), never derived from model metadata.

**Expressible, but only by a DSH change (not a plugin change)**

7. **Model description** — the slot exists (`dsh-llm/types/types.d.ts:311-312`) and so does a
   per-effort description (`:346-347`), but `PiAiAdapter.modelInfo` populates neither, and pi-ai's
   `Model` has no field to source them from. Needs `PiAiAdapter` to read a pi-ai extension field.
8. **`maxTokens` as an advertised default** — needs `profile.configuredMaxTokens` to be populated
   (the plugin leaves it empty, `repo/src/index.ts:443`); then `dsh-llm-pi-ai/index.js:1827`
   surfaces it as `defaultMaxTokens` and it feeds compaction's `reservedCompletionTokens` (`:940`).

**Expressible today, plugin-side**

9. Effort **wire values** — free strings in `thinkingLevelMap` (`pi-ai/types.d.ts:26`).
10. **`xhigh`/`max`** — opt-in purely by presence in the map (`dsh-llm-pi-ai/index.js:758`).
11. **`off` → `"none"` on completions** — verified unobstructed in §2.4; DSH neither strips nor
    overrides it, and the plugin's own guard will not touch it (it keys on `reasoning`, not
    `reasoning_effort`).
12. **"provider default"** — already offered automatically whenever `defaultEffort` is absent
    (`dsh-picker/client.js:565-568`), which is the plugin's current permanent state.

---

## 7. Could NOT determine

1. **Whether the DSH picker reads anything from the plugin's own JSON panel** (`catalogPayload`,
   `repo/src/index.ts:192-213`) that could serve as a side-channel for dropped capability fields.
   I confirmed the payload's `capabilities` cards are the plugin's own `Catalog` type and did not
   trace whether any built-in UI surface consumes that route. The picker I traced
   (`dsh-client-ui-model-selection`) reads the LLM catalog, not the plugin panel. **Not established
   either way.**
2. **Live runtime confirmation.** Every finding is static code reading. No request was sent; the
   `reasoning_effort: "none"` behaviour is confirmed at source (`pi-ai/api/openai-completions.js:719`)
   but not observed on the wire. Task #1 should cover that empirically.
3. **Whether an upstream 400s on an undeclared level.** `resolveReasoningLevel` throws *client-side*
   for a level outside the map, so a level inside the map but unsupported by the actual model would
   reach upstream — its response is not determined here.
4. **The `xhigh`/`max` opt-in asymmetry in `resolveModelReasoning`.** `:583` pins *undeclared*
   levels to `null`, including `xhigh`/`max`, which differs from pi-ai's own defaulting. This only
   affects DSH catalog entries, not the plugin's models, so it does not bear on this design — I did
   not chase it further.
---

# Addendum A — Third-party plugin precedence (`dsh-better-reasoning-effort` v0.5.2)

Package root: `$HOME/.dsh/profiles/web/node_modules/dsh-better-reasoning-effort`.
Namespace constant `PI_AI_NS = "llm-pi-ai"` at `lib/index.js:9`.

## A.1 The premise needs one correction: `opencode.ai` is an *exclusion*, not a target

`"opencode.ai"` (`lib/index.js:1165`) is the **last entry of `OFFICIAL_RELAY_DOMAINS`**
(declared `lib/index.js:1145`), consumed by `isSelfHostedRelay`:

```js
// lib/index.js:1170-1179
function isSelfHostedRelay(route) {
  if (normalize(route.api) !== COMPAT_CAPABLE_PROTOCOL) return false;
  const baseURL = route.baseURL;
  if (baseURL === void 0 || baseURL.length === 0) return false;
  try {
    const host = new URL(baseURL).hostname.toLowerCase();
    if (!host.includes(".")) return false;
    return !OFFICIAL_RELAY_DOMAINS.some((root) => host === root || host.endsWith("." + root));
  } catch {
    return false;
  }
}
```

and `withRolePin` (`lib/index.js:1180-1185`) only pins `supportsDeveloperRole: false` when
`isSelfHostedRelay(route)` is true. Because `opencode.ai` **is** an official relay,
`isSelfHostedRelay` returns **false** for our route. **Consequence: the third-party plugin will
NOT pin `compat.supportsDeveloperRole: false` on our models.** This is favourable, not adverse —
`backfillRolePin` (`lib/index.js:1584`) is a no-op for us.

## A.2 The winner: OUR map. `reasoningEfforts` is never applied to a `piProvider` model.

The autofill's entire input is the **user-authored settings document**, not the live catalog:

```js
// lib/index.js:1866-1872
const descriptor = settings.describe().find((entry) => entry.ns === PI_NS);
if (!isRecord(descriptor?.value)) return false;
const user = descriptor?.user;
const userProviders = isRecord(user) && isRecord(user["providers"]) ? user["providers"] : void 0;
if (userProviders === void 0) return true;
const fullPatch = buildAutofillPatch(userProviders, () => true, { modalities: resolved.modalityAutofill }, descriptor?.revision ?? 0);
```

`buildAutofillPatch` (`lib/index.js:1566-1630`) iterates **only** `Object.keys(providers)` from
that object and only rewrites entries already present in `providers[route].models`.

Our plugin writes **nothing** to the `llm-pi-ai` settings namespace. It registers through
`ctx.llm.registerAdapter([PROVIDER_ID], new PiAiAdapter({…}))` (`repo/src/index.ts:454-466`) with
the pi-ai models attached as `profile.piProvider` (`repo/src/index.ts:441`). DSH passes those
models in verbatim — `models.setProvider(profile.piProvider)`
(`dsh-llm-pi-ai/index.js:1767`) — and `thinkingLevelMap:` is written in exactly one place
(`dsh-llm-pi-ai/index.js:588`, inside `resolveModelReasoning`), which handles only
**catalog entries** that declare `reasoningEfforts` themselves (`dsh-llm-pi-ai/index.js:568-589`).

**So the mutation never reaches our models: there is no route entry in `user.providers` for it to
find. The answer to "would a user with this plugin installed see OUR measured map?" is yes —
ours wins by default, because the competing writer never sees our models.**

**Mutation order:** there is none. It is not a "before vs after our plugin" race. The two writers
write to disjoint stores (settings JSON vs. an in-memory pi-ai `Provider`).

**Caveat that reopens the question:** if a user *hand-declares* `providers["<our route>"].models`
in `llm-pi-ai` settings (the third-party plugin's UI steers users toward exactly that), then the
entry exists and autofill will fill it. In that case both a settings entry and a `piProvider`
exist for the route. **I did not resolve which wins in that dual-source case** — see §A.5.

## A.3 `AUTOFILL_MARKER` is a revision stamp, NOT an idempotency guard

```js
// lib/index.js:12
var AUTOFILL_MARKER = "reasoningEffortsAutofilled";
…
// lib/index.js:1607-1610
if (!effortsDeclared && fillEfforts) {
  touched = true;
  fill["reasoningEfforts"] = suggestion.efforts;
  fill[AUTOFILL_MARKER] = revision;      // ← stores the settings revision number
```

It is **written** (`lib/index.js:1610`) but **never read** anywhere as a gate. The real
idempotency guard is the presence of the field itself:

```js
// lib/index.js:1581
const effortsDeclared = model["reasoningEfforts"] !== void 0 || model[UNSET_MARKER] === true;
```

Once `reasoningEfforts` exists, autofill never rewrites it (`lib/index.js:1607` requires
`!effortsDeclared`). Note the asymmetry: `reasoningEfforts` **is** rewritten when a user edits it
by hand elsewhere in the plugin; only autofill treats it as sticky. The permanent opt-out is a
*different* marker, `UNSET_MARKER = "reasoningEffortsUnset"` (`lib/index.js:10`, honoured at
`:1581` and `:1661`).

## A.4 Knowledge-base collision: YES, on `mimo-v2.6-flash-free`

Matching is boundary-based over a punctuation-stripped haystack:

```js
// lib/index.js:1040-1049
function normalizeLoose(value) { return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, " "); }
function onBoundary(haystack, at, length) {
  const before = at === 0 ? void 0 : haystack[at - 1];
  const after = haystack[at + length];
  return !isAlnum(before) && !isAlnum(after);
}
```

Traced for our ids:

| Our model id | needle | result |
|---|---|---|
| `mimo-v2.6-flash-free` | `"mimo-v2.6"` → `mimo v2 6` (`lib/index.js:980`) | haystack `mimo v2 6 flash free`; `indexOf` = 0, `after` = space → **MATCH** |
| `space-bunny-free` | — | **no entry** — clean negative |
| `ling-3.1-flash-free` | — | **no entry** — clean negative |
| `nemotron-3-ultra-free` | — | **no entry** — clean negative |

**1 of 4 collides.** The matched entry (`id: "mimo-v2-6"`, `lib/index.js:967-987`) is notable
prior art — it independently arrives at **exactly the design the lead is building**:

```js
// lib/index.js:981-985
efforts: { off: "none", low: "low", medium: "medium", high: "high" },
compat: { thinkingFormat: "openai", supportsReasoningEffort: true },
input: ["text", "image"],
contextWindow: 1048576,
maxTokens: 131072,
```

`off: "none"` — the same lever verified unobstructed in §2.4. Its comment (`lib/index.js:968-977`)
also independently documents the reasoning ladder problem: the endpoint accepts
none/minimal/low/medium/high/xhigh/max/ultra but folds minimal→low and xhigh/max/ultra→high, so the
declared ladder is what the endpoint *accepts*, not levels that behave differently.

**This collision is latent, not active.** Per §A.2 it only bites if our route is hand-declared in
`llm-pi-ai` settings. It is a live landmine in exactly that case: the third-party plugin would
write `reasoningEfforts` + `AUTOFILL_MARKER` onto a `mimo-v2.6-flash-free` entry, and once written
the `!== void 0` guard at `:1581` makes it **permanently** win against any later autofill.

## A.5 Could NOT determine

1. **The dual-source precedence** (settings entry *and* `piProvider` for the same route) — which
   `modelOf` returns. `dsh-llm-pi-ai/index.js:1781` was located but not read. This is the only
   case where the third-party plugin could actually win, and it is unresolved.
2. Whether the third-party plugin's UI actively offers to import/hand-declare our route — I read
   the autofill and knowledge base, not `lib/client/` (minified).

---

# Addendum B — Is the `max_tokens` clamp observable?

**Short answer: the clamp is fully observable, but not through `hasAnswer()`, and the detector
needs two conjuncts to avoid false positives.**

## B.1 The clamp is directly observable on the plugin's EXISTING `onPayload` hook — best answer

pi-ai writes the (already-clamped) cap into the params object and *then* calls `onPayload`:

```js
// pi-ai/api/openai-completions.js:587-592
if (options?.maxTokens) {
    if (compat.maxTokensField === "max_tokens") { params.max_tokens = options.maxTokens; }
    else { params.max_completion_tokens = options.maxTokens; }
}
…
// pi-ai/api/openai-completions.js:187-188
let params = buildParams(model, normalizedContext, options, compat, …);
const nextParams = await options?.onPayload?.(params, model);
```

The field name for our route is **`max_completion_tokens`**: `useMaxTokens`
(`pi-ai/api/openai-completions.js:1248-1255`) excludes `opencode.ai`, so
`maxTokensField: "max_completion_tokens"` (`:1265`).

The plugin's `onPayload` is already installed on the **main** path —
`compatRequestOptions` builds it (`repo/src/zen-provider.ts:1318-1333`) and both wrappers pass it
through (`repo/src/zen-provider.ts:1414`, `:1429`), and `streamSimple` is DSH's actual entry point
(`dsh-llm-pi-ai/index.js:1881`). **So the plugin can read the exact post-clamp number that went
on the wire, with no inference.** This is strictly better than computing it.

**Caveat:** this observes what the plugin/DSH *sent*, not what Zen finally applied. An upstream
server-side clamp is invisible here.

## B.2 The clamp is also exactly computable — both helpers are public

```ts
// pi-ai/dist/api/simple-options.d.ts:2
export declare function clampMaxTokensToContext(model: Model<Api>, context: TranscriptContext, maxTokens: number): number;
// pi-ai/dist/utils/estimate.d.ts:16
export declare function estimateContextTokens(context: TranscriptContext | readonly Message[]): ContextUsageEstimate;
```

Both are reachable through documented export paths (`"./api/*"`, `"./utils/*"` in
`pi-ai/package.json`). The plugin builds the very context object pi-ai will use
(`repo/src/zen-provider.ts:1426`, passed straight through at `:1429`), so it can reproduce the
identical value. **Note what the clamp is and is not** (`pi-ai/api/simple-options.js:4-9`):

```js
const available = model.contextWindow - estimateContextTokens(context).tokens - CONTEXT_SAFETY_TOKENS;
return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, available));
```

It clamps **down to the remaining context**, never down to `model.maxTokens`. So "observed cap <
declared `limit.output`" does **not** by itself implicate `contextWindow`.

## B.3 `finish_reason: "length"` IS visible, as `stopReason`

```js
// pi-ai/api/openai-completions.js:1197-1198
case "length":
    return { stopReason: "length" };
```

on the assistant message (`pi-ai/types.d.ts:365 stopReason: StopReason`). The plugin's `streamSimple`
wrapper returns the event stream (`repo/src/zen-provider.ts:1435-1437`), so it can tap the terminal
message event on the main path.

## B.4 `hasAnswer()` is probe-only AND deliberately inverts your detector

**Call sites — exactly one:** `repo/src/zen-provider.ts:1141`, inside the probe. **Not enforced on
the main path.**

```ts
// repo/src/zen-provider.ts:965-987 (doc comment + body)
 * A `thinking` part counts. A reasoning model can spend the entire budget on
 * chain-of-thought and return `stopReason: "length"` with no text at all
 …
 * `stopReason: "error"` is still the one thing that settles it as no reply.
function hasAnswer(result: Record<string, unknown> | undefined): boolean {
  if (!result || result.stopReason === "error") return false;
  const content = result.content;
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    …
    if (typed.type === "text")     return typeof typed.text === "string" && typed.text.trim() !== "";
    if (typed.type === "thinking") return typeof typed.thinking === "string" && typed.thinking.trim() !== "";
```

`stopReason: "length"` is explicitly **not** a failure — a `thinking` part counts as an answer.
So `hasAnswer` is **not** a clamp detector and must not be reused as one. For your `max_tokens: 1`
case it returns false, but only because `content` is empty — a model that emitted a single
reasoning delta would be scored as having answered.

## B.5 Distinguishability — the honest false-positive accounting

| Cause of `stopReason: "length"` | Distinguishable? | Basis |
|---|---|---|
| Clamped because `contextWindow` understated | **YES, provably** | observed `max_completion_tokens` equals the plugin's own `clampMaxTokensToContext(model, ctx, requested)` — B.2. The clamp fired *and* the cause is provably the context budget, because the caller never sent that number. |
| User deliberately asked for a tiny cap | **YES** | the plugin would have had to send it; on the main path `maxTokens` originates from DSH `GenerateOptions.maxTokens` (`dsh-llm/types/types.d.ts:511`) via `dsh-llm-pi-ai/index.js:1884`. The plugin's own only tiny value is the probe's `PROBE_MAX_TOKENS` (`repo/src/zen-provider.ts:1105`). A value the plugin did not originate cannot be user-intent it caused. |
| Model legitimately used its whole budget | **NO** | identical `stopReason`, and `completion_tokens` equals the cap in both cases. Separating this from the previous row requires comparing the observed cap against the declared `limit.output`. |

**The detector that survives this audit** needs both conjuncts:

> observed `payload.max_completion_tokens` **strictly below** the model's declared `limit.output`,
> **and** observed value **exactly equals** the plugin's recomputed `clampMaxTokensToContext(...)`.

The first conjunct alone is wrong, because pi-ai never clamps to `model.maxTokens` (B.2). The
second conjunct alone is right but rare — it only fires on genuine context pressure. Together they
make "clamped because `contextWindow` is understated" a sound inference and rule out both false
positives above.

**What remains genuinely unknowable:** whether Zen applied a further server-side clamp below what we
sent. `onPayload` sees the request, not the applied limit; `completion_tokens` would hint at it
but is ambiguous against the legitimate-full-budget case. A conclusive answer needs the empirical
A/B in task #1, not a code-level detector.