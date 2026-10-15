# Compat acceptance baseline for DSH 0.2.1-alpha.3

> Archived design and exact-version inspection. Planned-change wording below
> describes the baseline, not unfinished implementation work to repeat. Use the
> [current compat guide](../compat-run.md) for operation and acceptance rules.

Reviewed: 2026-10-15, Asia/Taipei. Repository source: `8fa8fe9` plus the existing working tree. Scope: the existing `scripts/compat-run.mjs`, not conversation compaction.

The user confirmed all officially listed free conversational models as the scope, full-model L0/L1/L2 acceptance, a fresh official dynamic list each round, and exit code 0 only when every target passes. This document is the confirmed design and acceptance baseline for implementation. No runner or provider behavior has changed yet.

## Conclusion

The existing isolated headless/PiAiAdapter path is appropriate for DSH 0.2.1-alpha.3. Its current success aggregation does not meet the user's full-model acceptance requirement. Keep the host path and meaningful L1 test. Tighten L0 aggregation, L2 execution evidence, target accounting, and exit codes.

These are project acceptance criteria built on the host's public behavior. DSH does not certify that all Zen models support tools or that the shared anonymous quota is available.

## Exact-version evidence

The official [release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.3) identifies tag `dsh-v0.2.1-alpha.3`, commit prefix `2fbf435`. Do not use moving master as the host contract.

Inspected local `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-llm-pi-ai`: both report `0.2.1-alpha.3`. Also downloaded, unpacked, and verified the npm SHA-512 integrity of these exact-version packages without installing or running them:

- `@deepseek-ai/dsh`
- `@deepseek-ai/dsh-headless`
- `@deepseek-ai/dsh-app-boot`
- `@deepseek-ai/dsh-base`
- `@deepseek-ai/dsh-cmdline`
- `@deepseek-ai/dsh-tool-fs`
- `@deepseek-ai/dsh-tool-pwsh`

Local read-only reference files and verification metadata are under `.artifacts/alpha3-acceptance-reference/`. This is source inspection, not a fresh actual-host or live pass.

Pinned upstream source locations:

- [Headless runner](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-alpha.3/packages/bundle/headless)
- [Base bundle](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-alpha.3/packages/bundle/base)
- [PiAiAdapter](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-alpha.3/packages/llm/llm-pi-ai)
- [Read tool](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-alpha.3/packages/fs/tool-fs)
- [PowerShell tool](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-alpha.3/packages/shell/tool-pwsh)

## What the host version actually supports

| Contract | Exact-version evidence | Acceptance implication |
| --- | --- | --- |
| Built-in headless profile | app-boot `lib/index.js:541` composes base and headless | Existing profile choice is valid. |
| Overlay row IDs | base `cordis.patch.yml:67,90,135` declares session-title-llm, agent-default-model and llm-pi-ai | Disabling title inference and selecting the provider/model through the existing overlay are valid. |
| Real adapter path | local adapter `lib/index.js:1953,1983` resolves effort and calls models.streamSimple; plugin `src/index.ts:454,466` registers its adapter/provider | L1/L2 can test the real DSH adapter path. L0 directly calls the provider and must be described separately. |
| Text-mode completion | headless `lib/index.js:125–128,359–362` extracts committed assistant text and exits 0 only for a completed turn | Exit 0 plus nonempty stdout is a valid basic L1 criterion in this version. It does not establish L0 or L2. |
| JSON event mode | headless `lib/startup.js:35` exposes --json; projector `lib/json-stream-BA-F3lfb.js:237–278` emits tool_call, tool_result and final | Use this supported mode for structured L2 evidence. JSON line count or nonempty JSON stdout is not an L1 pass. |
| Windows tool selection | base `cordis.patch.yml:281–287` disables bash on Windows and enables pwsh | Windows acceptance must observe pwsh after plugin restoration, not an admission-only bash call. |
| Host tool schemas | tool-fs `lib/index.js:251–265` requires file_path; tool-pwsh `lib/index.js:466–478` requires description and command | Judge the restored host arguments, not the outbound aliases filePath/bash. |
| Reasoning effort | adapter `lib/index.js:1785–1788,1953` validates the requested level | Test the lowest published valid level for L1/L2, or the default where none is published. Do not claim every level was tested. |

