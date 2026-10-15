# L0 HTTP 400 diagnosis — 2026-10-15

## Finding

The observed L0 HTTP 400 is caused by the emitted `tool_choice: "none"` on the selected model's Responses endpoint. The upstream identifies the rejected parameter as `tool_choice` with type `invalid_request_error`. Removing that field at the diagnostic fetch boundary produces HTTP 200 and an `ok` probe. Restoring the original request policy reproduces HTTP 400.

This finding applies to `muse-spark-1.3-contributor-free` on the anonymous public path observed today. It does not explain the earlier HTTP 429 or establish a rule for every model.

## Reproduction and differential evidence

The user requested continued diagnosis after the authorized compat retry. The diagnostic uses the current built plugin's real `probeModel` and `zenProvider`, and derives the model from the live Zen/models.dev free intersection. It does not use a user DSH profile or read credentials.

Three sequential diagnostic invocations made five inference requests in total, all for the same selected model. No SDK retries or keyed comparisons ran. The normal probe sweeps to Completions after the Responses rejection; that unsupported alternate channel accounts for two of the five requests.

| Invocation | Responses tool_choice | Responses outcome | Alternate channel | Final probe outcome |
| --- | --- | --- | --- | --- |
| Baseline | none | HTTP 400, invalid_request_error, parameter tool_choice | HTTP 400, ModelProtocolUnsupported | inconclusive / unknown / HTTP 400 |
| Differential | omitted at fetch boundary | HTTP 200 | Not asked | ok / openai-responses |
| Restored baseline | none | HTTP 400, invalid_request_error, parameter tool_choice | HTTP 400, ModelProtocolUnsupported | inconclusive / unknown / HTTP 400 |

All three invocations retain the same model derivation, two admission declarations, 1024 output-token ceiling, low reasoning effort, plugin serializers, and response parser. Each invocation creates fresh request/session identity normally; the differential changes only the serialized tool_choice field at the fetch boundary. The repeated baseline and the upstream parameter-specific error support the causal finding. This is not an exhaustive upstream protocol specification.

Local diagnostic commands (quota-consuming; only run with authorization):

```powershell
node .artifacts/l0-400-2026-10-15/repro.mjs --live
node .artifacts/l0-400-2026-10-15/repro.mjs --live --omit-tool-choice
node .artifacts/l0-400-2026-10-15/repro.mjs --live
```

Exit codes: 1, 0, 1. The local script stays under ignored `.artifacts/` as an explicitly marked diagnostic, not a published tool. Its output contains only allowlisted status, option, and error-marker fields. It never prints request bodies, replies, raw errors, or credential values.

## Code path

1. `probeOnce` constructs a user-only context and calls `streamSimple` with the probe's output ceiling and low reasoning effort: [source](../../../src/zen-provider.ts).
2. `applyAnonymousToolGate` observes zero host tools, inserts substantive admission-only read/bash declarations, and returns `disableTools: true`.
3. `gateOptions` unconditionally writes `tool_choice: "none"` for that state. `enforceAnonymousTools` also writes the same value if it has to reconstruct an entirely missing tool list.
4. The Responses endpoint rejects that value. The alternate Completions endpoint reports `ModelProtocolUnsupported`. The probe keeps the first inconclusive result, producing the reported `unknown (HTTP 400)`.
5. The compat L1/L2 runs carry actual DSH tools. They do not trigger the zero-host-tools branch, which explains why they can succeed while L0 fails.

The current fixture `tool-less anonymous requests declare substantive tools but disable execution` in [inference-admission.test.mjs](../../../tests/inference-admission.test.mjs) explicitly expects tool_choice none and uses a generic refusal fixture. It checks the intended local policy, but does not check this upstream constraint.

## Fix boundary and remaining verification

No production code or tests changed during this diagnosis. The fetch-boundary omission demonstrates the cause; it is not an installed fix and does not complete ticket 04.

A fix must reconcile tool-choice compatibility with admission-only tools that the host cannot execute. The existing `restoreAdmissionCalls` rejects any unavailable admission tool returned in a result or stream event. Preserve and verify that protection when changing the tool-choice policy. Cover both the normal zero-tool gate and the final-payload backstop, with fixtures for rejected tool-choice values and attempted calls to unavailable tools. Then rerun strict L0/L1/L2 acceptance through isolated DSH before claiming completion.

No additional full compat round, typecheck, offline suite, tarball-consumer check, release, or profile installation ran during diagnosis. No existing DSH process was started, stopped, or restarted. There were no temporary DSH installs to clean up. The previous compat temporary directory remains absent.

Original retry evidence: [acceptance](acceptance.md), [runner JSON](compat-0.2.1-alpha.3-2026-10-15.json). The original acceptance remains incomplete; the diagnostic success used a modified wire payload.

