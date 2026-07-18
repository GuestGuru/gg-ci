# gg-ci

Cross-app CI infrastructure for GuestGuru. **This repository is public** — it contains
generic glue code only. Never add infrastructure identifiers, tokens, or app-specific
default values here.

## Neon preview branches

Gives every pull request an isolated, production-forked Neon database that the Vercel
preview build **and** the preview URL's runtime both use, by setting a git-branch-scoped
preview environment variable on the Vercel project.

Needed because the native Neon–Vercel integration binds one Neon project to a single
Vercel project — in a shared Neon project only one app can use it.

### Commands

| Command | When | What it does |
|---|---|---|
| `ensure` | PR opened / reopened / synchronize | Forks (or reuses + extends TTL on) the PR's Neon branch, sets the Vercel preview env vars, redeploys once if the vars were just created |
| `destroy` | PR closed / merged | Deletes the Neon branch and the branch-scoped env vars |
| `refresh-ttl` | Daily cron | Extends TTL for open PRs, deletes branches whose PR is closed |
| `reset-shared` | Weekly cron | Resets the shared fallback branch from production |

All commands are idempotent and support `--dry-run`.

### Onboarding a new app

1. **Neon:** create a long-lived shared preview branch (e.g. `preview-shared`) forked
   from production, in your app's Neon project.
2. **Vercel:** set your app's connection-string variable (e.g. `NEON_CONNECTION_STRING`)
   in the **Preview** scope, with **no** git branch, pointing at that shared branch. This
   is the fallback that keeps every preview build green.
3. **GitHub:** add **repository** secrets `NEON_API_KEY` and `VERCEL_TOKEN`.

   Use repository secrets, not organization secrets. On the GitHub **Free** plan an
   organization secret can be assigned to a private repository through the API and the
   UI, but it is **not delivered to the workflow at runtime** — the step sees an empty
   value and the CLI fails with `Missing required env var: VERCEL_TOKEN`. Verified the
   hard way, 2026-07-18. One Vercel token may still serve every app (tokens are
   team-scoped); it just has to be stored in each repository separately.
4. **Build step:** make your build run migrations in preview only when
   `PREVIEW_DB_ISOLATED === '1'`. Without this guard a half-finished migration from any
   branch would poison the shared branch for every other preview.
5. **Caller workflow:** copy the example below into `.github/workflows/preview-db.yml`
   and fill in your identifiers. It covers all four commands: `ensure` on PR
   open/reopen/synchronize, `destroy` on PR close, a daily `refresh-ttl`, and a weekly
   `reset-shared`.

`refresh-ttl` needs to know the full list of currently-open PR numbers to safely delete
orphaned branches (see "Why `open-pr-numbers-known` matters" below). The example computes
that list with `gh pr list` in its own job and passes it down.

#### Inputs

| Input | Type | Required | Meaning |
|---|---|---|---|
| `command` | string | yes | `ensure` \| `destroy` \| `refresh-ttl` \| `reset-shared` |
| `neon-project-id` | string | yes | Neon project ID that owns both the parent branch and every preview branch this workflow creates/deletes. |
| `parent-branch-id` | string | yes | Neon branch ID that new preview branches are forked FROM (`parent_id` on create, `source_branch_id` on `reset-shared`). Typically the production branch's ID. |
| `role-name` | string | yes | Existing Neon Postgres role used to build each forked branch's connection URI. Not created by this workflow. |
| `database-name` | string | yes | Existing Neon database used to build each forked branch's connection URI. Not created by this workflow. |
| `vercel-project-id` | string | yes | Vercel project ID that owns the preview deployments this workflow manages. |
| `vercel-team-id` | string | yes | Vercel team (organization) ID that owns the project above. |
| `branch-prefix` | string | yes | Namespace for this app's preview branches; branches are named `<branch-prefix>/pr-<number>`. Only branches under this prefix are ever deleted by cleanup. |
| `shared-branch-name` | string | yes | Long-lived fallback Neon branch that `reset-shared` resets from `parent-branch-id`. |
| `env-var-name` | string | yes | Vercel Preview env var key the connection URI is written to. Must match what your app's code actually reads. |
| `ttl-days` | number | yes | Days a preview branch may go unrefreshed before Neon auto-expires it. |
| `pr-number` | number | only for `ensure`/`destroy` | The pull request number. |
| `git-branch` | string | only for `ensure`/`destroy` | The PR's head ref, used to scope the Vercel env vars. |
| `open-pr-numbers` | string | only for `refresh-ttl` | Comma-separated open PR numbers; only read when `open-pr-numbers-known` is `true`. |
| `open-pr-numbers-known` | boolean | no (default `false`) | `true` if the caller successfully determined the open PR list (even if empty); `false` skips cleanup entirely. |
| `dry-run` | boolean | no (default `false`) | Logs the actions that would be taken without calling the Neon/Vercel APIs. |

