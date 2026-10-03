# Compat run: DSH 0.2.1-alpha.1 + dsh-opencode-free 0.3.1

- Date: 2026-10-03T13:44:12.440Z
- OS: win32 10.0.26200 x64, Node v24.13.0
- Key: no (anonymous only)
- Tools (L2): on
- Path: Isolated DSH_HOME, built-in headless profile plus a --patch overlay (webServer on 127.0.0.1, default model). Same PiAiAdapter -> plugin path as the web profile, but not the profile users run: this is not a web UI verification.
- Result: exit code 0 — every model verified, no plugin-fault

- Live only (not in the builtin list): deepseek-v4-flash-free, space-bunny-free, longcat-2.5-preview-free, mimo-v2.5-free, fledge-alpha-free, ling-3.1-flash-free
- Builtin only (not in the live list): (none)
- Warmup: ok

| model | verdict | layer | effort | L0 probe | L2 tools | with key | reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| big-pickle | ok | L2 | no published levels (無等級可選) | ok | read pass, pwsh pass | - | - |
| muse-spark-1.3-contributor-free | ok | L2 | minimal | ok | read pass, pwsh pass | - | - |
| muse-spark-1.2-contributor-free | ok | L2 | minimal | ok | read pass, pwsh pass | - | - |
| mimo-v2.6-flash-free | ok | L2 | no published levels (無等級可選) | ok | read pass, pwsh pass | - | - |
| space-bunny-free | ok | L2 | low | ok | read pass, pwsh pass | - | - |
| longcat-2.5-preview-free | ok | L2 | no published levels (無等級可選) | ok | read pass, pwsh pass | - | - |
| mimo-v2.5-free | ok | L2 | no published levels (無等級可選) | ok | read pass, pwsh pass | - | - |
| nemotron-3-ultra-free | ok | L2 | no published levels (無等級可選) | ok | read pass, pwsh pass | - | - |
| fledge-alpha-free | ok | L2 | low | ok | read pass, pwsh pass | - | - |
| ling-3.1-flash-free | ok | L2 | no published levels (無等級可選) | ok | read pass, pwsh pass | - | - |
| deepseek-v4-flash-free | upstream-down | L0 | low | failed: unknown (HTTP 500) | - | - | dsh: INVALID_REQUEST: 400: {"type":"server_error","message":"Error from provider (Console): Upstream request failed: Model is unavailable."} |
| ling-3.0-flash-fin-free | upstream-down | L0 | no published levels (無等級可選) | failed: unknown (HTTP 400) | - | - | dsh: INVALID_REQUEST: 400: {"type":"server_error","message":"Error from provider (Console): Upstream request failed: Endpoint is unavailable."} |
| nemotron-3.5-lightning-free | ok | L2 | no published levels (無等級可選) | failed: timeout (HTTP 200) | read pass, pwsh pass | - | - |

Unverified: (none)
