# Compat run

Developer verification through a packed plugin and real headless DSH, not the
user-facing availability probe. Run before releasing support for a new DSH
version. **It sends real inference requests, consumes shared anonymous quota,
and requires explicit authorization.** It stays outside CI ([ADR-0003](adr/0003-compat-run-not-in-ci.md)).

## Default verification mode

Unless the maintainer asks for full acceptance, a DSH upgrade is verified by two
runs, one after the other, each with its own `--out` directory:

```sh
pnpm compat --dsh <version> --l0-only --out .compat/<name>-l0-all
pnpm compat --dsh <version> --model deepseek-v4.1-flash-free --tools --out .compat/<name>-l12-one
```

1. **L0 on every free model:** each official free conversational model passes the
   availability probe.
2. **L1 and L2 on one model:** a real DSH final reply plus the read and shell
   tool checks. The default model is `deepseek-v4.1-flash-free`. If the official
   list no longer calls it free, pick another free conversational model and
   name it in the report.

Pass condition: both runs exit `0`. Exit `2` is incomplete, not a pass; run again
later. Report the two results separately and state that L1 and L2 were checked
on one model only, so full-model acceptance was not established. Both runs need
the same authorization as any compat run.

## Offline replay (no quota)

`pnpm replay --dsh <version>` runs six scenarios through the same isolated headless
DSH, with `opencode.ai` redirected to a loopback fake. It covers the model picker,
both wire channels, a tool loop with a follow-up turn, a context overflow,
compaction and a free-tier refusal. No request reaches Zen, so it needs no
authorization and consumes no anonymous quota; installing DSH still needs the npm
registry and the `openssl` CLI. It complements the live runs and never replaces
them: the fake cannot reproduce the real gate's admission checks. Design and
limits: [offline replay design](offline-replay-design.md). It also runs in CI as
the `replay` job ([ADR-0007](adr/0007-offline-replay-in-ci.md)), which is why it
is not bound by [ADR-0003](adr/0003-compat-run-not-in-ci.md).

## Run

Use Node matching `package.json` and pnpm from this clone. No global DSH or Zen
key is required. Run through pnpm: the driver needs its `npm_execpath`.

Full acceptance (L0, L1 and L2 on every free model), only when the maintainer
asks for it:

```sh
pnpm compat --dsh 0.2.2-rc.1 --tools --out .compat/<unique-name>
```

| Option | Meaning |
|---|---|
| `--dsh <version>` | Required; must match both exact DSH peer pins in `package.json`. |
| `--tools` | Adds read and shell checks. Required for full L0/L1/L2 acceptance. |
| `--l0-only` | Checks every free conversational model at L0 alone, from the one warmup probe round: about one request per model and no L1 or L2. Cannot be combined with `--model` or `--tools`; never full acceptance. |
| `--model <id>` | Restricts the run to one officially classified free conversational model; cannot establish full-model acceptance. |
| `--out <dir>` | Writes allowlisted Markdown and JSON reports. Without it, no report is written to the working tree. |
| `--keep` | Retains the temporary environment for debugging; otherwise it is removed. |

Use a unique output directory. Platform support is established only by the
recorded run, not by the driver's cross-platform implementation.

## Scope and isolation

1. Check the requested version against both peer pins before installation.
2. Fetch the official model list (`/inference/v1/models`) afresh each round and
   classify free conversational targets from its price, type, transport and
   effort fields, with code independent of the plugin catalogue
   ([ADR-0005](adr/0005-official-model-list-as-free-model-source.md)).
   Paid/non-conversational exclusions are recorded with their reason; an entry
   whose price cannot be read receives no inference and prevents complete
   acceptance. The documentation page is only a cross-check: disagreement is a
   warning in the report and never changes the targets. Never reuse a report as
   the next target list.
3. Pack the working tree and install it with the requested DSH in a fresh
   temporary `DSH_HOME` and workspace. Do not read or change user profiles,
   credentials, or running DSH processes.
