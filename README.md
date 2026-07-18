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
3. **GitHub:** add repository secrets `NEON_API_KEY` and `VERCEL_TOKEN`.
4. **Build step:** make your build run migrations in preview only when
   `PREVIEW_DB_ISOLATED === '1'`. Without this guard a half-finished migration from any
   branch would poison the shared branch for every other preview.
5. **Caller workflow:** copy the example below into `.github/workflows/preview-db.yml`
   and fill in your identifiers.

```yaml
on:
  pull_request:
    types: [opened, reopened, synchronize, closed]
  schedule:
    - cron: "0 3 * * *"
    - cron: "0 4 * * 1"
  workflow_dispatch:

jobs:
  ensure:
    if: github.event_name == 'pull_request' && github.event.action != 'closed'
    uses: GuestGuru/gg-ci/.github/workflows/neon-preview.yml@main
    with:
      command: ensure
      pr-number: ${{ github.event.pull_request.number }}
      git-branch: ${{ github.event.pull_request.head.ref }}
      # ... your identifiers
    secrets:
      NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
```

### Notes

- Scheduled workflows always run from the **default branch**, so cron changes only take
  effect after merge. Use `workflow_dispatch` to test them.
- GitHub disables scheduled workflows after 60 days of repository inactivity.
- `refresh-ttl` **skips cleanup entirely** when no open-PR list is supplied. A failed
  `gh pr list` returning empty must never be read as "no PRs are open".
