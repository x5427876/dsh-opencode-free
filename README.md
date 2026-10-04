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
  switched on at the top. Each has a switch that hides it from the picker, and
  badges for vision (the model declares image input) and thinking (its strongest
  published reasoning level; none when it publishes no levels).

### Reasoning and capabilities

All models support reasoning and tool calls. DSH passes your reasoning level
through, and the levels offered come from models.dev per model (Muse Spark gets
`minimal`…`xhigh`, Space Bunny gets `low`…`max`). A level a model does not
publish is never offered. `off` stays offered and sends no reasoning parameter,
like OpenCode's "Default". If you choose nothing, Muse Spark uses `xhigh`.

A screenshot is attached only to a model that declares image input. The context
size and maximum output shown in the picker are that model's own.

### Availability check

The detail page runs a check on the models you have switched on, and shows its
progress as it goes: a counter, a latency for each model that answered, and a
spinner on the one being asked. The result stays on screen across a DSH restart
until the next round replaces it.

- **When.** Once per local day, started when the model list is read, plus the
  **Probe now** button at any time. If you never open the model list, you never
  pay.
- **How.** The round first reads Zen's catalogue (one `GET`, no inference
  quota); a model Zen no longer lists is dropped without a completion being
  sent. Each remaining model then gets one short request, one at a time,
  because anonymous callers share one quota bucket. Models that answered are
  asked again next round, so their latency stays current. Models you switched
  off are not asked.
- **What removes a model.** Only a positive answer: Zen stops listing it, or the
  route says it will not serve it (`Model is unavailable.`,
  `Model <id> is not supported`, `404`, `410`). Zen does not publish which
  endpoint serves which model, so a model is asked on both endpoints this
  provider implements before it counts as gone. models.dev's `deprecated` flag
  never decides this: on this provider it can mean the free tier ended or only
  that the record is stale.
- **What does not.** A gate refusal, exhausted quota, rejected key, dropped
  network, or a whole endpoint being down. Those rounds learned nothing about
  any model, so the rows turn grey "not measured" instead of red, and a banner
  names which condition answered. A red row names its reason, with the HTTP
  status and what to do in its tooltip.
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
