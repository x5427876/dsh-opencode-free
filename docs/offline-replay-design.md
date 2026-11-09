# Offline replay verification (design draft)

Status: draft for maintainer review. Not linked from the documentation index.
Requirements normally live in GitHub Issues; once accepted, move the scope there
and keep only the lasting decisions in an ADR.

## Goal

Cover what the live compat run cannot: long conversations, compaction, error
paths and multi-turn tool loops. The checks must be repeatable, use no shared
anonymous quota, and be able to run in CI.

Non-goals: replace the live compat run, verify the Web/Desktop UI, or prove how
the real upstream behaves today. A fake upstream can drift from the real one, so
this layer complements the live runs and never substitutes for them.

## Constraints found in the code

- `BASE_URL` is the constant `https://opencode.ai/inference/v1`
  ([`src/zen-provider.ts:24`](../src/zen-provider.ts)). The fetch guard and the
  node:http/https guard match that origin exactly.
- The transport already has one injection point: `patchGlobalFetchForZen(getSessionId, zenTransport)`
  takes a replacement transport for Zen requests.
- Existing tests mock at the `fetch` layer and with a raw TCP listener
  (`tests/inference-admission.test.mjs`). There is no loopback HTTPS server.
- [`docs/compat-run.md`](compat-run.md) forbids persisting request bodies,
  conversations or tool results in reports.

## Decision: no endpoint override in production code

A `ZEN_BASE_URL` environment variable would be the shortest path, but it lets
credentials and the free-tier identity headers go to any host the environment names.
Redirect below the plugin instead, from test-only code. Production code keeps one
fixed endpoint.

## Two tiers

| Tier | What runs | Fake upstream | Where |
|---|---|---|---|
| B1 in-process | `PiAiAdapter` and the plugin transport under `node:test` | `zenTransport` stub returning scripted `Response` streams | `pnpm test`, CI |
| B2 headless DSH | Packed plugin in a real headless DSH, as the live compat run does | Loopback HTTPS server; a test-only preload maps `opencode.ai` to `127.0.0.1` and trusts a throwaway CA | `pnpm replay`, local and CI |

B1 is cheap and exact. B2 proves the host wiring (compaction trigger, history
replay, tool loop) that B1 cannot reach.

## Scenario matrix

Each scenario is a scripted queue of upstream responses plus assertions.

| ID | Scenario | Assertion |
|---|---|---|
| S1 | Plain reply on `openai-completions` and on `openai-responses` | One final event with nonempty text |
| S2 | Two-turn tool loop (`read`, then `bash`), then a follow-up turn | Tool call/result IDs pair; the second request replays the first turn's history |
| S3 | Upstream 400 with the generic refusal over the window | Mapped error carries the overflow clause; host detector triggers compaction |
| S4 | Compaction round trip | A summary request (final user message starts "You are now acting as a compaction engine", `max_tokens` = `headroomTokens`) precedes the main request; the main request replays fewer messages than the history |
| S5 | 429 then 200 | Finite backoff, one retry path, no unbounded loop |
| S6 | 401 and 403 | Verdict is a refusal, not a crash; no credential in logs |
| S7 | Stream cut mid-event and idle timeout | Error surfaces; no hang |
| S8 | Request carries more images than the route limit (alpha.3) | `IMAGE_OFFLOAD_REQUIRED` handling continues the conversation |
| S9 | Lowest and highest published reasoning effort | Request carries the expected effort field; reply parses |
| S10 | `/models` listing with a model added and one removed | Picker offers exactly the free set |

Request-side assertions apply to every scenario: tool names match
`GATE_TOOL_ALIASES`, the identity headers are present, an anonymous run sends
only the anonymous credential, and no request body or key appears in logs.

## Fixtures

Hand-author synthetic fixtures from the documented protocol shapes in
[`protocol-notes.md`](protocol-notes.md). Do not record real conversations: a real
capture can hold user content, and the compat-run report rule forbids persisting
it. Keep fixtures small, under `tests/fixtures/replay/`, one file per scenario.

## Relation to existing decisions

- [ADR-0003](adr/0003-compat-run-not-in-ci.md) keeps *live* requests out of CI
  because the anonymous bucket is shared. Offline replay sends no live request, so
  it does not conflict; state that in `compat-run.md` when the layer lands.
- [ADR-0005](adr/0005-official-model-list-as-free-model-source.md) still decides the
  free set. S10 only checks the plugin follows whatever list it is given.
- "No endpoint override in production code" is a lasting trade-off, recorded in
  [ADR-0007](adr/0007-offline-replay-in-ci.md).

## Phases

