# Project Engineering Standards

These standards apply to `dsh-opencode-free`: a DSH plugin maintained by an individual and open to community contributions. They are project rules, not an ecosystem-wide DSH certification, and do not imply that the current implementation meets every requirement.

## Authority and Sources

- **MUST**: required. New changes must comply. Record existing deficiencies in the [gap ledger](standards-gap.md); existing behavior is not an automatic exemption.
- **SHOULD**: the default approach. Explain deviations and their verification in the change description.
- [AGENTS.md](../AGENTS.md) owns safe installation, update, and removal procedures. [CONTEXT.md](../CONTEXT.md) owns domain terminology. Consult the [ADRs](adr/) for architectural trade-offs; general style rules must not silently override accepted decisions.
- Verification methods below are acceptance requirements, not claims that automation already exists. See the gap ledger for deficiencies and verification limits.

Sources have distinct roles:

| Category | Source | Adoption and Limits |
| --- | --- | --- |
| Official requirements | Public interfaces and plugin protocols of the target DSH release | Prove compatibility with the corresponding packages and tests, not the latest branch. |
| Official engineering practices | [DSH AGENTS.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/AGENTS.md) | Reference ESM, type checking, effect management, and test evidence. Do not copy monorepo tooling or per-file 100% coverage requirements. |
| Community practices | [dsh-opencode-bridge contribution guide](https://github.com/XucroYuri/dsh-opencode-bridge/blob/main/CONTRIBUTING.md) and [security policy](https://github.com/XucroYuri/dsh-opencode-bridge/blob/main/SECURITY.md) | Reference focused changes, behavior tests, bilingual documentation, and secret protection. Do not copy its server architecture or credential-storage API. |
| Comparable design | [opencode2dsh](https://github.com/FishBottle7/opencode2dsh) | Compare native providers, streaming, and catalogue integration. README claims are neither test evidence nor obligations for this project. |
| Project decisions | Existing ADRs, installation guidance, and agreed maintenance policy | This project owns exact DSH compatibility, offline verification, conservative model verdicts, and minimal tooling. |

External links point to moving branches reviewed for this baseline, not frozen specifications aligned with the DSH release this plugin targets. Identify the source category when citing a rule. Recheck the target release when changing host compatibility. The [official contribution guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/CONTRIBUTING.md) also presents the official repository as inspiration rather than a mandatory community-plugin template.

## 1. Architecture and Plugin Lifecycle

| ID | Level | Requirement and Rationale | Verification |
| --- | --- | --- | --- |
| A1 | MUST | Use the target release's public plugin interfaces. Integrate models through the host adapter and leave tool execution to DSH, preserving host ownership of execution. | Adapter registration, tool-call, and streaming fixture tests; check target-package types. |
| A2 | MUST | Registrations, routes, polling, and global interception have explicit cleanup. Unloading or reloading must preserve wrappers installed later by other plugins. Prevent cross-plugin effects. | Test mounting, unloading, repeated cleanup, and wrapper installation order; check disposer ownership for each registration. |
| A3 | MUST | Rewrite HTTP identity only for Zen's exact origin and `/zen/v1` path or its descendants. Preserve original arguments for other requests to limit global interception. | Test other hosts, protocols, ports, similar path prefixes, and non-Zen requests. |
| A4 | MUST | Catalogue, model picker, and panel share visibility decisions. Keep user hiding, absence from Zen's list, and persisted `dead` verdicts semantically distinct. | Catalogue and visibility tests covering relisting, live toggle changes, and restarts. |
| A5 | SHOULD | Preserve the existing host, catalog, provider, and client responsibilities. Add abstractions, processes, or services only for current needs to limit maintenance. | Explain the concrete problem solved by each new module or dependency during review. |

## 2. TypeScript and Naming

| ID | Level | Requirement and Rationale | Verification |
| --- | --- | --- | --- |
| T1 | MUST | Keep host TypeScript strict. Follow the existing NodeNext compilation model for ESM and relative imports; official monorepo conventions must not produce unusable imports here. | Type checking, builds, and published-artifact import checks. |
| T2 | MUST | Validate external JSON, configuration, and caches before use. Type assertions do not replace runtime validation of untrusted inputs. | Tests for malformed data, missing fields, and corrupt caches. |
| T3 | SHOULD | Prefer explicit types and narrowing. Explain real interface limitations requiring `any` or double assertions. Use domain terminology and comment non-obvious constraints. | Review new assertions, names, and comments; do not require boilerplate comments on ordinary functions. |
| T4 | SHOULD | Preserve each file's existing style. Identify a confirmed deficiency before introducing formatters, linters, or client typing tools. Avoid repository-wide formatting changes. | Diff review; client JavaScript passes syntax and behavior checks at minimum. |

## 3. Compatibility and Dependencies

| ID | Level | Requirement and Rationale | Verification |
| --- | --- | --- | --- |
| C1 | MUST | Each release supports exactly one DSH version. Update package declarations, documentation, and tests together when compatibility changes. Do not claim untested versions. | Compare package metadata, installation guidance, and compatibility tests; record actual host verification separately. |
| C2 | MUST | Peers required at load time are not optional. Mark an integration optional only if the plugin works without it. Declarations must match loading behavior. | Compare top-level imports with peer metadata; verify missing-dependency behavior in isolation. |
| C3 | MUST | Keep the lockfile and package-manager version reproducible. Ignoring peer warnings is not a compatibility fix. | CI uses a frozen lockfile; inspect installation warnings. |
| C4 | SHOULD | Prefer existing tools and the standard library. New dependencies must reduce actual maintenance cost. Separate host upgrades from unrelated features. | Review purpose, alternatives, and added cost. |

## 4. Tests and CI

| ID | Level | Requirement and Rationale | Verification |
| --- | --- | --- | --- |
| Q1 | MUST | Default tests isolate networking, use a temporary DSH_HOME, and restore environment variables and global wrappers. They neither access user profiles nor consume anonymous quota. | Inspect fixtures and teardown; offline tests run without networking or keys. |
| Q2 | MUST | Add or update behavior tests for non-trivial behavior changes. Bug fixes include a reproducing case. | Map changes to tests; run affected cases first. |
| Q3 | MUST | Critical tests cover model visibility, dead verdicts only after all channels refuse, anonymous-tool rewriting and restoration, cache fallback, unloading, and UI states. Text-presence checks alone are insufficient. | Inspect success, refusal, and failure cases for each behavior; record missing cases in the gap ledger. |
| Q4 | MUST | CI checks types, offline tests, and package creation. Report type, fixture, artifact, actual-host, and live verification separately. | Check workflows and command results; explicitly identify checks not run. |
| Q5 | SHOULD | Do not set arbitrary coverage thresholds; add cases according to risk. Keep live checks separate from default CI and send real requests only with explicit authorization. | Review uncovered risks; record live-check scope and quota cost. |

## 5. Security and Logging

| ID | Level | Requirement and Rationale | Verification |
| --- | --- | --- | --- |
| S1 | MUST | Never put real API keys, Authorization values, or any fragments of either into logs, fixtures, or version control. Debug logs contain only allowlisted status and size fields. Truncation is not redaction. | Capture stderr using fake keys and upstream errors containing sensitive data; verify that no secret fragments appear. |
| S2 | MUST | Do not log conversations, tool inputs, or raw request bodies. Redact upstream errors before summarizing; error content is not inherently safe. | Verify logs with error fixtures containing conversation text and credentials. |
| S3 | MUST | Preserve key priority: config, environment variable, then anonymous public. Global wrappers must not downgrade existing keys. Never switch to paid models or persist login information automatically. | Test key priority and preservation of keyed requests. |
| S4 | MUST | Panel routes that mutate state or consume quota use appropriate HTTP methods and validate origin and local host. Credentials never appear in returned snapshots or caches. | Method, cross-origin, and DNS-rebinding fixtures; inspect persisted fields. |
| S5 | SHOULD | Report vulnerabilities through a confirmed private channel. Public issues contain only redacted diagnostics. Do not promise nonexistent contact channels or repair deadlines. | Confirm GitHub private reporting or a maintainer-designated channel before release; establish the channel first if unknown. |

## 6. UI and Error Handling

| ID | Level | Requirement and Rationale | Verification |
| --- | --- | --- | --- |
| U1 | MUST | Keep `ok`, `dead`, and `inconclusive` distinct. Gate refusals, exhausted quota, invalid keys, timeouts, and empty replies are not model-retirement evidence. Follow ADR-0002. | Simulate each error and check visibility, row badges, and counts. |
| U2 | MUST | Show actionable reasons and HTTP status. Timestamp retained round results and distinguish them from model capabilities and current status. Do not present old refusals as current conditions. | Panel rendering and round-persistence tests. |
| U3 | MUST | Product text uses the existing locale dictionaries. Maintain existing locales together for user-visible changes without adding a translation framework. | Dictionary-key parity and per-locale rendering tests. |
| U4 | SHOULD | Supplement status colors with text. Controls have recognizable names and support keyboard operation. Capability badges remain readable during probes. | Rendering and contrast tests, plus manual keyboard checks where needed. |

## 7. Documentation and Contributions

| ID | Level | Requirement and Rationale | Verification |
| --- | --- | --- | --- |
| D1 | MUST | Update both READMEs and relevant release notes when user behavior or installation steps change. Distinguish known facts, inferences, and unverified claims. | Compare affected sections, commands, and implementation; check local links. |
| D2 | MUST | Maintain these rules here; other entry points link to them. CONTEXT contains domain terminology only. ADRs record decisions that are costly to reverse, have real alternatives, and need lasting rationale. | Review duplicated rules and document responsibilities. |
| D3 | SHOULD | Keep each change focused on one purpose. Describe behavior, test results, limits, and gap IDs. Use the existing local issue workflow without mandating new templates, hooks, or review layers. | Change-description and diff review. |
| D4 | SHOULD | Write new standards documents in English and follow the existing English code-comment convention. Preserve existing localized documentation in its own language; do not translate unrelated documents merely for uniformity. | Documentation and comment review. |

## 8. Versioning and Releases

| ID | Level | Requirement and Rationale | Verification |
| --- | --- | --- | --- |
| R1 | MUST | Keep the released version, CHANGELOG, installation commands, and compatibility table consistent. Separate unreleased work from released versions. | Compatibility tests and pre-release document comparison. |
| R2 | MUST | Verify that the actual tarball's exports, types, client, and patch files are usable. Exclude credentials, caches, and private scratch files. A successful build does not prove installability. | Pack contents, isolated tarball-consumer imports, and installation checks; explicitly list checks not run. |
| R3 | MUST | Use patch releases for compatible fixes and minor releases for new features. Breaking changes increment minor in 0.x and major from 1.x onward; document impact and upgrade steps. Publishing requires separate authorization. | Review version differences and upgrade guidance; explicitly identify supported-host changes. |
| R4 | SHOULD | Claim platform support according to evidence. Linux fixtures do not prove actual Windows, macOS, Desktop, or Web operation. | Record OS, Node, DSH, profile, and verification level; qualify claims where evidence is missing. |

## Applying the Standards

1. Identify applicable rule IDs and consult related ADRs and gaps.
2. Check implementation against required rules. Run focused tests first and broaden checks when risk warrants it.
3. Update affected documentation. Record existing deficiencies with evidence, impact, and acceptance criteria rather than expanding into unrelated refactoring.
4. Report checks actually run and their limits. Close a gap only when evidence satisfies its acceptance criteria.

These standards and the gap ledger define rules and record gaps. They add no tools, CI jobs, credential migrations, or implementation fixes.
