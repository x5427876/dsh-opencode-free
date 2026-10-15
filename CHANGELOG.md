# Changelog

All notable user-visible changes to `dsh-opencode-free` are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Local 0.3.4 inference migration (not published).** Requests and availability
  checks use `/inference/v1`. Fetch and Node HTTP guards match only the exact
  HTTPS origin and path descendants; cached model metadata is rederived with
  the current provider identity without deleting preferences or verdicts.
- **Valid session time encoding.** Retain one descending, time-encoded OpenCode
  ID per DSH session in memory, instead of filling its time region with a hash.
  Affinity headers and cache keys remain consistent; request IDs are unchanged.
- **Anonymous tool admission.** Replace empty-schema placeholders with substantive,
  non-executable admission declarations. Adapt DSH read/shell usage and pair
  `file_path`/`filePath`, `timeoutMs`/`timeout`, and `pwsh`/`bash` mappings across
  schemas, histories, SSE events, and results. Host constraints and keyed requests
  are retained; missing-tool calls are rejected. Minimum upstream rules are not
  fully known; offline fixtures alone do not establish live DSH compatibility.
- **Compat report privacy.** Retain allowlisted failure codes/status/markers
  instead of raw DSH error lines that can echo conversations or tool arguments;
  classifications and bounded backoff remain unchanged.
- **Single-model Windows evidence, not full acceptance.** One isolated DSH
  0.2.1-alpha.3 round with local 0.3.4 and anonymous Muse Spark 1.3 verified
  nonempty text, read nonce, and pwsh hash. Its L0 probe was HTTP 429; strict
  acceptance remains incomplete despite compat exit code 0. No additional round
  ran. See the [acceptance report](docs/compat-reports/zen-inference-2026-10-14-single-model-9c31d7a4/acceptance.md).

- **Targets DeepSeek Harness `0.2.1-alpha.3`.** The peer pins move to
  `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-llm-pi-ai` `0.2.1-alpha.3` and
  `@deepseek-ai/schemastery` `~3.18.5-alpha.2`. DSH `0.2.1-alpha.3` moves `pi-ai`
  from `^1.0.2` to `^1.1.0`, so the `pi-ai` peer moves with it. The pin stays
  exact, so `0.2.1-alpha.2` is no longer supported by this release; stay on
  `0.3.3` for it. Plugin behaviour is unchanged: the requests the plugin sends to
  Zen through the DSH adapter are identical on `0.2.1-alpha.2` and `0.2.1-alpha.3`,
  including the anonymous `read` and `bash` tool gate.

## [0.3.3] - 2026-10-12

Supports DeepSeek Harness `0.2.1-alpha.2`.

### Fixed

