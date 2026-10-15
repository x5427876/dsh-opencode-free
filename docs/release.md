# Moving to a new DSH release and releasing

Use this to support a new DeepSeek Harness (DSH) release and to cut the plugin
release for it. Each plugin release supports exactly one DSH version (standards
rule C1). Pushing to `main`, tagging, and creating a GitHub release happen only
when the user asks for them. The maintainer publishes to npm by hand; an Agent
never runs `npm publish`.

## 1. Find the target and what changed

```sh
gh release list -R deepseek-ai/deepseek-harness --limit 5     # latest DSH tag, e.g. dsh-v0.2.1-alpha.2
gh release view dsh-v<version> -R deepseek-ai/deepseek-harness   # release notes
for p in dsh-llm dsh-llm-pi-ai; do npm view @deepseek-ai/$p@<version> peerDependencies dependencies --json; done
```

Compare the new manifests with the pinned ones. A changed `pi-ai` range moves the
plugin's `pi-ai` peer with it, and the plugin's `pi-ai` imports need a check.
`npm view dsh` is an unrelated package.

## 2. Change these together

`package.json`'s peer pins are the source of truth. `tests/version-sync.test.mjs`
fails when a file below disagrees with them.

- `package.json`: `version`, the exact `dsh-llm` / `dsh-llm-pi-ai` pins, and the
  `pi-ai` peer (it must equal the range `dsh-llm-pi-ai` depends on).
- `src/zen-provider.ts` `PLUGIN_VERSION`, and the DSH version in the `src/index.ts` header.
- `pnpm-workspace.yaml`: add the new version to every `minimumReleaseAgeExclude` DSH entry.
- `README.md` and `README.zh-TW.md`: the Requirements row and a new first row in the compatibility table.
- `AGENTS.md`: the supported version, the `v<version>` pin, and every `dsh-opencode-free@<version>` / `.tgz` name.
- `docs/compat-run.md`: the example `--dsh` version.
- `CHANGELOG.md`: a new leading section that says `Supports DeepSeek Harness \`<version>\``.
- Prose that names an old host version, such as the `pi-ai 0.87` wording in
  `src/zen-provider.ts` and `docs/protocol-notes.md`. Search the previous
  version and major `pi-ai` number; no test covers this.

Then run `pnpm install` and `pnpm run check`. Tests that read the `pi-ai` builtin
model table (`tests/catalog.test.mjs`) may need new ids when `pi-ai` changes.

## 3. Verify on a live DSH

Run the compat run from [`compat-run.md`](compat-run.md) with the user's approval
and commit its report in `docs/compat-reports/`.

## 4. Release

1. Commit with the release message style of earlier `Support DeepSeek Harness …` commits.
2. `git push origin main`, then `git tag -a v<version> -m v<version>` and `git push origin v<version>`.
3. Create the release with the tarball that `pnpm run check` wrote to `.artifacts/`:

   ```sh
   gh release create v<version> .artifacts/dsh-opencode-free-<version>.tgz \
     --title v<version> --verify-tag --latest -F <notes.md>
   ```

   Model the notes on the previous release (`gh release view v<previous>`):
   Highlights, Compatibility and limitations, Validation (what ran, on which OS and
   profile, what stayed unverified), Install, and a CHANGELOG link.
4. Tell the maintainer the release is ready for `npm publish`.