The release also documents that headless defaults to environment/.env credentials rather than saved keys. Continue using a fresh DSH_HOME and workspace, and remove OPENCODE_API_KEY from the test environment. Headless evidence does not prove Web/Desktop credential precedence or user-profile behavior.

## Baseline gaps before implementation

The following table records the runner before this change. The implementation now addresses these gaps; [the integration report](../compat-reports/anonymous-tool-choice-2026-10-15-full/acceptance.md) records verification and remaining limits. Historical line references below identify the baseline, not the updated source.

| Gap | Local evidence | Required adjustment |
| --- | --- | --- |
| L0 failure does not prevent ok | `scripts/compat-core.mjs:99–123` stores the probe result but derives the main verdict from L1/L2 | Require a successful probe for full acceptance. Warmup setup success is insufficient. |
| Gate refusal and unavailable upstream can exit 0 | `scripts/compat-core.mjs:435–439` only rejects plugin-fault, rate-limited and unverified | Every unmet required step must prevent exit 0 while preserving the cause classification. |
| Empty target set can exit 0 | `scripts/compat-core.mjs:59–61,435–439` | An empty target set is not full-model success. |
| L2 can pass without the intended tool | `scripts/compat-core.mjs:349–356` checks only stdout substring membership | Require matching host tool-call and tool-result evidence as well as the expected final reply. |
| Tool steps are opt-in | `scripts/compat-run.mjs:39` defaults tools to false | Full L0/L1/L2 acceptance requires --tools. A text-only run must be labelled as such. |
| Target construction can hide catalogue coverage gaps | core checks cost membership directly; `src/catalog.ts:289–300` also validates catalogue status and derives IDs | Establish targets from official dynamic sources independently of current plugin membership. Use the plugin's derivation for host model records, but retain missing targets as coverage failures. |
| Inference probe is not the adapter path | `src/zen-provider.ts:1196–1235` directly invokes the provider | Report L0 provider evidence and L1/L2 adapter evidence separately. |

Existing probe success accepts a nonempty text or thinking part (`src/zen-provider.ts:1094–1105`). Preserve that availability meaning; require nonempty assistant text separately at L1. Neither HTTP 200 nor warmup ok alone establishes either result.

## Full acceptance criteria

### Environment and targets

1. Check both exact DSH peer pins before setup. Verify the installed CLI reports `0.2.1-alpha.3` before mounting the plugin. Record resolved adapter/pi-ai versions as well, because a host version alone does not freeze ranged transitive dependencies.
2. Pack the current working tree and install that tarball into a fresh DSH_HOME. Preserve existing DSH processes, profiles, unrelated plugins and credentials.
3. Obtain all officially listed free conversational targets afresh for every round. Use the official live model-list endpoint for current membership and current official pricing/endpoint evidence for free/conversational classification. models.dev may supplement model records and reasoning metadata; its missing entries must not silently narrow the targets. Never use a hard-coded acceptance list or a previous report as the source. Record retrieval time, source URLs, the resulting target IDs, exclusions with evidence, and unresolved classifications. A saved per-round snapshot is evidence of what was tested, not a static source for later rounds. Refuse full acceptance for an empty list or failed selection.
4. Do not remove failed targets during execution. A model disappearing later remains an incomplete row. New models belong to a later round. Record actual probe targets and detect catalogue drift rather than silently combining different scopes.
5. Use anonymous public for the acceptance subject. A keyed comparison cannot replace an anonymous failure.

#### Official dynamic source clarification

The user's source requirement means fetching the official [model-list endpoint](https://opencode.ai/inference/v1/models) anew each round. A per-round snapshot records the fetched IDs; it must not become a hard-coded list or the input for later rounds.

