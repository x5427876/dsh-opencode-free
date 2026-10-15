# Compat run: DSH 0.2.1-alpha.3 + dsh-opencode-free 0.3.4

- Date: 2026-10-15T00:12:10.580Z
- OS: win32 10.0.26200 x64, Node v24.13.0
- Key: no (anonymous only)
- Tools (L2): on
- Model: muse-spark-1.3-contributor-free (single-model run: the other free models were not asked)
- Path: Isolated DSH_HOME, built-in headless profile plus a --patch overlay (webServer on 127.0.0.1, default model). Same PiAiAdapter -> plugin path as the web profile, but not the profile users run: this is not a web UI verification.
- Result: exit code 0 — the selected model verified, no plugin-fault

- Live only (not in the builtin list): cat-jam-free, muse-spark-1.2-contributor-free, step-5-preview-free
- Builtin only (not in the live list): exo-free, fledge-alpha-free, ling-3.0-flash-fin-free, ling-3.1-flash-free, nemotron-3-ultra-free
- Warmup: ok

| model | verdict | layer | effort | L0 probe | L2 tools | with key | reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| muse-spark-1.3-contributor-free | ok | L2 | minimal | failed: unknown (HTTP 400) | read pass, pwsh pass | - | - |

Unverified: (none)