4. Apply a headless overlay supplying the required loopback `webServer`, model
   selection and reasoning effort, with title inference disabled. Anonymous
   runs do not inherit `OPENCODE_API_KEY`.
5. Record the official list snapshot (time, entry count, free IDs, a digest that
   ignores volatile fields) and the actual probe targets. Do not drop failed
   models or combine different rounds to manufacture complete coverage.
6. Check that the plugin's picker offers exactly the official free set. A model
   it offers that the official list does not call free is a `plugin-fault`; a
   missing one is reported per model as before.

## Required evidence

| Layer | Pass condition |
|---|---|
| L0 | Target is in the provider catalogue and the actual availability probe returns `ok`. Catalogue membership is not a rendered picker test. |
| L1 | Real DSH finishes with exit 0 and exactly one valid final event containing nonempty assistant text. Status/thinking events alone do not pass. |
| L2 read | A host `read` call targets the current nonce file, with a paired completed result and the nonce in both result and final reply. |
| L2 shell | A host `pwsh` call on Windows, `bash` elsewhere, executes the intended hash command on a second random file; paired result and final reply contain the expected hash. |

The nonce/hash is absent from the prompt. Validate restored host arguments,
call/result IDs and order, file paths after normal resolution, required command
semantics, and completed results (`isError !== true`). Wrong tools, truncated or
malformed evidence, missing pairs, and final text without tool execution do not
pass. Preserve separate layer outcomes; later success cannot erase a failed L0.

L1/L2 use the host's JSON mode and lowest published valid reasoning effort;
where no levels are published, use and report the default. This does not test
all reasoning levels. Full acceptance needs a nonempty complete target set,
`--tools`, no `--model`, and every required layer passing in the same round.

## Verdicts and exit codes

| Verdict | Meaning |
|---|---|
| `ok` | All requested checks passed, including L0. |
| `rate-limited` | HTTP 429 remains after finite backoff. |
| `gate-refused` | Upstream authentication/admission refusal (401/403). |
| `upstream-down` | Upstream unavailability or a warmup `dead` result. |
| `plugin-fault` | Confirmed integration/behavior failure: missing adapter/model, empty reply, hang, missing catalogue coverage, or failed tool evidence. |
| `unverified` | Required checks were not completed. |

| Exit | Meaning |
|---|---|
| `0` | Nonempty targets passed every requested check; full-model acceptance additionally requires the complete scope above. |
| `1` | Setup/warmup failure or confirmed plugin/host fault; takes priority over incomplete upstream evidence. |
| `2` | Incomplete: quota, upstream refusal/unavailability, empty targets, uncertain classifications, scope drift, or unverified evidence. Not a pass or proof of a plugin fault. |
| `3` | Refused arguments/version/selection precondition; no installation or inference for the refused run. |

Models are spaced 3 seconds apart. HTTP 429 backoff is 30 then 60 seconds; after
three consecutive rate-limited models, stop and mark the rest unverified. No
unbounded retries or automatic retries of unavailable admission-tool calls.
There is no overall run time limit.

## Quota and keyed comparison

Warmup probes enabled targets (`--l0-only` stops there); L1 adds one request per tested model, L2 adds two,
and channel fallback or finite retries can add more. Do not promise a fixed
quota cost or anonymous success.

If `OPENCODE_API_KEY` is present, an anonymous `rate-limited` or `gate-refused`
model gets one extra keyed L1 comparison. It does not replace the anonymous
verdict, change its exit code, or establish anonymous acceptance. Reports record
key presence only, never the key.

## Reports and limits

Keep raw JSON events in memory. Persist only allowlisted status, classifications,
durations, layer/tool names and comparison booleans; not credentials, request
bodies, conversations, reasoning, or tool inputs/results. Record source revision,
packed tarball hash, resolved runtime versions, OS/Node, target sources/times,
requested layers, selection gaps, and runner/strict outcomes.

Headless results do not establish Web/Desktop UI or compaction behavior. Run output is
not committed: it holds only for the environment, versions and time it recorded.
