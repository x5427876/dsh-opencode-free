# dsh-opencode-free

English | [中文](README.md)

Use OpenCode Zen free models from DeepSeek Harness without installing OpenCode. The plugin uses anonymous free quota by default and can read a Zen API key from `OPENCODE_API_KEY`.

[npm package](https://www.npmjs.com/package/dsh-opencode-free) | [GitHub source](https://github.com/x5427876/dsh-opencode-free) | [Issue tracker](https://github.com/x5427876/dsh-opencode-free/issues)

> OpenCode Zen free models may have usage limits, limited availability, or data-use terms. Do not send confidential data before reviewing the [OpenCode Zen privacy notes](https://opencode.ai/docs/zen#privacy).

## Compatibility

The first release supports DeepSeek Harness `0.1.7-alpha.1`.

## Install

After the package is published, add it to a profile:

```sh
dsh plugin --profile web add dsh-opencode-free@0.1.1
```

The plugin adds the `opencode-zen-free` provider. Its default model list contains only zero-cost OpenCode catalog entries.

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
