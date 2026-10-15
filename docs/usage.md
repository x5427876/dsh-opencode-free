# Usage guide

**English** | [繁體中文](usage.zh-TW.md)

For installation and exact version requirements, start with the [README](../README.md).
This guide covers catalogue refresh, probes, cache recovery, and optional keys.

## Model catalogue and refresh

- [models.dev](https://models.dev) supplies free-model metadata, including context
  limits and published capabilities. Zen's `/inference/v1/models` determines
  which entries are currently listed upstream.
- Refreshes are lazy: expiry makes the next catalogue read eligible to refresh;
  it is not a promise of a background update at an exact time.
- models.dev's default window is 24 hours. After an unchanged response (`304`),
  it shortens to 6 hours; a changed response returns it to 24 hours.
- Zen's listing has an independent 30-minute window and is rechecked on startup.
  Listing requests do not consume inference quota.
- Failed refreshes preserve the last usable list. Without network or cache,
  pi-ai's bundled catalogue is the fallback.
- Free entries served by Zen but missing from models.dev are shown as unknown
  on the detail page, not offered with guessed capabilities in the picker.

## Model switches and probes

Use the plugin detail page to hide models you do not use. Hidden models are not
probed. Switches are plugin configuration, separate from the catalogue cache.

Reading the model list triggers one automatic probe round per local calendar
day. **Probe now** requests another round, with a minimum interval of 5 minutes.
**Probes send real inference requests and consume quota.** Models are checked
sequentially; channel fallback may require additional requests. Anonymous quota
is shared by callers behind the same egress IP.

| Result | Meaning and next step |
|---|---|
| Measured | The model answered in that round; latency is not a future availability guarantee. |
| Not measured | Admission refusal, quota, authentication, network, or another inconclusive condition. Read the banner; the model is not removed on this evidence. |
| Unavailable | An explicit model-level refusal after the implemented channels have been checked. The persisted `dead` verdict is not automatically probed again. |
| Absent from Zen's listing | Hidden while absent; it can reappear if Zen lists it again. This is distinct from a persisted `dead` verdict. |

Results survive restarts. A Zen key does not clear a persisted verdict or bring
back a model absent from the listing. See [ADR-0002](adr/0002-catalogue-source-of-truth.md)
for the decision rules.

## Reassess the whole catalogue

Use this only when you intentionally want to discard cached metadata and probe
history, for example after an upstream channel repair. It is not a fix for quota
exhaustion or an admission refusal.

1. Resolve the `DSH_HOME` used by the target DSH process. If nonempty, the cache
   is `<DSH_HOME>/dsh-opencode-free/catalog.json`; otherwise it is
   `~/.dsh/dsh-opencode-free/catalog.json` under that process's home directory.
   Desktop may use a different `DSH_HOME` from your shell.
2. Stop the target DSH instance yourself before changing its cache. An Agent
   must obtain explicit permission before stopping or restarting it.
3. Back up and remove **only `catalog.json`**. Keep profiles, credentials,
   unrelated plugin files, and the rest of `DSH_HOME` intact.
4. Start DSH again. The catalogue is rederived; the next probe round treats
   models as unprobed and consumes inference quota. Hidden-model preferences
   remain in plugin configuration.

Retain the backup if you need the old results. To restore it, stop DSH first and
put it back at the same path. Do not edit cache fields by hand while DSH runs.

## Optional Zen key

The plugin reads keys in this order:

1. Plugin `config.apiKey`.
2. `OPENCODE_API_KEY` in the DSH process environment.
3. Anonymous `public`.

Set `apiKey` in the target profile's `cordis.patch.yml`, particularly for Desktop:

```yaml
- id: opencode-free
  name: dsh-opencode-free
  config:
    apiKey: <your Zen key>
```

Alternatively, set `OPENCODE_API_KEY` in the environment that launches DSH.
Reload after changing plugin configuration; changing a shell variable does not
change an already-running DSH process. To return to anonymous access, remove both
key sources. No credential-store edits or login flow are needed.

Keep the key, configuration, and raw debug output private. Current debug logs
can expose an Authorization prefix and upstream error content; see [gap G1](standards-gap.md#g1-debug-logs-include-authorization-fragments).

### Verify the configured path

A configuration check proves only that the setting is present, not that the key
works. If you explicitly want a quota-consuming live check:

1. Load the configuration in the target DSH profile.
2. Select one model under **OpenCode Zen Free** and send one short message.
3. Confirm a nonempty reply. Record only versions, profile, model ID, and the
   sanitized outcome. If it fails, an upstream error alone does not prove the
   key is invalid; do not automatically reinstall or retry.

When checking the environment-key path, make sure a config key is not overriding
it. Do not enable raw debug logging to inspect credentials. A reply checks that
model and request path only, not tool use or every free model. Broader actual-host
verification is documented in the [compat run guide](compat-run.md); it can
consume quota across the whole catalogue and needs separate authorization.

> [!WARNING]
> `scripts/reverify.sh` is currently a legacy diagnostic: it still uses
> `/zen/v1`, a random session time region, and empty tool declarations. Its
> lamps and exit code do not verify the current plugin's admission or key path;
> do not use it as the completion test. It also sends real requests, may print
> upstream errors, and is available only from a clone, not the package tarball.

## Further reading

- [Protocol analysis and evidence boundaries](protocol-notes.md)
- [Actual-host compatibility verification](compat-run.md)
- [Agent installation and safety procedures](../AGENTS.md)