1. **Spike (done, go for B2).** See [Spike results](#spike-results-dsh-022-alpha3-macos-node-26).
   S4 was reproduced afterwards; see the recipe below.
2. **B1 scenarios (done for the provider-level set):** `tests/replay-provider.test.mjs`
   with the scripted upstream in `tests/helpers/replay-upstream.mjs`, run by
   `pnpm run check`. It covers S1, S2 (provider level: tool call out, tool result
   replayed, one session identity), S3 (with and without a lowered `max_tokens`),
   S5, S6, S7 and S9. Each scenario was checked against a deliberate break in
   `src/zen-provider.ts`; all nine breaks were caught. Not in B1: S4 compaction and
   the host side of S2 (they need a real DSH, so B2), S8 (the image limit lives in
   the host's pi-ai adapter, not in this plugin), and S10 (the catalogue tests
   already cover list changes; B2 adds the picker).
3. **B2 harness (done):** `pnpm replay --dsh <version>` (`scripts/replay-run.mjs`,
   `replay-scenarios.mjs`, `replay-upstream.mjs`, `replay-preload.cjs`,
   `replay-env.mjs`). Six scenarios R1–R6 passed on DSH 0.2.2-alpha.3 and again on
   0.2.2-rc.1: picker (S10),
   plain reply on both channels (S1), tool loop and follow-up (S2), overflow (S3),
   compaction replacing old turns with the summary (S4) and a free-tier refusal (S6).
   Plugin breaks were caught by R1, R2, R4 and R6; R5 fails without the compaction
   settings. R3 and R5 mostly exercise the host, so a plugin break is less likely to
   show there. Safety: the driver aborts before any probe unless the plugin's own
   model-list fetch reached the fake.
4. **Docs and CI (done):** `compat-run.md`, `upgrade-evaluation.md` and
   `AGENTS.md` updated, [ADR-0007](adr/0007-offline-replay-in-ci.md) added, and
   `.github/workflows/ci.yml` has a `replay` job (B1 runs in `check`). The job has
   not run on GitHub yet.

## Acceptance

- B1 and B2 pass offline with the network disabled.
- Each scenario fails when its target behavior is broken (mutate the code once to
  confirm).
- No fixture, report or log contains a credential or a real conversation.
- The default verification mode in `compat-run.md` lists the replay run next to the live runs.

## Spike results (DSH 0.2.2-alpha.3, macOS, Node 26)

Phase 1 ran a packed plugin in an isolated `DSH_HOME` against a loopback HTTPS
fake. No request reached the real upstream: every request in the logs came from
the fake, and the redirect hook fired for each connection.

| Question | Result |
|---|---|
| Runtime of the headless DSH | Node. `lib/bin.js` has a `#!/usr/bin/env node` shebang, `engines.node >= 24.9.0`, and no re-exec. A `NODE_OPTIONS` preload applies. |
| Redirect `opencode.ai:443` to loopback | Works with a test-only preload that rewrites `tls.connect` options (keeps SNI `opencode.ai`) plus `NODE_EXTRA_CA_CERTS` for a throwaway CA. It covers both the plugin's `node:https` transport and `fetch`. A `dns.lookup` hook was not needed. |
| Plugin boot, catalogue, probe | Pass. `/models` from the fake gives `source: official`; the probe POST is admitted with the anonymous credential and the `x-opencode-*` headers. |
| S1 plain reply through real DSH | Pass. Exit 0, one `final` event with the scripted text. |
| S2 tool loop | Pass. The fake answered with a `read` tool call; DSH ran it and sent the tool result back; the second request ended with `lastRole: tool`. |
| S2 follow-up turn | Pass. `--session-id <id>` resumes a session; the request replays the earlier messages (4, then 6, 8, 10). |
| S3 overflow mapping | Pass in a small window. With `limit.context` 4000, the plugin lowered `max_tokens` to 1; a generic 400 became `CONTEXT_WINDOW_EXCEEDED` with the overflow clause, and the host retried once. |
| S4 compaction | Pass with a tuned window (recipe below). The summary request and the following main request were both observed. |

Observations that shape the harness:

- The context window comes from the fake's `limit.context`, so the fixture
  controls it. The driver needs `/refresh` and `/probe` through the plugin's panel
  routes before a run, as `scripts/compat-run.mjs` does; without them the model is
  unknown (`UNKNOWN_MODEL`).
- Compaction pressure is the provider-reported input usage of the last turn
  (`inputTokens` plus cache tokens), compared with
  `min(0.8 * window, window - reserved output - headroomTokens)`. The default
  headroom is 65536. A small window with the default headroom leaves no pressure
  budget, so `compaction-basic` raises a config error and skips compaction
  silently (the warning is not on stderr). That is why the earlier 4000-token
  attempt showed nothing. Reported usage alone is not enough either: a history of
  four short messages has no safe range to compact.
- Recipe that triggered it: fixture `limit` of 40000 context and 4000 output; overlay
  `compaction-basic` with `headroomTokens: 1000`; the fake reports 33000 input
  tokens per reply; each turn sends about 8 KB of text through `--session-id`.
  Compaction first ran on the fifth turn.
- Observed compaction request: a normal chat-completions request with the gate's 23
  tool declarations and the usual agent system prompt, whose final user message
  begins "You are now acting as a compaction engine". Its `max_tokens` equals
  `headroomTokens`. The main request that follows replays fewer messages. The
  plugin's compaction system-prompt swap targets Pi's own prompt and did not
  apply here.
- The fake's tool-call trigger matches the whole history, so a follow-up turn also
  triggered a tool call. Scenario scripts need a per-turn selector.

## Open questions and unverified points

- **Compaction (S4).** Reproduced offline. Open: assert what the summary becomes in
  the replayed history (the fake returns plain text as the summary), and check
  the overflow-recovery path (`maxOverflowRetries`) with a window large enough
  to keep compaction enabled.
- **Multi-turn driving.** Resolved for the CLI: `--session-id` works. The SDK added in
  alpha.3 is not needed.
- **Other platforms.** Only macOS was tried. The preload and CA flow should be
  platform-neutral but is unverified on Linux and Windows.
- **TLS fidelity.** The fake server cannot reproduce the real gate's cipher
  check, so admission behavior stays a live-only check.
