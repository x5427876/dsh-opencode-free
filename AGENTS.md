# Agent installation guide

Use this guide when a user asks an Agent to install, update, verify, or remove
`dsh-opencode-free`.

## Safety

- Confirm the target DSH profile; use `web` only when it is the user's target.
- Use the pinned `v0.3.0` release assets for a first install, never a moving branch.
- Never print API keys, credential stores, or request bodies.
- Do not start, stop, or restart DSH without explicit permission.
- Preserve the DSH profile, unrelated plugins, and stored credentials.
- Do not delete any DSH profile during install, update, verification, or uninstall.
- `scripts/reverify.sh` and `scripts/test-live.mjs` are not in the tarball; run
  them from a clone. `scripts/reverify.sh` sends real requests against the shared
  anonymous bucket, so run it only when the user has asked for a live check.

## Detect the installation

This plugin release supports only DeepSeek Harness `0.2.0-rc.2`. Run
`dsh --version` first and stop on any other version; do not upgrade DSH or
ignore peer dependency warnings without explicit permission.

`0.2.0-rc.1` is deliberately NOT in that range, and the peer pin is exact
rather than a union on purpose. rc.1 and rc.2 differ in how a request context
reaches the provider: pi-ai 0.86+ normalises a legacy `Context` into a
`TranscriptContext`, and only that form reaches a provider at all, so a gate
that writes `context.tools` works on one and is silently discarded on the
other. A range spanning both would advertise the union of two behaviours only
one of which has ever been observed here, and would make CI's typecheck
resolve to whichever release matched that day.

Check whether the plugin is already installed in the target DSH profile. When
it is already listed, use update or uninstall instead of installing again.

## Existing DSH CLI

When `dsh`, Node.js, and pnpm are already available, install the pinned npm
package directly:

```sh
dsh plugin --profile web add dsh-opencode-free@0.3.0
```

Update with `dsh plugin --profile web update dsh-opencode-free`.

Uninstall the current package with:

```sh
dsh plugin --profile web remove dsh-opencode-free
```

## Desktop profile install (DSH Desktop)

DSH Desktop composes profiles under a home directory — `~/.dsh/profiles/<name>/`,
relocated to `$DSH_HOME/profiles/<name>/` when `DSH_HOME` is set. **Resolve it
before copying anything**; guessing puts the tarball somewhere `pnpm install`
will not see it, and the failure looks like a missing file rather than a wrong
directory.

```sh
DSH_ROOT="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_ROOT/profiles/desktop"    # or .../profiles/web
```

Then, for each target profile (`desktop`, `web`):

1. `pnpm pack` the plugin into a tarball (or download the pinned release tarball).
2. Copy the tarball into `$PROFILE_DIR`.
3. Add `"dsh-opencode-free": "file:./dsh-opencode-free-0.3.0.tgz"` to
   `$PROFILE_DIR/package.json` `dependencies` and add `dsh-opencode-free`
   to its `dsh.profile.bundles` array.
4. Run `pnpm install` in `$PROFILE_DIR`.
5. The user must restart DSH once for the plugin to load.

The `file:` specifier is relative, so the tarball must sit in the same
directory as that `package.json` — not in the repository you packed from.

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
2. `dsh --profile web --dump-config` shows `opencode-free` exactly once after
   install or update, and absent after uninstall.
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
