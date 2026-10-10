# Compat run: DSH 0.2.1-alpha.2 + dsh-opencode-free 0.3.2

- Date: 2026-10-10T02:58:46.193Z
- OS: darwin 25.6.0 arm64, Node v26.9.0
- Key: no (anonymous only)
- Tools (L2): on
- Path: Isolated DSH_HOME, built-in headless profile plus a --patch overlay (webServer on 127.0.0.1, default model). Same PiAiAdapter -> plugin path as the web profile, but not the profile users run: this is not a web UI verification.
- Result: exit code 0 — every model verified, no plugin-fault

- Live only (not in the builtin list): muse-spark-1.2-contributor-free, step-5-preview-free
- Builtin only (not in the live list): fledge-alpha-free
- Warmup: ok

| model | verdict | layer | effort | L0 probe | L2 tools | with key | reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| big-pickle | ok | L2 | no published levels (無等級可選) | ok | read pass, bash pass | - | - |
| muse-spark-1.3-contributor-free | ok | L2 | minimal | ok | read pass, bash pass | - | - |
| muse-spark-1.2-contributor-free | ok | L2 | minimal | ok | read pass, bash pass | - | - |
| space-bunny-free | ok | L2 | low | ok | read pass, bash pass | - | - |
| longcat-2.5-preview-free | ok | L2 | no published levels (無等級可選) | ok | read pass, bash pass | - | - |
| step-5-preview-free | ok | L2 | low | ok | read pass, bash pass | - | - |
| nemotron-3-ultra-free | ok | L2 | no published levels (無等級可選) | ok | read pass, bash pass | - | - |
| nemotron-3.5-lightning-free | ok | L2 | no published levels (無等級可選) | ok | read pass, bash pass | - | - |
| ling-3.1-flash-free | ok | L2 | no published levels (無等級可選) | ok | read pass, bash pass | - | - |
| exo-free | upstream-down | - | high | failed: dead (HTTP 410) | - | - | warmup probe judged it dead: failed: dead (HTTP 410) |
| mimo-v2.6-flash-free | ok | L2 | no published levels (無等級可選) | failed: timeout (HTTP 200) | read pass, bash pass | - | - |
| ling-3.0-flash-fin-free | upstream-down | - | no published levels (無等級可選) | failed: dead (HTTP 400) | - | - | warmup probe judged it dead: failed: dead (HTTP 400) |

Unverified: (none)
