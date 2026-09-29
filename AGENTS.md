# Agent installation guide

Use this guide when a user asks an Agent to install, update, verify, or remove
`dsh-opencode-free`.

## Safety

- Confirm the target DSH profile; use `web` only when it is the user's target.
- Use the pinned `v0.2.1` release assets for a first install, never a moving branch.
- Never print API keys, credential stores, or request bodies.
- Do not start, stop, or restart DSH without explicit permission.
- Preserve the DSH profile, unrelated plugins, and stored credentials.
- Do not delete any DSH profile during install, update, verification, or uninstall.

## Detect the installation

This plugin release supports only DeepSeek Harness `0.2.0-rc.2`. Run
`dsh --version` first and stop on any other version; do not upgrade DSH or
ignore peer dependency warnings without explicit permission.

Check whether the plugin is already installed in the target DSH profile. When
it is already listed, use update or uninstall instead of installing again.

## Existing DSH CLI

When `dsh`, Node.js, and pnpm are already available, install the pinned npm
package directly:

```sh
dsh plugin --profile web add dsh-opencode-free@0.2.1
```

Update with `dsh plugin --profile web update dsh-opencode-free`.
Uninstall the current package with:

```sh
dsh plugin --profile web remove dsh-opencode-free
```

## Desktop profile install (DSH Desktop)

The DSH Desktop app composes profiles under `~/.dsh/profiles`. For each target
profile (`desktop`, `web`):

1. `pnpm pack` the plugin into a tarball (or download the pinned release tarball).
2. Copy the tarball into the profile directory.
3. Add `"dsh-opencode-free": "file:./dsh-opencode-free-0.2.1.tgz"` to
   the profile's `package.json` `dependencies` and add `dsh-opencode-free`
   to its `dsh.profile.bundles` array.
4. Run `pnpm install` in the profile directory.
5. The user must restart DSH once for the plugin to load.

v1 carries no persisted login: the Zen key comes from the plugin row's
`config.apiKey` or the `OPENCODE_API_KEY` environment variable, falling back
to the anonymous `public` tier. Never edit any credential store by hand while
the plugin runs.

## Verify

For the existing CLI path, run:

```sh
dsh plugin --profile web list dsh-opencode-free --depth 0
dsh --profile web --dump-config
```

Success requires:

1. The requested package version appears once.
2. `opencode-free` appears once in the composed config after install
   or update, and is absent after uninstall.
3. No unrelated profile or plugin changed.
4. A running DSH process was not restarted by the operation.

Do not treat `dsh plugin --profile web peers check` as the completion test.
If the user authorizes a live check, restart DSH manually, open the model
picker, and verify the `opencode-zen-free` provider and its models are
selectable. Only when the user explicitly requests a quota-consuming live
check, ask the Agent to send one short message with a Zen free model and
confirm the reply. Never promise anonymous success: the anonymous tier is
a shared per-egress-IP bucket that upstream gates without notice; if the
live check fails gated, point to the key path in `README.md` instead of
retrying installation. Key setup itself is verified quota-light with
`scripts/reverify.sh` lamp ③ (see `README.md`).

## Failure handling

On any failure, report the sanitized command error, DSH version, selected
profile, requested release, installation mode, what changed, cleanup status,
and what remains unverified. Do not patch DSH, switch to another paid route,
wipe credentials, delete a profile, or claim success from a partial check.

## Agent skills

### Issue tracker

Issues live as local markdown under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: root `CONTEXT.md` plus `docs/adr/`. See `docs/agents/domain.md`.
