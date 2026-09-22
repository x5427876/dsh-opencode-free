# dsh-opencode-free

[![npm version](https://img.shields.io/npm/v/dsh-opencode-free.svg)](https://www.npmjs.com/package/dsh-opencode-free)
[![npm downloads](https://img.shields.io/npm/dw/dsh-opencode-free.svg)](https://www.npmjs.com/package/dsh-opencode-free)
[![CI](https://github.com/x5427876/dsh-opencode-free/actions/workflows/ci.yml/badge.svg)](https://github.com/x5427876/dsh-opencode-free/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dsh-opencode-free.svg)](LICENSE)

English | [中文](README.md)

Use OpenCode Zen free models from DeepSeek Harness without installing OpenCode. The plugin uses anonymous free quota by default and can read a Zen API key from `OPENCODE_API_KEY`.

[npm package](https://www.npmjs.com/package/dsh-opencode-free) | [GitHub source](https://github.com/x5427876/dsh-opencode-free) | [Issue tracker](https://github.com/x5427876/dsh-opencode-free/issues)

> OpenCode Zen free models may have usage limits, limited availability, or data-use terms. Do not send confidential data before reviewing the [OpenCode Zen privacy notes](https://opencode.ai/docs/zen#privacy).

## Quick start

No API key is required. Add the plugin to a profile:

```sh
dsh plugin --profile web add dsh-opencode-free@0.1.2
```

The plugin adds the `opencode-zen-free` provider. Select any free model from the model picker to start using it.

## Free models

The current catalog includes:

| Model | Model ID | Input |
|---|---|---|
| Big Pickle | `big-pickle` | Text |
| Ling 3.0 Flash Fin Free | `ling-3.0-flash-fin-free` | Text |
| MiMo V2.5 Free | `mimo-v2.5-free` | Text, image |
| Nemotron 3 Ultra Free | `nemotron-3-ultra-free` | Text |
| Nemotron 3.5 Lightning Free | `nemotron-3.5-lightning-free` | Text |
| Muse Spark 1.2 Free | `muse-spark-1.2-contributor-free` | Text, image |
| Muse Spark 1.3 Free | `muse-spark-1.3-contributor-free` | Text, image |

The default list comes from the installed `pi-ai` catalog and includes only zero-cost models. OpenCode may change availability at any time.

## Compatibility

Supports DeepSeek Harness `0.1.7-alpha.1`.

## Configuration

To use your own Zen API key:

```sh
export OPENCODE_API_KEY='your-key'
```

You can also mount the plugin directly and override its settings:

```yaml
- id: opencode-free
  name: dsh-opencode-free
  config:
    apiKeyEnv: OPENCODE_API_KEY
    baseURL: https://opencode.ai/zen/v1
    retryPolicy:
      mode: normal
      maxRetries: 2
```

Supported settings:

| Field | Default | Purpose |
|---|---|---|
| `apiKeyEnv` | `OPENCODE_API_KEY` | Credential reference for the Zen API key |
| `baseURL` | `https://opencode.ai/zen/v1` | Zen API endpoint |
| `reasoning` | `xhigh` for Muse Spark | Default reasoning level |
| `maxTokens` | unset | Per-request output limit |
| `timeoutMs` | `180000` | Request timeout |
| `streamIdleTimeoutMs` | `300000` | Stream idle timeout |
| `models` | free catalog | Explicit model IDs |

## Development

```sh
pnpm install
pnpm run check
pnpm pack --dry-run
```

## License

[MIT](LICENSE)
