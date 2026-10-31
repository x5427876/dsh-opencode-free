# What the OpenCode Zen free tier checks

**English** | [繁體中文](free-tier-gate.zh-TW.md)

A measurement note on how OpenCode Zen's anonymous free tier decides whether to
serve a request. It is written for authors of other clients and plugins, and for
anyone debugging a `403` or `429 free_tier_limit` from `/inference/v1`.

This is an observation by the maintainer of
[dsh-opencode-free](../README.md), not an upstream contract. Upstream publishes
no admission rules for third-party clients and can change them without notice.
Read [How far to trust this](#how-far-to-trust-this) before relying on a row.

## Summary

For the anonymous `public` key, the free tier admitted a request only when all of
these held:

1. The system prompt contains an `<env>` block with a `Working directory:` line.
   The value does not matter.
2. The request declares the official `read` tool, with the official description
   and parameter schema. Declaring `read` and `bash` together was admitted;
   `bash` alone was refused.
3. The TLS ClientHello offers the same cipher list as the official CLI (the
   17 suites Bun's BoringSSL sends, in the same order).

A fourth, narrower rule applied to one tool set: two tool names from the DSH
host, `subagent_fork` and `working_directory`, each caused refusal by name.

Everything else I varied did not change the outcome: the User-Agent, extra
`x-stainless-*` headers, the `x-opencode-session-id` header, `max_tokens`, and the
wording of the system prompt once the `<env>` block was present. The legacy
`/zen/v1` path was refused where `/inference/v1` was admitted (2026-10-14, Windows,
Node `fetch`, the same official request), so use `/inference/v1`.

## Method

Each cell is one request, with one change from the baseline, sent from the same
egress IP to the same model (`deepseek-v4.1-flash-free`) within the same day.

- **Baseline:** the main request captured from the official OpenCode CLI 1.19.5
  (npm `opencode-ai`) pointed at a local capture server that records headers and
  body. The first request of a run is the title request and has no tools; the
  second is the main request.
- **Sender:** Bun 1.3.14 or Node, with the request bytes held fixed.
- **Cipher list:** read from the ClientHello with a raw TCP listener, so the
  figure is what went on the wire, not what a library documents.
- **Repeats:** an admitted request was repeated at least once for each change.
- **Result:** "admitted" means the request was served with a reply. This project
  does not treat a bare `200` as evidence of success.

Measured 2026-10-30 and 2026-10-31 unless a row says otherwise. Tools: OpenCode CLI 1.19.5 (reference) and
2.2.5 (drift watch), DeepSeek Harness 0.2.1-rc.5, plugin 0.4.0.

## Results

### Request content

| Change from the baseline | Result |
|---|---|
| None, sent by Bun (`fetch` or `node:https`) | admitted |
| None, sent by Node `https` or `curl` | refused |
| Node, only the TLS cipher list replaced by Bun's 17 suites | admitted |
| Node, ALPN limited to `http/1.1`, or a cipher list shorter than those 17 (including without the CBC-SHA suites) | refused |
| System prompt replaced by one sentence, or only OpenCode's base prompt | refused |
| System prompt is `You are a helper.` plus the official `<env>` block | admitted |
| `<env>` holds only `Working directory:` (any value) | admitted |
| `<env>` without `Working directory:`, or no `<env>` tag | refused |
| No tools declared | refused |
| Only `read` and `bash` declared | admitted |
| `max_tokens` lowered, endpoint `/inference/v1`, other User-Agent, `x-stainless-*` added, session header removed | no effect |

### Tool declarations

Each row is the official CLI 1.19.5 with a different declared tool set, except the last, which was measured separately.

| Declared tools | Result |
|---|---|
| Default agent (all tools) | admitted |
| All tools, custom system prompt | admitted |
| No tools, default prompt | refused (`429 free_tier_limit`) |
| `read` only | admitted |
| `bash` only | refused |
| `read` and `bash` | admitted |
| MCP tools only (`host_read`, `host_bash`) | refused |
| `read` overridden by a custom tool with the official description and schema | admitted |
| Official `read` and `bash` with only the descriptions, or only the parameter schemas, replaced by a stub (2026-10-14, Windows, Node `fetch`) | refused (`403`), where the full declarations were admitted |

So the check is on the shape of the `read` declaration, not on the system prompt,
and a refusal can be caused by a tool declaration alone.

### Tool names

A real DSH first request carries 25 tools. After the three signals above were
matched it was still refused. The cause was tool names:

- The official CLI's 10 tools (`bash edit glob grep read skill task todowrite webfetch write`) were admitted.
- In the DSH set, `subagent_fork` and `working_directory` each caused refusal on
  their own. Renaming both to `agent_fork` and `cwd_tool` was admitted with the
  other 23 tools, their descriptions and schemas unchanged. Renaming only one was
  refused. Prefixing every name with `dsh_` was refused.
- The same names were admitted in some smaller sets. The full rule is not known,
  so this is a result for one tool set, not a published deny list.

### The v2 line

OpenCode has two release lines: v1 (npm `opencode-ai`, the default installer) and
v2 (GitHub releases, npm `@opencode/cli`). The newest 2.2.5 sends 12 tools in the
main request, renames `bash` to `shell` and `task` to `subagent`, drops
`todowrite`, and adds `question`, `websearch` and `execute`. It offers the same 17
cipher suites in the same order and keeps the `<env>` block. Replaying its 12
tools through the plugin's transport was admitted, so the gate accepted both
shapes at the time of measurement. Whether it will keep accepting v1 is not known.

## How far to trust this

- **Dated.** A row describes one time, one model and one IP. Upstream can change
  the gate between two requests, and rows can disagree later.
- **Confounded by quota.** The experiments themselves exhaust the quota of an IP.
  After about eighty non-official requests, the official CLI and Bun were refused
  from the same IP too. Re-running needs a fresh IP, and a refusal cannot be
  attributed to one signal without a control that was admitted just before it.
- **Not a full rule.** Three signals are necessary in these runs. They are not
  shown to be sufficient for every model, and the exact predicate behind
  `403 FreeTierError` is unknown.
- **`free_tier_limit` is not proof of exhausted quota.** It also appeared on
  requests from an IP that still had quota.
- **A `200` is not authorization.** It means the request was served. It is not a
  promise that third-party clients are supported.

## Reproduce

Do this on an isolated profile with a fresh IP, and keep it to a few requests.

1. Run the official CLI against a local OpenAI-compatible server that records
   each request, with its own `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `HOME` and
   `OPENCODE_DISABLE_AUTOUPDATE=1`: `opencode run --standalone --auto -m <provider>/<model> "say hi"`.
   Without `--standalone` the 2.x CLI starts a background service and can hang.
2. Point the provider at `https://127.0.0.1:<port>` with a raw TCP listener to
   read the ClientHello and its cipher list.
3. Change one thing, send the captured bytes with a client whose TLS settings you
   control, and record status and reply.

The official CLI puts your global `~/.claude/CLAUDE.md` and skill list into the
system prompt by default. Check a captured request before you replay or share it.

## What the plugin does about it

[dsh-opencode-free](../README.md) adds the `<env>` block, declares official-shape
`read` and `bash` tools, aliases the two refused names, and offers the CLI's cipher
list under Node. Keyed requests are not rewritten. The implementation is in
[`src/zen-provider.ts`](../src/zen-provider.ts) and [`src/zen-tls.ts`](../src/zen-tls.ts),
the working notes in [protocol notes](protocol-notes.md) (Traditional Chinese), and
which CLI line the plugin follows in [ADR-0006](adr/0006-opencode-v1-as-payload-reference.md).

## Cite this

> dsh-opencode-free maintainers. *What the OpenCode Zen free tier checks.*
> Measured 2026-10-30 to 2026-10-31 with OpenCode CLI 1.19.5 and 2.2.5.
> https://github.com/x5427876/dsh-opencode-free/blob/main/docs/free-tier-gate.md

Pin a commit in the URL when you cite a specific row, since the page is updated
when the measurements are repeated. Corrections and newer observations are welcome
as [issues](https://github.com/x5427876/dsh-opencode-free/issues).
