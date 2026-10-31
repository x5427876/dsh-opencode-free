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
| Evaluate a new DSH release | [Upgrade evaluation](upgrade-evaluation.md) |
| Upgrade DSH or release | [Release checklist](release.md) |
| Work on an issue | [GitHub workflow](agents/issue-tracker.md) |

## Decisions

- [0001: Session identity](adr/0001-hashed-session-ids.md)
- [0002: Runtime catalogue and visibility](adr/0002-catalogue-source-of-truth.md)
- [0003: Live compatibility stays outside CI](adr/0003-compat-run-not-in-ci.md)
- [0004: Official dynamic acceptance targets](adr/0004-official-dynamic-compat-targets.md)
- [0005: Official model list as the free-model source](adr/0005-official-model-list-as-free-model-source.md)
- [0006: OpenCode CLI v1 as the payload reference](adr/0006-opencode-v1-as-payload-reference.md)

## Scope

The docs describe the current release only. Compat run output is not kept in the
repository: it varies with environment, version and time.

Issues and specs are maintained in [GitHub Issues](https://github.com/x5427876/dsh-opencode-free/issues),
not local ticket files. Agent installation safety remains in [AGENTS.md](../AGENTS.md),
and domain terms in [CONTEXT.md](../CONTEXT.md).
