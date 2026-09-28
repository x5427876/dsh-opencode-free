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

## Features

- Seven free Zen models in the DSH model picker, under the `opencode-zen-free` provider.
- Anonymous by default. A Zen API key is optional.
- Native streaming through pi-ai: text, reasoning, tool calls, usage, and abort.
- Tools run inside DSH. The Windows `pwsh` shell works too.
- Clear error messages when the upstream rejects a request.

## Requirements

| Requirement | Version |
|---|---|
| DeepSeek Harness | `0.2.0-rc.1` (exact) |
| Node.js | `^22.19.0` or `>=24.0.0` |

Each plugin release pins one exact DSH version. Check yours first:

```sh
dsh --version
```

| Plugin | DSH |
|---|---|
| `0.2.x` | `0.2.0-rc.1` |
| `0.1.3` – `0.1.4` | `0.1.7-rc.2` |

Do not ignore peer dependency warnings.

## Install

The examples use the `web` profile. Replace it with your target profile.

```sh
dsh plugin --profile web add dsh-opencode-free@0.2.0
```

Check the install:

```sh
dsh plugin --profile web list dsh-opencode-free --depth 0
dsh --profile web --dump-config
```

The install is correct when the package appears once and `opencode-free`
appears in the composed config. Other profiles and plugins do not change.

Update or remove:

```sh
dsh plugin --profile web update dsh-opencode-free
dsh plugin --profile web remove dsh-opencode-free
```

## Usage

Restart DSH (or let HMR reload it). Open the model picker and select a model
under **OpenCode Zen Free**.

| Model | ID | Input | Context |
|---|---|---|---|
| Muse Spark 1.3 Free | `muse-spark-1.3-contributor-free` | text, image | 1M |
| Muse Spark 1.2 Free | `muse-spark-1.2-contributor-free` | text, image | 1M |
| MiMo V2.5 Free | `mimo-v2.5-free` | text, image | 200K |
| Nemotron 3 Ultra Free | `nemotron-3-ultra-free` | text | 1M |
| Nemotron 3.5 Lightning Free | `nemotron-3.5-lightning-free` | text | 262K |
| Ling 3.0 Flash Fin Free | `ling-3.0-flash-fin-free` | text | 262K |
| Big Pickle | `big-pickle` | text | 200K |

All models support reasoning and tool calls. DSH passes your reasoning level
through. If you do not choose one, Muse Spark uses `xhigh`.

The list is a baseline that ships with the package. The plugin does not
refresh it in the background. When the upstream removes a model, you get a
"model unavailable" error.

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
OPENCODE_API_KEY=<your Zen key> ./scripts/reverify.sh
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

The full investigation, with replay results and pitfalls, is in
[`docs/reverse-engineering.md`](docs/reverse-engineering.md).

## Troubleshooting

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
outbound identity and request shape to stderr. It never logs content or keys.

## Development

Edit `src/*.ts`. Do not edit `lib/`: `tsc` generates it.

```sh
pnpm install
pnpm run typecheck  # strict type check
pnpm run build      # emit lib/
pnpm run test       # build, then run offline tests
pnpm run check      # typecheck, test, and pack
```

The unit tests use in-memory fixtures. They do not use the network or free
quota. These scripts send real requests:

| Script | What it checks |
|---|---|
| `scripts/reverify.sh` | ① catalogue reachable, ② anonymous gate, ③ API key (only when `OPENCODE_API_KEY` is set) |
| `node scripts/test-live.mjs [model-id ...]` | Every free model (or the ones you list) replies anonymously. Run `pnpm run build` first. |

For Agents that install or verify this plugin, see [`AGENTS.md`](AGENTS.md).

## License

[MIT](LICENSE). This is an independent extension. It is not affiliated with
OpenCode or DeepSeek.
