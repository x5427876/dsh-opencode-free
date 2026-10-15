# Issue tracker: GitHub

Issues and specs live in `x5427876/dsh-opencode-free`. Use `gh` from this clone,
otherwise add `--repo x5427876/dsh-opencode-free`.

## Read and update work

| Action | Command |
|---|---|
| Read | `gh issue view <n> --json number,title,body,labels,comments` |
| List open work | `gh issue list --state open --json number,title,labels,assignees` |
| Create | `gh issue create --title "..." --body-file <utf8-file>` |
| Claim | `gh issue edit <n> --add-assignee @me` |
| Label | `gh issue edit <n> --add-label "<label>"` |
| Record findings | `gh issue comment <n> --body-file <utf8-file>` |
| Resolve | `gh issue close <n> --comment "<verified outcome>"` |

Read the full issue and relevant comments before acting. Use the configured
[triage labels](triage-labels.md). Claim an open issue before implementing it;
close only when its acceptance criteria are verified. Record incomplete evidence
without turning it into a successful result. Publishing to the tracker means
creating an issue, not a local ticket file.

For multiline bodies, use a UTF-8 temporary file; do not interpolate issue text
into shell commands. Check existing issues before creation to avoid duplicates.

## Parent issues and blockers

Specs are parent issues; implementation tickets are native sub-issues. Use
`gh issue edit <parent> --add-sub-issue <child>` where supported, otherwise
`gh api --method POST repos/x5427876/dsh-opencode-free/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`.

Record native dependencies with
`gh api --method POST repos/x5427876/dsh-opencode-free/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`.
Database IDs come from `gh api repos/x5427876/dsh-opencode-free/issues/<n> --jq .id`,
not the issue number or node ID. If native links are unavailable, use explicit
`Part of #<parent>` and `Blocked by: #<n>` lines. Work only on unassigned tickets
whose blockers are closed; do not infer readiness from labels alone.

## Pull requests as a triage surface

**PRs as a request surface: no.** A bare `#<n>` may still identify a PR because
GitHub shares the number space; distinguish it before updating.

## Former local tickets

GitHub state, assignees, requirements, and dependencies are canonical. `.scratch/`
was removed after migration; only when resolving a former path or checking for a
duplicate migration, read the [historical mapping](../archive/github-migration.md).
Migration does not complete unfinished acceptance. Preserve findings and outcomes;
source/evidence paths at unpushed commits are not usable GitHub blob links.
