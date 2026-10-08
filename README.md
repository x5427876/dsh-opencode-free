# dsh-opencode-free

**English** | [繁體中文](README.zh-TW.md)

[![npm](https://img.shields.io/npm/v/dsh-opencode-free)](https://www.npmjs.com/package/dsh-opencode-free)
[![CI](https://github.com/x5427876/dsh-opencode-free/actions/workflows/ci.yml/badge.svg)](https://github.com/x5427876/dsh-opencode-free/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Use the free [OpenCode Zen](https://opencode.ai/docs/providers) models in
DeepSeek Harness (DSH). You do not need to
install OpenCode, log in, get an API key, or run a separate server.

> [!WARNING]
> This is an unofficial community plugin. It is not affiliated with OpenCode or
> DeepSeek. It reaches the keyless free tier by sending the OpenCode CLI
> identity. The upstream has no third-party contract, so it can stop working at
> any time. See [How it works](#how-it-works).
>
> Like any DSH plugin it runs with the host's privileges; it also wraps the
> process-wide `fetch` and `node:http(s)` for Zen requests (see
> [What it patches in your process](#what-it-patches-in-your-process)). Read
> DSH's [safety notice](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)
> before installing third-party plugins.

## Features

- Free Zen models in the DSH model picker, under the `opencode-zen-free` provider.
  The list follows models.dev and refreshes itself; a per-model switch on the
  plugin's detail page hides the ones you never pick.
- A live availability check on the detail page. It removes a model only when the
  route positively refuses it, so a gated or throttled round never costs you one.
  See [Availability check](#availability-check).
- Anonymous by default. A Zen API key is optional.
- Native streaming through pi-ai: text, reasoning, tool calls, usage, and abort.
- Tools run inside DSH. The Windows `pwsh` shell works too.
- Clear error messages when the upstream rejects a request.

## Requirements

| Requirement | Version |
|---|---|
| DeepSeek Harness | `0.2.1-alpha.1` (exact) |
| Node.js | `^22.19.0` or `>=24.0.0` |

Each plugin release pins one exact DSH version. Check yours first:

```sh
dsh --version
```

| Plugin | DSH |
|---|---|
| `0.3.1` | `0.2.1-alpha.1` |
| `0.3.0` | `0.2.0-rc.2` |
| `0.2.1` | `0.2.0-rc.2` |
| `0.2.0` | `0.2.0-rc.1` |
| `0.1.3` – `0.1.4` | `0.1.7-rc.2` |

The four peer dependencies are **required**: `src/` imports each of them at the
top level, so a host missing one fails to load the plugin. Do not ignore peer
dependency warnings.

## Install

Install the pinned package from npm:

```sh
dsh plugin --profile web add dsh-opencode-free@0.3.1
```

The examples use the `web` profile. Replace it with your target profile.

Check the install:

```sh
dsh plugin --profile web list dsh-opencode-free --depth 0
```

The install is correct when the package appears once. To confirm the plugin also
reached the composed config, run `dsh --profile web --dump-config` and look for
`opencode-free`.

Other profiles and plugins do not change.

Update or remove:

```sh
dsh plugin --profile web update dsh-opencode-free
dsh plugin --profile web remove dsh-opencode-free
```

## Usage

Restart DSH (or let HMR reload it). Open the model picker and select a model
under **OpenCode Zen Free**.

### The model list

The list is not hard-coded, so this page does not name the models. Open the
picker to see the current ones; the latest live check results are in
[`docs/compat-reports/`](docs/compat-reports/).

- **Source.** [models.dev](https://models.dev) says which models are free, what
  they are called, and how large their context is. Zen's own `/models` endpoint
  says which of them Zen serves right now. A newly published free model appears
  on its own; there is nothing to reinstall.
- **Refresh.** models.dev is read in the background about once a day and never
  blocks a request. Zen's list costs no inference quota, so it is re-read every
  30 minutes, and a withdrawn model leaves the picker within minutes.
- **Not yet published.** If Zen serves a free model that models.dev has not
  published, the detail page names it but the picker does not offer it: its
  context length and capabilities are not knowable, and a wrong number would be
  acted on.
- **Offline or first start.** With neither network nor a cached copy, the plugin
  falls back to the model set that ships inside pi-ai and the detail page says
  so. A failed refresh never empties the list.
- **Detail page.** Models are listed alphabetically with the ones you have
  switched on at the top. Each row carries a switch that hides it from the
  picker, badges for vision, thinking and tool calls, and **the two limits the
  request actually uses** — context window and maximum output. A badge or a
  number marked with a tick was measured on this route; one without was copied
  from models.dev. When a measurement replaced a declaration, the declaration is
  struck through beside it (`context 200,000 → 1,048,576`), because a stale
  number and a measured one look identical otherwise — which is exactly why the
  panel used to be unable to tell you which it was showing.

### Reasoning and capabilities

DSH passes your reasoning level through, and the ladder offered comes from
models.dev per model (Muse Spark gets `minimal`…`xhigh`, Space Bunny gets
`low`…`max`). A level a model does not publish is never offered.

Tool calls work, and that is now a measurement rather than an admission
requirement: asked to run one command, every model that answered this round
answered with a real tool call and the right arguments — 9 of 9 on the live set
(2026-10-07). The models that never answered failed identically with and
without tools, which is an upstream condition rather than a missing capability.
The free tier still admits a request only when it carries `read` and `bash`,
which is a separate requirement and is not what this sentence means.

`off` is the exception: it is **measured, not assumed**. The round asks the
model for no reasoning and for its own lowest level, compares the reasoning
tokens against that model's own baseline, and offers `off` only when the
answer is a real reduction — the exact `none` where the model reaches zero,
otherwise the lowest level that measurably helps. A model whose reasoning the
route never reports gets no `off` row at all, rather than a row that does
nothing. If you choose nothing, Muse Spark uses `xhigh`.

Vision works too: a screenshot is attached only to a model that declares image
input, and asking each of those models to name the colour of the top half of a
two-tone image returned the right colour on every model that answered (5 of 5,
2026-10-07).

The context size and the output budget in the picker are measured, not copied —
and they are two different kinds of number, which the picker labels separately.

**Context** is a real ceiling, read off the endpoint's own refusal: Mimo V2.6
Flash declares 200,000 and its endpoint says its maximum is 1,048,576. That one
is a capability, and it is what decides when the conversation is compacted.

**Output budget** follows models.dev — with one exception. The route enforces
`max_tokens` (asked for 8 with a prompt that wanted thousands, the models that
answered all stopped at exactly 8 with `finish_reason: "length"`), so a
declaration that is too low really does cut a reply at the declaration with
nothing reporting it. But that only proves the field is enforced, not that a
model writes what it is given: on 2026-10-07 every route accepted budgets up to
1,040,384, and no model has ever been seen writing anything like it. So the rule
is that **only a stated ceiling or a watched generation moves this number**.
Xiaomi publishes [MiMo-V2.6-Flash](https://mimo.mi.com/models/en-US/mimo-v2.6-flash)
at 128K max output while models.dev says 32,000; Longcat's route names its own
ceiling outright (`/max_tokens: 995834 is not less or equal to 262144`) while
models.dev says half of it. Both statements cost nothing — a refusal returns a
number — and both now bound the budget. A watched generation bounds it too:
Mimo wrote 79,722 tokens when asked for 131,072, and Big Pickle 48,000. Every
other model's budget is exactly what models.dev says, and the row shows an arrow
only where that is not true.

Worth knowing why some models have no figure: models choose when to stop, so the
same request produced 892 tokens once and 79,722 the next. And for several of
them the budget is not the constraint at all — throughput measured between 34 and
365 tokens a second, so the ten-minute request timeout ends a reply between
roughly 28,000 and 295,000 tokens, which for a model declaring 128,000 or
262,144 means the clock binds first.

The other half of that answer costs nothing and is collected automatically: when
the route refuses a request, the numbers it names **are** its own limits — "does
not exceed 262144" for output, "maximum context length of 262139" for context —
and the check reads them out of the refusal and remembers them per model. A
refusal produces no output tokens at all, so this is the one ceiling measurement
that is free, and it is the one that catches a stale declaration: it is how
Big Pickle's window was found to be four times what the model really has. A
route that answers instead of refusing has stated nothing, which is recorded as
such rather than as a guess.

Time is the ceiling nobody sees. Mimo V2.6 Flash writes at about 150 tokens a
second, so a single reply ends at roughly 90,000 tokens when the 10-minute
request timeout arrives, whatever the budget says. Nothing reports that: a reply
that stops at its own limit looks exactly like a finished one. It used to be
worse, at 3 minutes — which was under the declared budget, so no budget could
have helped until the timeout moved.

### Availability check

The detail page runs a check on the models you have switched on, and shows its
progress as it goes: a counter, a latency for each model that answered, and a
spinner on the one being asked. The result stays on screen across a DSH restart
until the next round replaces it.

- **When.** Once per local day, started when the model list is read, plus the
  **Probe now** button at any time. If you never open the model list, you never
  pay. Two clicks inside five minutes: the second is refused and says how long
  is left, rather than starting a round and leaving you watching a spinner.
- **How.** The round first reads Zen's catalogue (one `GET`, no inference
  quota); a model Zen no longer lists is dropped without a completion being
  sent. Then each model is asked one at a time, because anonymous callers share
  one quota bucket.
  - **Once a day**, every model Zen still lists gets **one** short request —
    including the ones you switched off, because a hidden model's status is
    exactly what nobody would otherwise find out. A model that fails costs one
    request, not more.
  - **Probe now**, only the models you have switched on, and it keeps asking
    each of them until the measurement is finished (up to nine requests), so
    one click can finish the job instead of starting it. The report says what
    that cost and how many models still owe samples. Part of that budget asks
    the **capability** questions nobody had ever asked: give the model an image
    and check it names the right colour, give it real tools and check it calls
    one. Each axis is asked **once per model** and the answer is kept, so a model
    you keep using costs nothing after the first round — and a round that learns
    nothing writes nothing, leaving the badge unmarked rather than claiming the
    model cannot do it.
- **What removes a model.** Only a positive answer: Zen stops listing it, or the
  route says it will not serve it (`Model is unavailable.`,
  `Model <id> is not supported`, `Model <id> has been deprecated`, `404`,
  `410`). Zen does not publish which endpoint serves which model, so a model is
  asked on both endpoints this provider implements before it counts as gone —
  and a channel that answers nothing cannot overrule one that named the model,
  or a wrong channel's `not supported for format` would retire every model. models.dev's `deprecated` flag
  never decides this: on this provider it can mean the free tier ended or only
  that the record is stale.
- **What does not.** A gate refusal, exhausted quota, rejected key, dropped
  network, an overloaded upstream, or a whole endpoint being down. Those rounds
  learned nothing about any model, so the rows turn grey "not measured" instead
  of red, and **the row names the condition inline** (`not measured · quota
  spent`), with the HTTP status and what to do about it in its tooltip. A red
  row is a statement about the model and always names its reason.
- **A removal is final.** A model the route has refused is not asked again,
  because re-asking a settled question only spends quota. A Zen key does not
  bring it back: **a key changes your quota, not the model list**, and a model
  the route refuses is refused with a key too. A model Zen simply stops listing
  is different: it reappears when Zen lists it again.

To have the whole catalogue judged again, for example after Zen fixes a channel,
delete the plugin's cache file and restart DSH once:

```
$DSH_HOME/dsh-opencode-free/catalog.json     # falls back to ~/.dsh/… when DSH_HOME is unset
```

`$DSH_HOME` takes priority when it is set, which is the common case for a DSH
Desktop profile; deleting the `%USERPROFILE%\.dsh\…` path there changes nothing.
The next start re-reads models.dev, treats every model as unprobed, and probes
them all again. This is the only way back.

The reasoning behind these rules is in
[`docs/adr/0002-catalogue-source-of-truth.md`](docs/adr/0002-catalogue-source-of-truth.md).

## Configuration

### Zen API key (optional)

Without a key, the plugin sends `Authorization: Bearer public` and no personal
credentials. If the anonymous tier rejects you, the plugin reports the error.
It never asks for a key or switches to a paid model on its own.

To use a key, choose one:

1. Add `apiKey` to the plugin's `config`. This takes effect on reload.
2. Set the `OPENCODE_API_KEY` environment variable.

Priority: `apiKey` config, then `OPENCODE_API_KEY`, then anonymous `public`.

DSH Desktop has no shell environment, so use option 1. Override the plugin
entry in the profile's `cordis.patch.yml`:

```yaml
- id: opencode-free
  name: dsh-opencode-free
  config:
    apiKey: <your Zen key>
```

Verify the key before you chat. This sends one 16-token request:

```sh
# The key goes into the environment, never onto a command line:
read -rs -p "Zen key: " OPENCODE_API_KEY; echo
OPENCODE_API_KEY="$OPENCODE_API_KEY" ./scripts/reverify.sh
unset OPENCODE_API_KEY
```

Check lamp ③. Green means the key works. Red means the key is invalid or the
upstream has a problem.

## How it works

The plugin registers the `opencode-zen-free` provider through DSH's
`PiAiAdapter`. It sends requests straight to `https://opencode.ai/zen/v1` with
pi-ai's own transports: Responses for Muse Spark, Chat Completions for the
other models. The approach follows Pi's
[`pi-opencode-direct`](https://github.com/Aymendje/pi-opencode-direct).

The anonymous tier accepts a request only when it looks like the OpenCode CLI:

- the OpenCode `User-Agent` and `x-opencode-*` headers, with a valid `ses_` session ID;
- `stream: true`;
- tools named exactly `read` and `bash`.

On Windows, DSH ships `pwsh` instead of `bash`. For anonymous requests, the
plugin sends `pwsh` as `bash` and renames the returned calls back to `pwsh`.
Requests without tools (titles, compaction) get inert placeholder tools.
Requests with an API key are never rewritten.

The availability probe re-asserts the `read` and `bash` tool names on the final
payload, at the last boundary before the bytes leave. Everything above that
boundary can drop them, and a request that arrives without them is refused on
every model — so the probe guarantees its own admission instead of assuming the
layers above passed them through.

The full investigation, with replay results and diagnostic principles, is in
[`docs/reverse-engineering.md`](docs/reverse-engineering.md).

### What it patches in your process

`apply()` wraps three process-wide entry points so that requests the plugin
does not make itself still carry the OpenCode identity:

- `globalThis.fetch`
- `node:http` and `node:https` — their `request` and `get`

The scope is strictly the Zen base URL `https://opencode.ai/zen/v1`. Every other
host and path is passed through untouched, with the original arguments
byte-for-byte. The wraps are idempotent across reloads (the pristine originals
are stashed on `globalThis` under `__dshOpenCodeFree*`) and are restored when the
plugin is unloaded. If you run another extension in the same process that talks
to that base URL, its requests will be given the same identity headers.

## Troubleshooting

**The card's rows are grey "not measured" but the model chats fine**
The probe was refused by the gate while your own requests went through. The
refusal is reported as a banner that names which upstream condition answered,
and it is not a verdict about the model: nothing was removed from the list, and
press **Probe now** to ask again.

**`403 FreeTierError ... only be used from within OpenCode`**
Run `./scripts/reverify.sh`. Lamp ② sends a request that meets every known
gate condition. If lamp ② is yellow, the upstream gate changed. This is not a
configuration problem.

**HTTP 200, but no reply**
A `200` means the request passed the gate. If no content follows, that model
is stalled upstream. Try another model, or test it directly:

```sh
pnpm run build
node scripts/test-live.mjs nemotron-3.5-lightning-free
```

**Debug logs**
Set `DSH_OPENCODE_FREE_DEBUG=1` before you start DSH. The plugin logs the
outbound identity, the request shape, the status of every Zen request, and —
when a probe is refused — the upstream error body truncated to 300 characters.
It never logs conversation content. The identity line does print the first 14
characters of the `Authorization` header, so treat the log as private once a
key is configured.

## Development

For contributions and reviews, read the [engineering standards](docs/standards.md)
and [known gaps](docs/standards-gap.md).

Edit `src/*.ts`. Do not edit `lib/`: `tsc` generates it.

```sh
pnpm install
pnpm run typecheck  # strict type check
pnpm run build      # emit lib/
pnpm run test       # build, then run offline tests
pnpm run check      # typecheck, test, and pack
```

The unit tests use in-memory fixtures and a temporary `$DSH_HOME`. They do not
use the network or free quota.

These scripts send real requests to the shared anonymous bucket:

| Script | What it checks |
|---|---|
| `scripts/reverify.sh` | ① catalogue reachable, ② anonymous gate, ③ API key (only when `OPENCODE_API_KEY` is set) |
| `node scripts/test-live.mjs [model-id ...]` | Sends one short anonymous request per model. It declares no tools, so a `replied:false` usually means the gate said no rather than that the model is gone — it is not an availability test. Run `pnpm run build` first. |
| `node scripts/probe-ab.mjs [heavy light]` | A/Bs the probe's output budget against the live tier (default 1024 vs 16). **Consumes real quota across the whole catalogue** and is how `PROBE_MAX_TOKENS` was chosen — see `docs/adr/0002`. Run `pnpm run build` first. |
| `pnpm compat --dsh <version> [--tools] [--keep] [--out <dir>]` | The compat run: installs that DSH and this repo's packed plugin in a temp `DSH_HOME` and verifies every Zen free model through real headless DSH. Exit `0` verified, `1` plugin-fault, `2` unfinished (rate-limited), `3` precondition refused. Required before releasing a new DSH version; not run in CI. See [`docs/compat-run.md`](docs/compat-run.md). |

For Agents that install or verify this plugin, see [`AGENTS.md`](AGENTS.md).

## Model Experience

Every change below applies only to anonymous requests to Zen. A request that
carries a Zen key reaches the model unchanged.

### Shell tool name on Windows

#### What the model sees

When the request offers DSH's `pwsh` tool and no `bash` tool, the model sees the
same tool named `bash`, in the tool list and in every earlier tool call and
result of the conversation. Calls the model returns as `bash` reach DSH as
`pwsh`.

#### Token effect

None beyond the name itself: the description and parameters are unchanged.

#### KV Cache effect

Prefix-stable: the rename is applied to the whole history on every anonymous
request, so consecutive requests share the same prefix. Switching a session
between a key and anonymous changes the tool name and invalidates reuse.

### Placeholder admission tools

#### What the model sees

When a request lacks a tool named `read` or `bash` (titles, compaction, or a
profile without those tools), each missing one is added with no parameters and
the description:

```markdown
Unavailable in this request. Do not call.
```

#### Token effect

Conditional: up to two short tool definitions per affected request.

#### KV Cache effect

Prefix-stable for a given tool set; the placeholders are added at the same
position on every affected request.

### Compaction prompt

#### What the model sees

When a request has no tools and a single user turn, and its system prompt is at
most 2,000 characters and contains `context summarization` (the host's
compaction prompt), the system prompt is replaced by OpenCode's:

```markdown
You are a context summarization agent. You are given a conversation between a user and an agent. Your goal is to produce a structured summary matching the format specified so another coding agent can continue the work.
Always follow the exact output structure requested by the user prompt. Keep every section, preserve exact file paths and identifiers when known, and prefer terse bullets over paragraphs.
Do not continue the conversation. Do not respond to any questions in the conversation. Only output the structured summary in the exact format requested by the user prompt. Respond in the same language as the conversation.
```

The user turn that holds the conversation is not changed.

#### Token effect

Replaced: the system prompt's tokens become those of the text above.

#### KV Cache effect

Independent: a compaction request is its own model request and shares no
prefix with the chat.

## Known Limitations

- **One DSH version per release.** The peer pins are exact; DSH skips the
  plugin on any other version (see [Requirements](#requirements)).
- **Unofficial access.** The keyless tier has no third-party contract; an
  upstream change can refuse every anonymous request without notice.
- **Shared anonymous quota.** The free tier is shared by everyone behind the same
  egress IP, so a dry bucket can look like a broken model. A Zen key avoids it.
- **`webServer` is required.** The plugin injects DSH's `webServer` for its
  detail-page routes, so it does not load in a profile without one (for example
  the built-in `headless` profile).
- **No stored login.** The key comes from plugin config or `OPENCODE_API_KEY` on
  every request; there is no sign-in flow.

## License

[MIT](LICENSE). This is an independent extension. It is not affiliated with
OpenCode or DeepSeek.