```yaml
on:
  pull_request:
    types: [opened, reopened, synchronize, closed]
  schedule:
    - cron: "0 3 * * *" # refresh-ttl, daily
    - cron: "0 4 * * 1" # reset-shared, weekly (Monday)
  workflow_dispatch:

jobs:
  ensure:
    if: github.event_name == 'pull_request' && github.event.action != 'closed'
    uses: GuestGuru/gg-ci/.github/workflows/neon-preview.yml@main
    with:
      command: ensure
      pr-number: ${{ github.event.pull_request.number }}
      git-branch: ${{ github.event.pull_request.head.ref }}
      neon-project-id: your-neon-project-id
      parent-branch-id: your-neon-parent-branch-id
      role-name: your_neon_role
      database-name: your_database_name
      vercel-project-id: your-vercel-project-id
      vercel-team-id: your-vercel-team-id
      branch-prefix: myapp-preview
      shared-branch-name: preview-shared
      env-var-name: DATABASE_URL
      ttl-days: 3
    secrets:
      NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}

  destroy:
    if: github.event_name == 'pull_request' && github.event.action == 'closed'
    uses: GuestGuru/gg-ci/.github/workflows/neon-preview.yml@main
    with:
      command: destroy
      pr-number: ${{ github.event.pull_request.number }}
      git-branch: ${{ github.event.pull_request.head.ref }}
      neon-project-id: your-neon-project-id
      parent-branch-id: your-neon-parent-branch-id
      role-name: your_neon_role
      database-name: your_database_name
      vercel-project-id: your-vercel-project-id
      vercel-team-id: your-vercel-team-id
      branch-prefix: myapp-preview
      shared-branch-name: preview-shared
      env-var-name: DATABASE_URL
      ttl-days: 3
    secrets:
      NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}

  list-open-prs:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    permissions:
      pull-requests: read
    outputs:
      numbers: ${{ steps.list.outputs.numbers }}
      known: ${{ steps.list.outputs.known }}
    steps:
      - id: list
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          if numbers=$(gh pr list --repo "$GITHUB_REPOSITORY" --state open --json number --jq '[.[].number] | join(",")'); then
            echo "numbers=$numbers" >> "$GITHUB_OUTPUT"
            echo "known=true" >> "$GITHUB_OUTPUT"
          else
            echo "numbers=" >> "$GITHUB_OUTPUT"
            echo "known=false" >> "$GITHUB_OUTPUT"
          fi

  refresh-ttl:
    if: github.event_name == 'schedule' && github.event.schedule == '0 3 * * *'
    needs: list-open-prs
    uses: GuestGuru/gg-ci/.github/workflows/neon-preview.yml@main
    with:
      command: refresh-ttl
      open-pr-numbers: ${{ needs.list-open-prs.outputs.numbers }}
      open-pr-numbers-known: ${{ needs.list-open-prs.outputs.known == 'true' }}
      neon-project-id: your-neon-project-id
      parent-branch-id: your-neon-parent-branch-id
      role-name: your_neon_role
      database-name: your_database_name
      vercel-project-id: your-vercel-project-id
      vercel-team-id: your-vercel-team-id
      branch-prefix: myapp-preview
      shared-branch-name: preview-shared
      env-var-name: DATABASE_URL
      ttl-days: 3
    secrets:
      NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}

  reset-shared:
    if: github.event_name == 'schedule' && github.event.schedule == '0 4 * * 1'
    uses: GuestGuru/gg-ci/.github/workflows/neon-preview.yml@main
    with:
      command: reset-shared
      neon-project-id: your-neon-project-id
      parent-branch-id: your-neon-parent-branch-id
      role-name: your_neon_role
      database-name: your_database_name
      vercel-project-id: your-vercel-project-id
      vercel-team-id: your-vercel-team-id
      branch-prefix: myapp-preview
      shared-branch-name: preview-shared
      env-var-name: DATABASE_URL
      ttl-days: 3
    secrets:
      NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
```

#### Why `open-pr-numbers-known` matters

`refresh-ttl` deletes any Neon branch whose PR number isn't in the open-PR list — that's
how orphaned preview databases get cleaned up. An **empty** list and a **missing** list
mean opposite things: "I checked, and no PRs are open, delete everything" versus "I
couldn't check, don't delete anything." GitHub Actions can't tell those apart from the
string value alone (an unset input and an explicitly-empty string both render as `''`),
so the caller must say which case it's in via `open-pr-numbers-known`.

The `list-open-prs` job above sets `known=false` when the `gh pr list` step fails (network
blip, API rate limit, permissions issue). If that failure were instead reported as an
empty-but-known list, `refresh-ttl` would treat every currently-open pull request's
database as orphaned and delete it — taking down every live preview deploy at once. Set
`open-pr-numbers-known: true` **only** when the command that produced the list actually
succeeded.

### Notes

- Scheduled workflows always run from the **default branch**, so cron changes only take
  effect after merge. Use `workflow_dispatch` to test them.
- GitHub disables scheduled workflows after 60 days of repository inactivity.
- `refresh-ttl` **skips cleanup entirely** when `open-pr-numbers-known` is `false`. A
  failed `gh pr list` must never be read as "no PRs are open".
