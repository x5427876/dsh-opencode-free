# Release checklist

Use this for **every plugin release**, including patch releases without a DSH
upgrade. Required policy: [R1–R5](standards.md#8-versioning-and-releases).
A release is not complete when only the commit or tag has been pushed.

A user request to publish a release covers the routine checklist below. Preparing
files or updating these instructions alone does not authorize remote publication.
Confirm the plugin version and release branch/commit first. Replacing an existing
tag or asset requires explicit permission. The maintainer publishes to npm by
hand; an Agent never runs `npm publish`.

## 1. Update version and prepare release notes

- Choose the new plugin version under the project's versioning policy.
- Update `package.json` `version`, `src/zen-provider.ts` `PLUGIN_VERSION`, both
  README install commands and compatibility rows, and the version/package/tarball
  pins in `AGENTS.md`. Refresh the lockfile if affected; preserve unrelated work.
- Prepare notes for the GitHub Release, the sole version-change record. Name the
  plugin version and exact supported DSH version; summarize changes, verification,
  and limits. Keep the notes in an ignored temporary file until publication,
  rather than maintaining a second tracked changelog.

### Only when DSH compatibility changes

Inspect the target's release notes and exact package manifests, not moving master:

```sh
gh release view dsh-v<dsh-version> -R deepseek-ai/deepseek-harness
npm view @deepseek-ai/dsh-llm-pi-ai@<dsh-version> peerDependencies dependencies --json
```

Update both exact DSH peer pins, the adapter's pi-ai peer range, affected peers
and lockfile, `pnpm-workspace.yaml` release-age exclusions, and the host version
in `src/index.ts`. Synchronize both READMEs, `AGENTS.md`, the example in
`docs/compat-run.md`, and current compatibility prose. Each plugin release still
supports exactly one DSH version; a plugin patch does not itself justify a host upgrade.

## 2. Verify the release candidate

1. Run `pnpm run check` and `pnpm pack --dry-run`. Version-sync tests must pass.
2. Check the actual `.artifacts/dsh-opencode-free-<plugin-version>.tgz`: expected
   exports, declarations, client and patch files; no credentials or scratch data.
   Verify it matches the release source and perform artifact-consumer checks
   required by R2. A passing source build alone is not package verification.
3. For a DSH upgrade, follow the [compat run guide](compat-run.md) with explicit
   live-request authorization. Keep dated reports in `docs/compat-reports/`.
   Report incomplete results honestly; release preparation does not authorize
   quota consumption or turn an unfinished run into a pass.
4. Commit the release changes and push the approved release branch. Confirm CI
   passed for the exact release commit. Rebuild/recheck if packaged source changes.

## 3. Push the annotated tag and publish GitHub Release

Use the verified release commit, not an implicit current branch tip:

```sh
git tag -a v<plugin-version> <release-sha> -m v<plugin-version>
git push origin refs/tags/v<plugin-version>
gh release create v<plugin-version> .artifacts/dsh-opencode-free-<plugin-version>.tgz \
  --repo x5427876/dsh-opencode-free --title v<plugin-version> \
  --verify-tag --latest --notes-file <notes.md>
```

For a prerelease, use `--prerelease` instead of `--latest`. If the tag or release
already exists, inspect it and resume missing steps rather than force-overwriting
or creating duplicates. Tag replacement requires separate approval.

Write release notes with Highlights, Compatibility and limitations, Validation
(commands, OS/profile, unverified scope), and Install.
Attach the verified tarball and disclose incomplete live evidence. Keep README
and GitHub Release text focused on shipped behavior, compatibility, and installation.
Keep internal publication handoffs and temporary registry-status reminders in
maintainer communications, not public release content. Check npm's actual state before describing availability; never infer it from a tag or assume
it is pending. Review the result on the
[releases page](https://github.com/x5427876/dsh-opencode-free/releases).

## 4. Completion gate

Every item is required before reporting a release complete:

- [ ] Version declarations, install pins and compatibility documentation agree.
- [ ] GitHub Release notes describe this version and its exact supported DSH;
      release-history links point to GitHub Releases, not a separate local changelog.
- [ ] Checks passed for the release source; limitations are stated in release notes.
- [ ] The remote annotated `v<plugin-version>` tag resolves to the verified commit.
- [ ] A published, non-draft GitHub Release exists for that tag with the intended
      stable/prerelease status, notes, and uploaded tarball matching the local asset.
- [ ] Actual npm availability was checked; installation instructions agree with it.
      Public text contains no internal handoff or stale publication-status reminders.

Verify remote state with the read-only command, using the exact tarball verified
for publication (not a newly rebuilt candidate):

```sh
pnpm verify:release --version <plugin-version> --commit <full-release-sha> \
  --asset .artifacts/dsh-opencode-free-<plugin-version>.tgz
```

Requires Node and `tar`. The command reads the tarball's version and exact DSH pin,
then queries public GitHub and npm metadata using anonymous GET requests. It checks
the annotated tag's commit, published Release and stable/prerelease status, explicit
`Supports DeepSeek Harness <version>` or `Requires DeepSeek Harness <version>` notes
(Markdown emphasis accepted), and the attached tarball's SHA-256 against the local
file. npm verification checks package/version metadata, not registry tarball content
or installation. It does not validate CI or replace the artifact-consumer checks.

Exit codes: `0` means these checks passed; `1` means a mismatch or a missing public
tag, Release, asset, or npm version; `2` means verification could not finish (invalid
inputs, unavailable digest, malformed metadata, network errors or API rate limits).
No credentials, publishing, remote writes, DSH launches or inference requests are used.
This command is intentionally separate from `pnpm run check` and default CI.

`pnpm check:docs` checks local Markdown destinations and heading anchors, including
reference links and duplicate headings; it ignores fenced/inline code and external
URLs. It is included in `pnpm run check`, which the existing CI already runs.

Return the release URL and commit. If a required step failed, report the release
as incomplete and name the remaining step in the maintainer handoff. An npm lookup
failure is not proof that a version is unpublished; distinguish registry absence
from authentication/network failures. Report only verified state, without adding
process commentary to public release text.
