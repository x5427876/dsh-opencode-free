# Compat run (相容性驗證)

The compat run answers one question for each DSH release: do Zen's free models
still work through **real DSH** with this plugin? It installs a given DSH
version and the plugin packed from this repository into a throwaway
environment, sends one request per free model through a headless DSH, and
prints a matrix with the reason for each result.

It is not the plugin's **probe (探測)**. The probe is the user-facing
availability round built into the plugin. It calls the provider directly and
covers the models the user has switched on. The compat run is a developer
procedure. It goes through DSH's `PiAiAdapter`, which is where host upgrades
have broken the plugin before, and it covers every free model Zen serves. See
[`CONTEXT.md`](../CONTEXT.md).

## When to run it

Run it before releasing support for a new DSH version (see
[`AGENTS.md`](../AGENTS.md#dsh-upgrades)). It is not part of CI. The anonymous
quota is shared per egress IP, so a CI result would depend on other people's
usage ([ADR 0003](adr/0003-compat-run-not-in-ci.md)).

## Prerequisites

Node (matching `engines` in `package.json`) and pnpm. No Zen key, no global DSH,
no bash. It runs the same way on Windows, macOS, and Linux.

Run it through pnpm, not `node` directly. The script calls pnpm through
`npm_execpath` so that it needs no shell.

## Running it

```sh
pnpm compat --dsh 0.2.1-alpha.1
```

| Option | Meaning |
| --- | --- |
| `--dsh <version>` | Required, no default. The DSH release to install. It must equal the exact peer pin of `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-llm-pi-ai` in `package.json`. Otherwise the run stops before installing anything, because DSH would skip the plugin. |
| `--tools` | Also verifies a tool round-trip (L2). Off by default to keep the run short. |
| `--keep` | Keeps the temp environment and prints its path, for debugging. By default it is deleted. |
| `--out <dir>` | Writes the matrix (`.md`) and JSON into `<dir>`. Without it, nothing is written to the working tree. |

`OPENCODE_API_KEY` is detected from the environment. It is not an option (see
[Keyed comparison](#keyed-comparison)).

## What it does

1. **Preconditions.** It checks `--dsh` and the peer pin before any install or
   request.
2. **Live list.** It fetches Zen's `/models` list and keeps the ids that
   models.dev marks free. The report lists ids only in the live list and ids only
   in the plugin's builtin list. If either source fails, the run stops with exit
   code 2. It never falls back to the builtin list.
3. **Isolated environment.** It creates a fresh directory under the system temp
   directory and uses pnpm to install `@deepseek-ai/dsh@<version>`. It runs
   `pnpm pack` on this repository and installs the tarball into the built-in
   `headless` profile with `DSH_HOME` pointing at the temp directory. It never
   reads or changes `~/.dsh`, and it never starts, stops, or restarts an existing
   DSH.
4. **Overlay.** Each DSH process gets a `--patch` overlay with three entries. It
   adds the `webServer` service that the plugin requires, using a free port
   bound to `127.0.0.1`. It sets the default model and `reasoningEffort`, and
   it disables `session-title-llm`. Without that last change, every run would
   spend a second request on a session title.
5. **Warmup (L0).** One DSH process boots and waits on stdin. The run calls the
   plugin's public panel routes: `POST /refresh`, `POST /probe`, `GET /probe`
   until the round ends, and `GET /catalog`. It never reads the plugin's cache
   file. The round's per-model results and the picker list become L0. Because
   the plugin records the round, the later processes do not start another one.
6. **L1.** For each model, one headless DSH process sends `Reply with OK only.`
   at the model's lowest published effort level. A model without published
   levels (a toggle model or no list) uses the default and is marked
   `no published levels (無等級可選)`. In that case the reasoning mapping was not
   exercised. A non-empty reply passes. Models that answered in the warmup
   round run first. The others follow in Zen's order.
7. **L2 (`--tools`).** A model that passed L1 is asked to read a file containing
   a random nonce and reply with its contents. It is then asked to run a shell
   command that prints the SHA-256 prefix of a second nonce file: `pwsh` on
   Windows, `bash` elsewhere. The nonce never appears in the prompt, so a
   model cannot pass by guessing or echoing. Each step is judged and reported on
   its own.

Models are spaced 3 seconds apart. A 429 is retried after 30 seconds, then
after 60 seconds. A model that still gets 429 is `rate-limited`. If three models
in a row are rate-limited, the run stops and lists the rest as unverified. The
run has no overall time limit.

## Verdicts

| Verdict | Meaning | Affects exit code |
| --- | --- | --- |
| `ok` | Answered through DSH (and passed both tool steps with `--tools`). | – |
| `rate-limited` | Still 429 after back-off. Inconclusive: neither a pass nor a failure. | 2 |
| `upstream-down` | Upstream says the model is unavailable (`Model/Endpoint is unavailable`, HTTP 5xx), or the warmup round judged it dead. | no |
| `gate-refused` | HTTP 403/401. Zen's admission policy may have changed, so revisit the anonymous tool gate. | no |
| `plugin-fault` | Anything on the plugin or DSH side: `NO_ADAPTER`, `UNKNOWN_MODEL`, the plugin not loaded, an empty reply, a hang, a live model missing from the picker, or a failed tool step. | 1 |
| `unverified` | Not asked, because the run stopped after three rate-limited models in a row or the warmup failed. | 2 |

The report also records each model's layer. L0 means the model is in the DSH
picker and in Zen's list. L1 means DSH returned a reply. L2 means the tool
round-trip passed. The report also gives the effort level used and the reason
for any failure.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Every model was verified and none is a `plugin-fault`. |
| 1 | At least one `plugin-fault`, or the setup or warmup failed. Something needs fixing. This takes priority over 2. |
| 2 | Nothing is broken, but the run did not finish: models are `rate-limited` or unverified, or the live list could not be fetched. Run it again later. |
| 3 | A precondition was refused: `--dsh` was missing or does not match the peer pin, or an argument is invalid. Nothing was installed or sent. |

## Keyed comparison

When `OPENCODE_API_KEY` is set, a model whose anonymous verdict is
`rate-limited` or `gate-refused` gets one extra L1 request with the key. The
result appears in the `with key` column next to the anonymous verdict. It does
not replace that verdict or change the exit code, because the anonymous path is
what the plugin promises. Without a key, the run does not repeat any request.
Anonymous requests never inherit the key. The report records only whether a key
was present. The key is removed from all DSH output before classification.

## Quota

The run spends the shared anonymous quota. The warmup sends one request for each
model the plugin lists. L1 sends at least one more request for each model.
`--tools` adds two more, and each 429 retry adds another. When the quota is
already used up, the honest result is `rate-limited` or unverified, with exit
code 2.

## Reading the report

The header records the DSH version, plugin version, date, OS, key presence,
`--tools`, and the verification path. The path is the built-in `headless`
profile plus an overlay. It uses the same `PiAiAdapter` path as the web
profile, but it is not the profile users run, so a pass is **not** a web UI
verification. The JSON contains the same facts as the matrix and also
includes each model's warmup probe row.
