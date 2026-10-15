# Compat run

Developer verification through a packed plugin and real headless DSH, not the
user-facing availability probe. Run before releasing support for a new DSH
version. **It sends real inference requests, consumes shared anonymous quota,
and requires explicit authorization.** It stays outside CI ([ADR-0003](adr/0003-compat-run-not-in-ci.md)).

## Run

Use Node matching `package.json` and pnpm from this clone. No global DSH or Zen
key is required. Run through pnpm: the driver needs its `npm_execpath`.

```sh
pnpm compat --dsh 0.2.1-alpha.3 --tools --out <unique-report-directory>
```

| Option | Meaning |
|---|---|
| `--dsh <version>` | Required; must match both exact DSH peer pins in `package.json`. |
| `--tools` | Adds read and shell checks. Required for full L0/L1/L2 acceptance. |
| `--model <id>` | Restricts the run to one officially classified free conversational model; cannot establish full-model acceptance. |
| `--out <dir>` | Writes allowlisted Markdown and JSON reports. Without it, no report is written to the working tree. |
| `--keep` | Retains the temporary environment for debugging; otherwise it is removed. |

Use a unique output directory. Platform support is established only by the
recorded run, not by the driver's cross-platform implementation.

## Scope and isolation

1. Check the requested version against both peer pins before installation.
2. Fetch official live model IDs and current official pricing/endpoint evidence
   afresh each round. Classify free conversational targets independently of the
   plugin catalogue ([ADR-0004](adr/0004-official-dynamic-compat-targets.md)).
   Paid/non-conversational exclusions need evidence; uncertain IDs receive no
   inference and prevent complete acceptance. Missing models.dev metadata cannot
   silently remove an official target. Never reuse a report as the next target list.
3. Pack the working tree and install it with the requested DSH in a fresh
   temporary `DSH_HOME` and workspace. Do not read or change user profiles,
   credentials, or running DSH processes.
4. Apply a headless overlay supplying the required loopback `webServer`, model
   selection and reasoning effort, with title inference disabled. Anonymous
   runs do not inherit `OPENCODE_API_KEY`.
5. Record the fixed target snapshot and actual probe targets. Do not drop failed
   models or combine different rounds to manufacture complete coverage.

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

Warmup probes enabled targets; L1 adds one request per tested model, L2 adds two,
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

Headless results do not establish Web/Desktop UI or compaction behavior. Read
[dated reports](compat-reports/) only for the recorded environment. The original
alpha.3 inspection and false-pass analysis are [archived](archive/compat-acceptance-alpha3.md),
not an additional current procedure to execute.