A metadata-only GET on 2026-10-15 returned 85 models, with only `created`, `id`, `object` and `owned_by` on model entries. There are no machine-readable price/free or transport fields in that observed response. Do not classify free models by ID suffix: big-pickle is a documented free model without that suffix. The [official Console documentation](https://opencode.ai/v2/docs/console/models/) separately publishes prices and endpoint mappings. [OpenCode's model documentation](https://opencode.ai/docs/models/) says it uses models.dev; that makes models.dev a relevant supplementary source, not fields supplied by the inference endpoint itself.

Confirmed source policy: official live IDs establish which models are currently served; current official pricing and endpoint evidence classify free conversational models. A missing metadata record must be reported as unresolved selection evidence, not silently remove an official model to produce a green result. models.dev can supplement metadata without overruling official membership or classification. Fetch failures, uncertain free classification or unresolved transport coverage prevent a complete-scope claim. Do not infer prices, send paid-model requests, or fall back to a built-in acceptance list. Treat changes to the official document/API structure as selection errors rather than inventing an undocumented contract.

The endpoint also lists `jev-1.13-free`. Official documentation describes it as a free structured-decision model on `/inference/v1/systemone`, rather than a text-generation model. The user confirmed free conversational models as the acceptance scope. Record this non-conversational exclusion with its official evidence, without counting it as passed. A free conversational model on a transport the plugin does not yet support remains a target with an unresolved/failed coverage row; transport support is not an exclusion rule.

[ADR-0004](../adr/0004-official-dynamic-compat-targets.md) records this acceptance-source decision and its relationship to [ADR-0002](../adr/0002-catalogue-source-of-truth.md). The runtime catalogue remains governed by ADR-0002 in this design; the acceptance set must independently detect its coverage gaps. ADR-0002's historical claim that Zen does not publish per-model endpoints is qualified by the current official endpoint table. This decision does not add new runtime transports or silently change user-visible catalogue policy.

## Tool-choice adjustment design

- Use one anonymous admission policy across main/compat, both stream methods, probe, and the final-payload backstop. Determine executable host tools before adding admission-only declarations.
- Remove the plugin's unconditional injection of tool_choice none from both current write sites. For a tool-less caller with no explicit tool-choice override, send the substantive admission declarations and omit tool_choice. Do not add a per-model exception list.
- Preserve caller-provided tool-choice semantics, real host tool execution, alias restoration, and keyed/non-Zen behavior. Explicit caller overrides do not become an excuse to claim an unsupported request passed or to silently substitute another policy.
- Treat admission-only declarations as unavailable execution capabilities. Reject any attempted unavailable tool call before it can become an executable host call, in both streamed events and final results. Test partial/fragmented tool names as well as complete names.
- Do not automatically retry an unavailable tool call or rewrite conversation contents to manufacture success. The existing finite 429 backoff is separate and remains unchanged.
- Verify the policy offline first, then apply the full live acceptance criteria above to the packed plugin in isolated DSH 0.2.1-alpha.3. Shared policy coverage does not establish future upstream availability.

### Per-model requirements

| Layer | Pass condition |
| --- | --- |
| L0 | The target is present in the provider catalogue used for model selection, and this round's actual probe returns ok. This is catalogue membership, not a rendered picker UI test. |
| L1 | Real DSH completes the selected provider/model turn and returns nonempty assistant text. In JSON mode require a valid final event with nonempty text and process exit 0; status/session/thinking events alone do not count. |
| L2 read | Observe a host read call pointing to the current nonce file, a matching callId result with completed status, the expected nonce in that result, and the expected nonce in the final assistant reply. The nonce must be absent from the prompt. |
| L2 shell | Observe a host pwsh call on Windows with the intended hash command and required host arguments, a matching completed result, the expected hash in that result, and the expected hash in the final reply. Use a second random file. The expected hash must be absent from the prompt. |
| Aggregate | All required layers pass for every fixed target in the same round. Preserve separate per-layer results even if a later layer succeeds after an earlier layer failed. |

Match file paths after normal resolution inside the test workspace; do not require one arbitrary slash style or forbid an equivalent absolute path. Preserve meaningful command semantics. Validate tool arguments at the host interface after alias restoration. A call to another tool that happens to reveal the nonce does not satisfy the required read/pwsh step.

For JSON evidence, pair tool_call and tool_result by callId, require the appropriate order, reject malformed/missing required fields, and require exactly one valid final event for the owned run. A truncated relevant event does not establish a pass. The host's completed tool-result status means `isError !== true`, not independently proven shell exit 0; the computed hash is still required. Extra status events are normal and must not be mistaken for replies or failures.

### Exit codes and retry policy

| Exit | Meaning after the planned adjustment |
| --- | --- |
| 0 | A nonempty target set completed every requested check. For the agreed full acceptance, all targets passed L0/L1/L2 with --tools. |
| 1 | Setup/runner failure or a confirmed plugin/host integration or required behavior failure. |
| 2 | Full verification is incomplete because of upstream refusal/unavailability, quota, missing live catalogue evidence, an empty target set, or other unresolved evidence. These do not become passing results or automatic model-retirement verdicts. |
| 3 | An invalid argument, version mismatch or other refused precondition prevented the run. |

A confirmed local fault takes priority over incomplete upstream evidence. Preserve the existing reason classification; do not classify every nonzero outcome as plugin-fault. Preserve ADR-0003: live runs stay out of CI and 429 remains inconclusive.

Keep the existing finite 30s/60s rate-limit backoff and stop after three consecutive rate-limited models. List remaining targets as unverified. Do not retry calls to unavailable admission tools or run unbounded loops to force all models green. An incomplete run does not satisfy the user's target; it is a truthful unfinished result.

The existing --tools option stays optional for ordinary narrower runs. The full acceptance command below explicitly enables it. A future model unsupported by the host or unable to complete a required tool step cannot be declared passing merely because the tool-choice mechanism is shared.

### Reporting and offline checks

Parse raw JSON events only in memory. Persist only allowlisted model/layer/tool names, HTTP status, classifications, durations and comparison booleans. Do not write raw tool input, results, assistant text, reasoning, credentials or request bodies. Include the source revision, package versions, OS/Node, target snapshot, requested layers, anonymous/keyed distinction, raw runner exit and strict outcome.

Offline fixtures must cover each false-pass case above, malformed/truncated/unpaired JSON events, result/final mismatches, wrong tool/path/command, and successful events from both tool steps. Provider fixtures must cover both channels, main/compat, both stream methods, legacy/normalized contexts, the final-payload backstop, and rejection of unavailable admission calls before host execution. These prove local behavior, not upstream availability.

Continue the existing typecheck/build/package checks and tarball consumer checks appropriate to the later production change. This review does not close unrelated gaps in the engineering ledger.

## Intended command

Run through pnpm so npm_execpath is available to the driver's child-process launcher:

```powershell
pnpm compat --dsh 0.2.1-alpha.3 --tools --out <unique-round-report-directory>
```

This expands to the existing build plus compat-run script. Do not supply --model for full-model acceptance. A direct `node scripts/compat-run.mjs` outside pnpm lacks the pnpm entry-point context the driver requires.

## Verification performed for this review

- Inspected the exact installed LLM/adapter packages.
- Verified the integrity and inspected seven exact-version published package tarballs. No package install scripts or DSH processes were run.
- Ran three existing focused offline compat tests: all three passed. They cover basic text success, the existing gate-refused/upstream-down exit-0 behavior, and nonce-based L2 success. Their success confirms the current implementation contract; it does not validate the stricter proposed baseline.
- Sent no live inference requests. Did not run a new compat round, full offline suite, full build, tarball consumer, Web/Desktop test or compaction test.
- Changed documentation only. Original reports and pre-existing working-tree changes remain preserved.

Applicable project rules: A1, C1/C3, Q1–Q5, S1–S3, U1, D1/D2, R2/R4. See [engineering standards](../standards.md), [gap ledger](../standards-gap.md) and [ADR-0003](../adr/0003-compat-run-not-in-ci.md).
