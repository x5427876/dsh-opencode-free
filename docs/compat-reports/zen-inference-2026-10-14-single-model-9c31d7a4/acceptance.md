# Single-model acceptance: incomplete (L0 probe HTTP 429)

This is one authorized compat round, not a compaction test or a release.

- Started: 2026-10-14T23:58:52.444Z.
- Environment: Windows 10.0.26200 x64, Node v24.13.0, DSH 0.2.1-alpha.3.
- Plugin: local working-tree 0.3.4, packed and installed by the existing compat driver; not the registry's published 0.3.4.
- Model: `muse-spark-1.3-contributor-free`; anonymous `public` only; effort `minimal` for L1/L2.
- Path: isolated DSH_HOME, built-in headless profile and overlay, real PiAiAdapter → plugin → Node transport. The warmup reported asking exactly one model. Other visible catalogue IDs are listing metadata, not extra inference subjects.

| Required evidence | Result |
| --- | --- |
| Public Zen/models.dev free intersection | Present |
| L0 picker membership | Present |
| L0 probe actually answered | **Not passed: quota-exhausted, HTTP 429** |
| L1 nonempty DSH reply | Passed after existing bounded backoff |
| L2 read, nonce absent from prompt | Passed |
| L2 Windows `pwsh`, separate random file hash | Passed |
| Existing compat exit code | 0 |
| Strict acceptance requiring all rows | **Incomplete; not a full pass** |

The raw compat row says `ok` / `L2`: that runner's verdict covers the successful L1/L2 operations but does not require an `ok` warmup probe. The stricter requirement in ticket 04 does. Warmup `ok: true` means setup/routes completed, not that its inference probe answered. Exit code 0 therefore does not override the HTTP 429.

No second live round was run. Ticket 04 remains open for separately authorized L0 re-verification; a new round may also encounter quota limits. This result proves this model's observed text/read/pwsh path only, not all models, a user web profile, Web UI, Desktop, another platform, or dedicated compaction behavior. The minimum upstream description/schema admission rules remain unknown.

## Offline and artifact evidence

- `pnpm run check`: strict typecheck, build, **248 offline tests passed**, package creation.
- Tarball allowlist: 14 entries, no credentials, caches, scratch, reports, or diagnostic artifacts.
- Extracted tarball consumer: runtime package export import, TypeScript declaration consumer, client syntax, and patch/export paths passed. The lightweight consumer used the repository's installed peer dependencies; the live compat driver separately installed the tarball into its real isolated DSH.
- Standards/Spec review found a later `toolsRemoved` delta could discard early admission declarations. A red → green fixture reproduced and fixed it by adding missing declarations at the last system delta. Coverage includes both APIs, legacy/normalized Contexts, main/compat, stream/streamSimple, argument history/SSE/results, keyed nonregression, and emitted Responses cache/session affinity.
- Model failure reports now retain only allowlisted codes/status/markers rather than raw error lines. Existing unrelated gap-ledger items are not claimed resolved.

## Isolation and cleanup

The launcher removed OPENCODE_API_KEY and debug logging only from its child environment. No keyed comparison ran. Existing DSH processes, profiles, credentials and unrelated plugins were not changed. The driver's own temporary environment was removed; its absence was checked after completion. Pre-existing uncommitted reports and `.env.local` were preserved and are excluded from the implementation commit.

Machine-readable strict outcome: [acceptance.json](acceptance.json). Original runner evidence: [JSON](compat-0.2.1-alpha.3-2026-10-14.json) and [matrix](compat-0.2.1-alpha.3-2026-10-14.md).
