# Single-model retry acceptance: incomplete (L0 probe HTTP 400)

This is one separately authorized retry round. No production code changed.

- Started: 2026-10-15 08:12:10 Asia/Taipei (2026-10-15T00:12:10.580Z).
- Source: commit `8fa8fe9`, current working-tree plugin 0.3.4, packed by the existing compat driver. This is not the registry's published 0.3.4.
- Environment: Windows 10.0.26200 x64, Node v24.13.0, pnpm 11.19.0, isolated DSH 0.2.1-alpha.3. The driver checked the installed DSH version before loading the plugin. A global `dsh` command was not available.
- Model: `muse-spark-1.3-contributor-free`; anonymous public only; minimal effort for L1/L2. Warmup asked exactly one model.
- Command: `pnpm compat --dsh 0.2.1-alpha.3 --model muse-spark-1.3-contributor-free --tools --out docs/compat-reports/zen-inference-2026-10-15-retry-081206`.

| Required evidence | Result |
| --- | --- |
| Public Zen/models.dev free intersection | Present |
| L0 picker membership | Present |
| L0 probe actually answered | **Not passed: unknown, HTTP 400** |
| L1 nonempty DSH reply | Passed |
| L2 read, nonce absent from prompt | Passed |
| L2 Windows pwsh, separate random file hash | Passed |
| Existing compat exit code | 0 |
| Strict acceptance requiring all rows | **Incomplete; not a full pass** |

The previous round reported L0 HTTP 429. This retry reported HTTP 400 instead. The allowlisted report does not establish the cause of HTTP 400. It does not prove quota exhaustion, admission refusal, or a plugin fault. No extra live round or diagnosis requests were sent. Warmup setup success and the runner's ok/L2 verdict do not override the failed L0 requirement. Ticket 04 remains open.

## Verification and isolation

The compat command built the plugin, packed it, and installed the tarball into a temporary DSH_HOME with the built-in headless profile and overlay. L1/L2 used the real PiAiAdapter → plugin → Node transport. The launcher removed OPENCODE_API_KEY and debug logging from its command environment; the parent application environment was unchanged. No keyed comparison ran.

The driver removed its temporary environment `C:/Users/Gavin/AppData/Local/Temp/dsh-compat-4xehbw`; a subsequent Test-Path returned false. No existing DSH process was started, stopped, or restarted. No user profile, credentials, or unrelated plugin changed. Pre-existing working-tree changes were preserved. No version change, tag, or publication occurred.

Typecheck, the full offline suite, and the extracted tarball consumer checks were not rerun for this test-only request. Their previous results remain historical evidence in the [previous acceptance report](../zen-inference-2026-10-14-single-model-9c31d7a4/acceptance.md). This round does not verify other models, Web UI, Desktop, a user profile, another platform, or dedicated compaction behavior.

Evidence: [runner matrix](compat-0.2.1-alpha.3-2026-10-15.md), [runner JSON](compat-0.2.1-alpha.3-2026-10-15.json), [strict JSON](acceptance.json), and [sanitized progress log](run.log).
