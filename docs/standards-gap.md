# Engineering Standards Gap Baseline

Compare against the [engineering standards](standards.md). Reviewed baseline: commit `013c2deb3ec3ddf03408ebd698e4b562c3011130`. This document records static inspection evidence, not a comprehensive audit, repair history, or proof that tests pass. Recheck changes after the baseline.

## Classification and Handling

- **P1**: security, isolation, or lifecycle risks to address first.
- **P2**: package declarations, verification completeness, or maintainability gaps.
- **P3**: recommendations to improve alongside related changes.
- **Confirmed gap**: code or configuration directly demonstrates a rule violation.
- **Unverified**: available evidence is insufficient; this neither proves broken behavior nor establishes compliance.

All items below remain open. This baseline does not change implementation, CI, dependency declarations, or user DSH settings, and does not include live checks.

## G1: Debug Logs Include Authorization Fragments

- **P1 / Confirmed gap / S1, S2**.
- Evidence: [identitySummary](../src/zen-provider.ts) reads `authorization` and includes `auth.slice(0, 14)` in its message; fetch and compat paths call it. The Debug logs section of the [README](../README.md) discloses this behavior. Probe refusals also log upstream errors using `body.slice(0, 300)` without redaction at that location.
- Impact: enabling debug with a configured key exposes part of the credential. Error truncation cannot guarantee removal of sensitive upstream content. Historical logs have not been checked for real keys.
- Acceptance: replace credential content with allowlisted fields. Capture each logging path using fake keys and error fixtures containing sensitive strings; verify that neither credential fragments nor conversation text appear. Update both language versions of the documentation.

## G2: Fetch Interception Matches Zen Paths by String Prefix

- **P1 / Confirmed gap / A3**.
- Evidence: [isZenRequest](../src/zen-provider.ts) uses `startsWith(BASE_URL)` for strings, URLs, and Request URLs. `BASE_URL` is `https://opencode.ai/zen/v1`.
- Impact: `https://opencode.ai/zen/v10/models` and `/zen/v1-other` also match the prefix, exceeding the required path scope. This is not evidence of credential leakage to an external host; no requests were sent for this inspection.
- Acceptance: parse URLs and check the exact origin and path separators. Test valid descendant paths, similar paths, other hosts, ports, protocols, and Request inputs; verify that non-target requests are not rewritten.

## G3: Global Compat Provider Registration Has No Cleanup Entry Point

- **P1 / Confirmed gap / A2**.
- Evidence: [patchCompatDirectTransport](../src/zen-provider.ts) returns `void` and calls `registerApiProvider`. [apply](../src/index.ts) calls it, but `restoreTransport` collects restore functions only for fetch and Node HTTP.
- Impact: the current code provides no unload restoration path for this global registration. Whether the actual host supplies another cleanup mechanism is unverified. Existing Node HTTP wrapper cleanup tests do not establish compat-provider cleanup.
- Acceptance: confirm the target pi-ai/DSH registration cleanup API and ownership, then integrate with plugin unloading. Test reloads, repeated unloading, and later registrations by another plugin without removing its provider.

## G4: Required Peers Are Declared Optional

- **P2 / Confirmed gap / C2**.
- Evidence: [package.json](../package.json) marks all four peers `optional: true`. [src/index.ts](../src/index.ts) imports runtime symbols from all four packages at the top level. The [README](../README.md) states that all four peers are required.
- Impact: package metadata contradicts loading behavior and documentation, potentially understating missing-dependency risk for consumers.
- Acceptance: align required-peer metadata with documentation. In isolation, verify loading with complete dependencies and do not claim normal operation when required peers are missing. Preserve the exact DSH pin; do not upgrade the host as part of this fix.

## G5: Client JavaScript Is Outside TypeScript Checks

- **P3 / Verification gap for a recommendation / T4**.
- Evidence: [tsconfig.json](../tsconfig.json) includes only `src/**/*.ts`, without `allowJs` or `checkJs`. [src/client.js](../src/client.js) is published directly as JavaScript. [CI](../.github/workflows/ci.yml) has no separate client syntax-check command, although [panel rendering tests](../tests/client-render.test.mjs) already exist.
- Impact: strict host checks do not establish client type safety. This does not require rewriting JavaScript as TypeScript or discount the rendering tests.
- Acceptance: first record `node --check src/client.js` and rendering-test results. Evaluate minimal JSDoc/checkJs support only when actual typing defects justify it. A one-time successful command does not establish CI coverage.

## G6: Tarball Consumer Loading Lacks Automated Evidence

- **P2 / Unverified / R2, Q4**.
- Evidence: the [check script](../package.json) runs type checks, tests, and pack; [CI](../.github/workflows/ci.yml) also runs pack dry-run. [Compatibility tests](../tests/compatibility.test.mjs) inspect built files and export declarations, but this inspection found no step that installs the tarball into an isolated consumer and tests export loading.
- Impact: builds and package creation alone do not establish consumer importability. No publication defect has been confirmed.
- Acceptance: test runtime, types, client, and patch files from the tarball rather than source. Check that contents exclude private data. Follow AGENTS.md separately for actual DSH installation without replacing user profiles.

## G7: Current CI Does Not Establish Platform or Actual-Host Verification

- **P2 / Unverified / C1, R4**.
- Evidence: [CI](../.github/workflows/ci.yml) uses `ubuntu-latest` and Node `22.19.0`, without a platform matrix or actual DSH profile launch. [Compatibility tests](../tests/compatibility.test.mjs) and [model visibility tests](../tests/model-visibility.test.mjs) use host fixtures.
- Impact: this evidence does not verify actual installation and unloading on macOS, Windows, Node 24+, Web, or Desktop. Existing manual records have not been consolidated; this does not imply those environments cannot work.
- Acceptance: document environments and verification appropriate to support claims. Distinguish fixture, tarball, host, and live results; avoid claims without evidence. Decide separately whether to expand the CI matrix.

## Located Test Evidence and Limits

- Catalogue and visibility: [catalog.test.mjs](../tests/catalog.test.mjs) covers failures preserving visibility, all-gated rounds producing no dead verdicts, relisting, concurrent refreshes, and persistence.
- Provider: [compatibility.test.mjs](../tests/compatibility.test.mjs) covers anonymous tools, pwsh restoration, channel sweeps, and Node HTTP wrapper cleanup ownership.
- Panel: [client-render.test.mjs](../tests/client-render.test.mjs) covers round states, locale keys, contrast, and stopping polling on unmount.
- Routes: [model-visibility.test.mjs](../tests/model-visibility.test.mjs) covers methods, cleanup, and DNS rebinding.

These are inspected cases, not a claim that the entire test suite was run for this baseline. Rules without listed gaps are not automatically compliant. Use each gap's acceptance criteria and actual command results when verifying repairs.