- **A request over the context window now reaches compaction.** Zen refuses it
  with the generic `[invalid_request_error] invalid request`, which neither
  pi-ai's overflow patterns nor the host's detector match, so auto-compaction
  never ran and every later message failed the same way (#7). When the refusal
  is that bare message and the `max_tokens` sent is below the one requested
  (pi-ai lowered it to fit the window), the plugin appends
  `input exceeds the context window of this model` to the upstream wording.
  Any other refusal is left as the upstream said it. The clause is missed when
  the clamp does not bind; that case keeps the old behaviour.

## [0.3.2] - 2026-10-10

Supports DeepSeek Harness `0.2.1-alpha.2`.

### Changed

- **Targets DeepSeek Harness `0.2.1-alpha.2`.** The peer pins move to
  `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-llm-pi-ai` `0.2.1-alpha.2`. DSH
  `0.2.1-alpha.2` moves `pi-ai` from `^0.87.1` to `^1.0.2`, so the `pi-ai` peer
  moves with it. The pin stays exact, so `0.2.1-alpha.1` is no longer supported by
  this release; stay on `0.3.1` for it.

## [0.3.1] - 2026-10-03

Supports DeepSeek Harness `0.2.1-alpha.1`.

### Changed

- **Targets DeepSeek Harness `0.2.1-alpha.1`.** The peer pins move to
  `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-llm-pi-ai` `0.2.1-alpha.1` and
  `@deepseek-ai/schemastery` `~3.18.5-alpha.1` (the old `^3.18.3` range excludes
  that prerelease). The pin stays exact, so `0.2.0-rc.2` is no longer supported
  by this release; stay on `0.3.0` for it. DSH `0.2.1-alpha.1` keeps `pi-ai`
  `^0.87.1` and leaves `dsh-llm-pi-ai` unchanged; `dsh-llm` only drops its
  internal `INVARIANT` error code, so the plugin's behaviour is unchanged.

## [0.3.0] - 2026-10-02

The catalogue now follows models.dev, the availability check can be watched as it
runs, and a panel on the plugin's details page controls which models you see.

### Added

- **The model list follows [models.dev](https://models.dev).** Zen's own `/models`
  endpoint says which models exist; models.dev says which are free, what they are
  called, how large their context is, whether they take images, and which thinking
  levels each offers. A newly published free model appears without a plugin
  update, and a withdrawn one leaves on its own. Refreshed with one conditional
  request, so staying current costs no inference quota. Without a usable answer the
  plugin keeps serving its last known list, and then an offline floor — a failed or
  unreachable refresh changes nothing you can see.
- **An availability check you can watch run.** "Probe now" asks each model and
  reports as it goes: a progress pill counts down, the model being asked says so,
  the ones not reached yet are queued, and each row ends with its own outcome and
  how long it took. A round only spends a request on the models you have switched
  **on**, because a probe draws from a bucket shared by everything behind your
  egress IP.
- **A model visibility panel on the plugin's details page.** Every free model gets
  a switch; switched off, it leaves the picker and comes back when switched on. An
  id the catalogue no longer knows about is kept in the setting, so hiding a model
  and upgrading the plugin does not lose your choice.
- **Capability badges on every row** — vision support, context length, maximum
  output, and the strongest thinking level the model offers — taken from what
  models.dev publishes for that model rather than assumed.

### Changed

- **A model is removed only on a positive signal.** A text reply is `ok`; only a
  positive "this model is gone" is `dead`; anything else is `inconclusive` and the
  model stays. `dead` is reached only after every channel the provider implements
  has refused, and a channel that never answered — a dropped socket, a timeout —
  vetoes it rather than losing an argument. **A temporary network failure can no
  longer remove a model permanently.** The cost is deliberate: a model on a channel
  that times out keeps its place in the picker as a grey row.
- **A model is routed by the channel that actually worked.** The check asks each
  channel in turn, and a channel that answered is remembered — in the catalogue and
  across restarts — rather than re-inferred from a record that may describe the
  wrong one.
- **Probing stays sequential, and the button is not a repeat-click machine.** A
  manual round is floored at five minutes, because one round is up to 34 real
  requests against a shared bucket.
- **The round's report is persisted with its verdicts** and restored on restart, so
  the progress area shows the last outcome instead of appearing to have vanished.

### Fixed

- **A network blip is no longer read as "the anonymous tier refused us".** A socket
  error was caught by the identity guard's own fallback and the request re-sent
  without its credentials, which is exactly the diagnosis a dropped connection
  should not produce. Connection failures now name their cause — proxy, VPN,
  firewall or DNS — and never cost a second request.
- **A refusal names which upstream condition answered.** `FreeTierError` (free-tier
  admission refused), `MissingSessionID`, and "only the OpenCode client may send
  this" are told apart, because the reader's next move differs for each.
- **The availability check is admitted.** Its own request could lose the `read` and
  `bash` tool names the tier requires, and the upstream answered `403` to a request
  it would otherwise have served. The check re-asserts them on the final payload.
- **Images attached to a message reach the model.** They were resolved to nothing
  unconditionally, so every image was dropped before the request.
- **The visibility panel appears under the host's live config shape**, and a hidden
  model leaves the actual picker rather than only the plugin's own list.

### Known limitations

- **A model that Zen stops listing cannot be re-checked.** One judged gone and then
  dropped from Zen's own catalogue is neither visible nor eligible for a round, so
  the only way it returns is for Zen to list it again. Fixing this would mean
  re-probing models the catalogue no longer offers, at inference cost.
- **The anonymous tier is shared per egress IP and gated upstream without notice.**
  It can refuse at any time; an optional API key raises the limit.
- **The check spends quota.** One round asks every visible model once. The daily
  round runs at most once per local day; the button is floored at five minutes.

### Design rationale

`docs/adr/0002-catalogue-source-of-truth.md` records the final decisions and the
evidence behind them, including two questions where measurement overruled the
original recommendation.