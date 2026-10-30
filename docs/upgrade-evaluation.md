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

## 4. Decide: code change, or pins and documentation only

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
| Release notes touch only UI, ACP or other areas the plugin does not use | **Pins and docs** (confirm in step 6) | Still needs the live compat run. |
| Peer or dependency ranges changed (`cordis`, `schemastery`, `pi-ai`, loader) | **Pins and docs plus peer ranges** | Update `package.json`, `pnpm-workspace.yaml` and the lockfile together. |
| Any file in the packages above differs, or release notes mention providers, request context, tools, credentials or reasoning | **Code change likely** | Read the diff; find affected code and tests in `src/` and `tests/`; see [protocol notes](protocol-notes.md). |
| A version-scoped behavior the plugin relies on (see the `AGENTS.md` rc.1/rc.2 note) | **Code change likely** | Check how the context reaches the provider before assuming compatibility. |

"Pins and docs" is a hypothesis until the checks in steps 5 and 6 pass.

## 5. Check the effect on the working tree

Move to a branch, apply the pin changes listed in [release.md](release.md#only-when-dsh-compatibility-changes),
and run `pnpm install` and `pnpm run check`. Expected: type check and tests pass.
`tests/version-sync.test.mjs` fails until the plugin version row in both READMEs
is bumped; that failure belongs to the release, not to DSH compatibility. Any other
failure is a compatibility signal: report it with the test name.

## 6. Run the live compat verification (only with authorization)

```sh
pnpm compat --dsh <target> --tools --out .compat/<name>
```

It sends real anonymous requests and consumes shared quota, so an Agent runs it
only when the user has asked for it ([compat run](compat-run.md)). Read the exit
code as `AGENTS.md` defines it. Exit `2` is not a pass and not a plugin fault.

## 7. Report the plan

Reply with one message that contains:

1. **Current state:** local and remote SHAs, newest tag and Release, plugin
   version, pinned DSH.
2. **Official latest:** newest release per track, its date, and the target
   chosen with the reason.
3. **Assessment:** the class from step 4, the evidence (which packages were
   compared, which notes were read) and what remains unproven.
4. **Verification:** results of `pnpm run check` and the compat run, with exit
   code and per-layer outcome; state what was not run.
5. **Plan:** the exact files to change, the proposed plugin version, whether code
   changes are needed, and the remaining release steps from
   [release.md](release.md). Mark which steps need the maintainer's approval.

Do not commit, tag, push or publish while evaluating. Leave the evaluation branch
for the maintainer to accept or discard.
