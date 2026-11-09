# DSH upgrade evaluation

Run this **before** any DSH upgrade work. It decides whether a newer DeepSeek
Harness (DSH) needs a code change or only pin and documentation changes, and ends
with a plan for the maintainer. It is read-only against the remote and the
maintainer's DSH profiles. It does not authorize a release; use the
[release checklist](release.md) for that. Rules: [C1, C3](standards.md#3-compatibility-and-dependencies).

Report only what a command showed. If a step cannot finish, say so and stop
rather than guess.

## 1. Confirm the plugin is current, locally and remotely

```sh
git fetch --tags origin
git status -sb                      # clean tree, on main, not ahead/behind
git rev-parse HEAD origin/main      # both SHAs must match
git tag --sort=-v:refname | head -3
gh release list -R x5427876/dsh-opencode-free --limit 3
node -p "require('./package.json').version"
node -p "require('./package.json').peerDependencies['@deepseek-ai/dsh-llm']"
```

Pass condition: `HEAD` equals `origin/main`, the newest tag and GitHub Release
equal `package.json` `version`, and the pinned DSH is the one the README names.
If local is behind, pull first. If a tag or Release is missing, the previous
release is incomplete; report it before planning an upgrade.

## 2. Find the latest official DSH release

```sh
gh release list -R deepseek-ai/deepseek-harness --limit 15
npm view @deepseek-ai/dsh-llm dist-tags --json
```

- Official releases are tagged `dsh-v<version>`. Read the notes of **every**
  release between the pinned version and the target, not only the newest:
  `gh release view dsh-v<version> -R deepseek-ai/deepseek-harness`.
- The `latest` npm dist-tag has lagged behind the real release line; do not
  use it alone. Compare the GitHub list with the `next` (release candidates)
  and `alpha` tags.
- Target the newest release on the same track as the current pin (rc to rc,
  stable to stable). Name any newer alpha or other track in the report, but do
  not target it unless the maintainer asks.
- If the pin is already the newest on its track, stop: no upgrade is needed.

## 3. List the official free models

The free-model set comes from the official list alone
([ADR-0005](adr/0005-official-model-list-as-free-model-source.md)); a host upgrade
does not change it, but the report states it so a drift is visible:

```sh
curl -s https://opencode.ai/inference/v1/models \
 | jq -r '.data[] | select(.type=="chat"
     and .cost.text.input.price==0 and .cost.text.output.price==0) | .id'
```

Compare the result with the previous release's notes or your last local run. Name
models that appeared or disappeared; do not treat a difference as a plugin fault.
The documentation page and `opencode models` are not sources: they can disagree
with the list and lag behind it.

## 4. Check the official CLI payload

The anonymous gate admits a request by its content, not by version
([protocol notes](protocol-notes.md)). The plugin matches the official CLI in four
places, so a new CLI release can change what the gate expects. Run this whenever a
CLI release is newer than the one the notes were measured on, not only on a DSH release.

The CLI has two release lines ([ADR-0006](adr/0006-opencode-v1-as-payload-reference.md)):

- **v1** (npm `opencode-ai`) is the **reference**: the plugin imitates it.
- **v2** (GitHub releases, npm `@opencode/cli`) is the **drift watch**: capture and
  replay it, record the result, but do not change code for it alone.

```sh
npm view opencode-ai dist-tags.latest              # v1 line
npm view @opencode/cli dist-tags.latest            # v2 line
gh release list -R anomalyco/opencode --limit 15   # both lines ship here
gh release view <tag> -R anomalyco/opencode        # read every release since the measured one
```

Read the notes for tool renames or additions, system prompt or header changes, and
provider or auth changes. Also check whether the official docs still call v1 supported
and which line the default installer serves; the ADR lists the conditions that reopen
the choice of reference.

Then capture what the newest CLI of **each line** actually sends:

1. Downloading a binary needs the user's approval: name the asset, source and size.
   Download the asset for the host platform, check it against `SHA256SUMS`, and
   unpack it in its own empty directory. The v1 line is also available from npm.
2. Point a custom OpenAI-compatible provider at a local capture server that records
   each request's headers and body and answers with a minimal event stream. Run
   `opencode run --standalone --auto -m <provider>/<model> "say hi"` with its own
   `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `HOME`, and `OPENCODE_DISABLE_AUTOUPDATE=1`.
   Without `--standalone` the 2.x CLI starts a background service and the run can hang.
   The first request is the title request and has no tools; the second is the main request.
3. To read the TLS cipher list, point the provider at `https://127.0.0.1:<port>` with a raw
   TCP listener and parse the ClientHello.

Compare with the plugin:

| Signal | Plugin source | Compare |
|---|---|---|
| Tool names and count in the main request | `GATE_TOOL_ALIASES`, the host tool set | New, renamed or removed tools |
| `<env>` block with `Working directory:` in the system prompt | `ENVIRONMENT_BLOCK` | Wording and fields |
| TLS cipher list and order | `OPENCODE_TLS_CIPHERS` | The 17 ids in order, ignoring GREASE |
| Identity headers | `OPENCODE_USER_AGENT`, `x-opencode-*` | New or dropped headers; the gate has not keyed on the User-Agent |

Then replay the captured tool set through the plugin's transport
(`zenHttpsFetch` from `lib/zen-tls.js`) against the live endpoint. The replay sends
real anonymous requests, so it needs the user's authorization like step 7; keep it to
a few requests, since an exhausted IP also refuses official clients. Classify each line:

- **Unchanged:** same signals, replay admitted. Record the CLI version and stop.
- **Changed, replay admitted:** note the drift in the protocol notes. The plugin keeps
  working; for the v2 line this is the expected outcome and needs no code change.
- **Reference line changed, replay refused:** code change likely in `src/zen-provider.ts`
  or `src/zen-tls.ts`; update the protocol notes with the new observation.
- **Only the v2 line admitted:** the gate may have moved on. Report it and reopen
  ADR-0006 with the maintainer before changing code.

## 5. Decide: code change, or pins and documentation only

The plugin calls only the packages below. Compare the pinned version with the
target by their published contents, not by release notes alone:

```sh
S=$(mktemp -d)   # unpack each tarball in its own empty directory
for p in dsh-llm dsh-llm-pi-ai dsh-fs dsh-attachment dsh-credentials \
         dsh-authorization dsh-launch-environment dsh-timeout dsh-brand \
         dsh-util-values dsh-util-crypto dsh-typert-protocol; do
  for v in <pinned> <target>; do
    mkdir -p "$S/$p-$v" && (cd "$S/$p-$v" && npm pack "@deepseek-ai/$p@$v" --silent >/dev/null && tar xzf ./*.tgz)
  done
  echo "== $p"; diff -rq "$S/$p-<pinned>/package" "$S/$p-<target>/package" | grep -v 'package.json differ'
done
npm view @deepseek-ai/dsh-llm-pi-ai@<target> peerDependencies dependencies --json
```

Then classify the result:

| Finding | Class | Meaning |
|---|---|---|
| Only `package.json` differs, and only in version fields | **Pins and docs** | Provider-facing contracts are unchanged. |
| Release notes touch only UI, ACP or other areas the plugin does not use | **Pins and docs** (confirm in step 7) | Still needs the live compat run. |
| Peer or dependency ranges changed (`cordis`, `schemastery`, `pi-ai`, loader) | **Pins and docs plus peer ranges** | Update `package.json`, `pnpm-workspace.yaml` and the lockfile together. |
| Any file in the packages above differs, or release notes mention providers, request context, tools, credentials or reasoning | **Code change likely** | Read the diff; find affected code and tests in `src/` and `tests/`; see [protocol notes](protocol-notes.md). |
| A version-scoped behavior the plugin relies on (see the `AGENTS.md` rc.1/rc.2 note) | **Code change likely** | Check how the context reaches the provider before assuming compatibility. |

"Pins and docs" is a hypothesis until the checks in steps 6 and 7 pass.

## 6. Check the effect on the working tree

Move to a branch, apply the pin changes listed in [release.md](release.md#only-when-dsh-compatibility-changes),
and run `pnpm install` and `pnpm run check`. Expected: type check and tests pass.
`tests/version-sync.test.mjs` fails until the plugin version row in both READMEs
is bumped; that failure belongs to the release, not to DSH compatibility. Any other
failure is a compatibility signal: report it with the test name.

## 7. Run the live compat verification (only with authorization)

Use the [default verification mode](compat-run.md#default-verification-mode): L0 on
every free model, then L1 and L2 on one model.

```sh
pnpm compat --dsh <target> --l0-only --out .compat/<name>-l0-all
pnpm compat --dsh <target> --model deepseek-v4.1-flash-free --tools --out .compat/<name>-l12-one
```

It sends real anonymous requests and consumes shared quota, so an Agent runs it
only when the user has asked for it ([compat run](compat-run.md)). Read the exit
code of each run as `AGENTS.md` defines it. Exit `2` is not a pass and not a plugin
fault. Run full acceptance (`--tools` without `--model`) only when the maintainer
asks.

## 8. Report the plan

Reply with one message that contains:

1. **Current state:** local and remote SHAs, newest tag and Release, plugin
   version, pinned DSH.
2. **Official latest:** newest release per track, its date, and the target
   chosen with the reason. Also the newest official CLI release of each line
   (v1 reference, v2 drift watch), whether its payload differs from the plugin's four
   signals, and the replay result.
3. **Assessment:** the class from step 5, the evidence (which packages were
   compared, which notes were read) and what remains unproven.
4. **Verification:** results of `pnpm run check` and the compat run, with exit
   code and per-layer outcome; state what was not run.
5. **Plan:** the exact files to change, the proposed plugin version, whether code
   changes are needed, and the remaining release steps from
   [release.md](release.md). Mark which steps need the maintainer's approval.

Do not commit, tag, push or publish while evaluating. Leave the evaluation branch
for the maintainer to accept or discard.
