# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

## Where labels live

The tracker is local markdown (see `issue-tracker.md`), which has no native labels. Record them as a `Labels:` line near the top of the issue or spec file, next to `Status:`, comma-separated:

    Status: open
    Labels: ready-for-agent

`Status:` tracks `open | claimed | resolved`; `Labels:` tracks the triage role. They are independent: a `ready-for-agent` issue is still `Status: open` until someone claims it.
