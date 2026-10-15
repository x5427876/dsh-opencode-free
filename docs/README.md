# Documentation

**English** | [繁體中文](README.zh-TW.md)

Choose the document for your task; reading the whole directory is not required.
Installation and quick start live in the [project README](../README.md).

## Users

| Task | Read |
|---|---|
| Model list, probes, cache recovery, API key | [Usage guide](usage.md) |
| Report a problem | [Troubleshooting](../README.md#troubleshooting) |

## Contributors and maintainers

| Task | Read |
|---|---|
| Change or review code | [Engineering standards](standards.md), relevant [known gaps](standards-gap.md) |
| Understand request adaptation | [Protocol notes](protocol-notes.md) |
| Change catalogue, identity, or acceptance policy | The relevant [ADR](#decisions) |
| Verify real DSH compatibility | [Compat run](compat-run.md); live requests require authorization |
| Upgrade DSH or release | [Release checklist](release.md) |
| Work on an issue | [GitHub workflow](agents/issue-tracker.md) |

## Decisions

- [0001: Session identity](adr/0001-hashed-session-ids.md)
- [0002: Runtime catalogue and visibility](adr/0002-catalogue-source-of-truth.md)
- [0003: Live compatibility stays outside CI](adr/0003-compat-run-not-in-ci.md)
- [0004: Official dynamic acceptance targets](adr/0004-official-dynamic-compat-targets.md)

## Evidence and history

[Compatibility reports](compat-reports/) record dated results, not current
availability guarantees. [Archived material](archive/README.md) contains old
designs, investigations, and migration records. Read either only to investigate
a specific result or decision; archived instructions do not override current guides.

Issues and specs are maintained in [GitHub Issues](https://github.com/x5427876/dsh-opencode-free/issues),
not local ticket files. Agent installation safety remains in [AGENTS.md](../AGENTS.md),
and domain terms in [CONTEXT.md](../CONTEXT.md).
