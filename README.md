# gg-ci

Cross-app CI infrastructure for GuestGuru. **This repository is public** — it contains
generic glue code only. Never add infrastructure identifiers, tokens, or app-specific
default values here.

## Organization quality gate

`.github/workflows/quality-gate.yml` turns a caller workflow's required job results into
one stable final check. This lets an organization ruleset and deployment platform depend
on the same check name even when repositories have different test jobs.

Call it after every mandatory CI job:

```yaml
quality-gate:
  name: quality-gate
  if: ${{ always() }}
  needs: [lint, test]
  uses: GuestGuru/gg-ci/.github/workflows/quality-gate.yml@main
  with:
    needs-json: ${{ toJSON(needs) }}
```

`if: always()` is essential: without it GitHub skips the final job when a dependency
fails, leaving a required check pending instead of reporting a useful failure.
Every direct dependency must finish with `success`; `failure`, `cancelled`, `skipped`,
missing results, malformed JSON, and an empty dependency set all fail closed.

`.github/workflows/policy-gate.yml` is the matching organization-required workflow.
Because GitHub loads it from this repository rather than from the target pull request,
the pull request cannot replace the policy that checks it. The workflow runs
`src/workflow-policy.ts`, which verifies the exact canonical workflow path, mandatory
job IDs, `always()` condition, reusable-workflow reference, and `needs-json` input for
each protected repository. It also verifies a SHA-256 inventory of the complete
`.github/workflows` directory, so a pull request cannot weaken a mandatory job, add a
lookalike check, or silently change another delivery workflow. For `gg-ci` itself, the
policy also hashes the central evaluator and package files listed in
`src/trust-inventory.json`; the pinned policy independently hashes that manifest too.
Both policy evaluators run through a direct Node entry point with an empty
`NODE_OPTIONS`, while dependency installation disables lifecycle scripts. This keeps
target-repository npm configuration outside the trust path.

An intentional workflow change is a two-PR operation: first update and merge the
approved inventory here, then change the target repository to the pre-approved content.
This keeps the trusted policy update outside the target pull request.

The organization ruleset must pin this required workflow to an immutable commit `sha`,
never `refs/heads/main`. Updating the central policy is an explicit release operation:
pin the ruleset to the reviewed candidate SHA, verify it, merge it, then pin the ruleset
to the resulting main commit SHA.

Rollout order matters: merge `gg-ci`, switch every caller from its temporary test ref
to `@main`, verify all checks, and only then enable the organization ruleset workflow
and the required status check.

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
| `unpooled-env-var-name` | string | no | Second Preview env var key that receives the same branch's **unpooled** (direct) URI. Set it only if your app needs a direct connection; unset writes the pooled URI only. |
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
      # Optional — only if your app also needs a direct (unpooled) connection.
      # Must be repeated on the destroy job so the var gets cleaned up.
      unpooled-env-var-name: DATABASE_URL_UNPOOLED
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
      unpooled-env-var-name: DATABASE_URL_UNPOOLED # optional, see above
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

### Sharing a Neon project with the native integration

A Neon project can attach the native Neon–Vercel integration to exactly **one** Vercel
project. Everything else in that project uses this workflow — so both systems create
branches side by side, and cleanup must never touch the other's.

Two independent protections:

1. **Prefix.** Cleanup only ever considers branches matching `^<branch-prefix>/pr-<n>$`,
   with the prefix regex-escaped. Give each app its own prefix (`preview/gg-tracker`,
   `preview/bpdb`).
2. **`creation_source`.** The native integration names its branches after the *git
   branch* (`preview/<git-branch>`), so a sibling repo's branch called `<app>/pr-7`
   would produce a name indistinguishable from ours. Cleanup therefore also refuses to
   delete any branch Neon reports with `creation_source: 'vercel'`. This makes the
   separation a technical guarantee rather than a naming convention that a developer —
   or an agent creating a feature branch — could unknowingly violate.

### Vercel API gotchas (learned in production)

`POST /v13/deployments` (used to redeploy a preview so a brand-new PR's first
deployment picks up its freshly-created env vars):

- `name` — the **project name** — is required alongside `deploymentId`. Without it the
  API returns `400 Invalid request: missing required property \`name\``. It comes free
  in the `GET /v6/deployments` response, so no extra round-trip is needed.
- Do **not** send `target: 'preview'`. That field only accepts `production`, `staging`
  or a custom environment identifier; `preview` returns
  `400 Invalid request: \`target\` should be 'production', 'staging', or a custom
  environment identifier`. Omit it and the redeploy inherits the source deployment's
  preview target.

Both were found only by calling the real API — unit tests written against an assumed
contract happily passed while the live call failed.

### Pooled and unpooled connection strings

`ensure` always writes the **pooled** URI into `env-var-name`, plus the
`PREVIEW_DB_ISOLATED` flag.

Some libraries and migration tools cannot go through the connection pooler and need the
**unpooled/direct** URI instead. Set the optional `unpooled-env-var-name` input and
`ensure` requests the same branch's URI a second time with `pooled=false`, writing it into
that key on the same Preview + git-branch scope; `destroy` removes it along with the
others. Leave the input unset and nothing changes — only the pooled URI is written.

### Testing a change to these workflows

The reusable workflows check out the CLI at `job.workflow_sha` — the
commit the workflow YAML itself came from. Pointing a caller at a branch
(`neon-preview.yml@my-branch`) therefore runs that branch's CLI too, so a change
can be validated before it lands on `main`.

This was not always the case: the checkout was pinned to `ref: main`, which made
every test run execute main's code. An input added on a branch reached a CLI
that did not know it and dropped it silently — a green run that did nothing.
Found while onboarding `GuestGuru/tools`, 2026-07-19.

### Notes

- Scheduled workflows always run from the **default branch**, so cron changes only take
  effect after merge. Use `workflow_dispatch` to test them.
- GitHub disables scheduled workflows after 60 days of repository inactivity.
- `refresh-ttl` **skips cleanup entirely** when `open-pr-numbers-known` is `false`. A
  failed `gh pr list` must never be read as "no PRs are open".

## Preview domain aliases

Points each pull request's Vercel preview deployment at a hostname under your own
domain (`myapp-pr-12.preview.example.com`) instead of leaving it on the generated
`*.vercel.app` URL.

Needed because a **session cookie scoped to a domain** (`Domain=.example.com`, set by a
central auth service at `auth.example.com`) is simply not sent to `*.vercel.app` — a
different registrable domain. On the generated preview URL the app therefore looks
permanently logged out, and no amount of app-side configuration fixes it. Moving the
preview onto a subdomain of the cookie's domain makes the existing session reach it.

`alias-set` attaches the hostname to the Vercel project itself before aliasing it — a
per-PR host (`myapp-pr-12.preview.example.com`) does not exist until the PR does, so it
cannot be added by hand in advance.

Prerequisite: the **apex domain** (`example.com`) must be owned by the Vercel **team**
that owns the project, with DNS pointing at Vercel. Sub-domains of a team-owned apex come
back `verified: true` immediately, with no TXT challenge. If the apex sits in a personal
account instead, every added host stays unverified and will not serve traffic — move the
domain to the team first.

### Commands

| Command | When | What it does |
|---|---|---|
| `alias-set` | `deployment_status` = success | Points `alias-host` at the given deployment |
| `alias-remove` | PR closed / merged | Removes the alias **and** detaches `alias-host` from the project |

Both are idempotent and support `dry-run`. `alias-set` re-run against a newer deployment
moves the alias over — that is the normal path on every push. `alias-remove` succeeds when
the alias, the domain, or both are already gone.

The workflow deliberately **does not comment on the pull request**. gg-ci stays
independent of GitHub's PR model (the same reasoning behind `open-pr-numbers`); the
caller gets the finished URL as the `preview-url` output and decides what to do with it.

#### Inputs

| Input | Type | Required | Meaning |
|---|---|---|---|
| `command` | string | yes | `set` \| `remove` |
| `alias-host` | string | yes | Full hostname to assign, e.g. `myapp-pr-12.preview.example.com`. A bare hostname — passing a URL is rejected. |
| `deployment-id` | string | only for `set` | The Vercel deployment ID to alias. |
| `vercel-project-id` | string | yes | Vercel project ID that owns the deployment and the alias. |
| `vercel-team-id` | string | yes | Vercel team (organization) ID that owns the project above. |
| `dry-run` | boolean | no (default `false`) | Logs the action without calling the Vercel write APIs. |

#### Outputs

| Output | Meaning |
|---|---|
| `preview-url` | `https://<alias-host>`, set by `set`. |

#### Caller example

`deployment_status` fires once Vercel reports the preview as ready — aliasing earlier
fails, since a deployment that is not `READY` cannot be aliased.

```yaml
on:
  deployment_status:
  pull_request:
    types: [closed]

jobs:
  find-pr:
    if: github.event_name == 'deployment_status' && github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    permissions:
      pull-requests: read
    outputs:
      number: ${{ steps.pr.outputs.number }}
      deployment-id: ${{ steps.deployment.outputs.id }}
    steps:
      - id: pr
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          REF: ${{ github.event.deployment.ref }}
        run: |
          # Vercel puts a commit SHA in `deployment.ref`, not a branch name,
          # so resolve the PR through the commit. The branch-name lookup is a
          # fallback for integrations that do send a ref.
          number=$(gh api "repos/$GITHUB_REPOSITORY/commits/$REF/pulls" \
            --jq '[.[] | select(.state == "open")][0].number // ""' 2>/dev/null || echo "")
          if [[ -z "$number" ]]; then
            number=$(gh pr list --repo "$GITHUB_REPOSITORY" --head "$REF" --state open \
              --json number --jq '.[0].number // ""' 2>/dev/null || echo "")
          fi
          echo "number=$number" >> "$GITHUB_OUTPUT"

      # Vercel sends an EMPTY deployment payload, so there is no deploymentId
      # to read. The status's target_url carries the preview hostname, and the
      # Vercel API accepts a hostname wherever it accepts a deployment ID.
      - id: deployment
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
          TARGET_URL: ${{ github.event.deployment_status.target_url }}
          TEAM_ID: your-vercel-team-id
        run: |
          host="${TARGET_URL#https://}"
          host="${host%%/*}"
          id=$(curl -sf "https://api.vercel.com/v13/deployments/${host}?teamId=${TEAM_ID}" \
            -H "Authorization: Bearer $VERCEL_TOKEN" | jq -r '.id // ""')
          if [[ -z "$id" ]]; then
            echo "Could not resolve a deployment ID from: $host"
            exit 1
          fi
          echo "id=$id" >> "$GITHUB_OUTPUT"

  alias:
    needs: find-pr
    if: needs.find-pr.outputs.number != ''
    uses: GuestGuru/gg-ci/.github/workflows/preview-alias.yml@main
    with:
      command: set
      deployment-id: ${{ needs.find-pr.outputs.deployment-id }}
      alias-host: myapp-pr-${{ needs.find-pr.outputs.number }}.preview.example.com
      vercel-project-id: your-vercel-project-id
      vercel-team-id: your-vercel-team-id
    secrets:
      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}

  unalias:
    if: github.event_name == 'pull_request'
    uses: GuestGuru/gg-ci/.github/workflows/preview-alias.yml@main
    with:
      command: remove
      alias-host: myapp-pr-${{ github.event.pull_request.number }}.preview.example.com
      vercel-project-id: your-vercel-project-id
      vercel-team-id: your-vercel-team-id
    secrets:
      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
```

To comment the URL on the PR, add a job that consumes `needs.alias.outputs.preview-url`
in your own repository — that keeps the GitHub-specific part on your side.

#### What the Vercel deployment event actually contains

Both facts below were measured against a live Vercel–GitHub integration
(2026-07-19) and contradict the obvious reading of GitHub's `deployment_status`
schema. The caller example above already accounts for them.

- **`deployment.ref` is a commit SHA, not a branch name.** `gh pr list --head "$REF"`
  therefore matches nothing and the alias job is skipped — silently, since "no PR
  found" is a legitimate outcome for a non-PR deployment. Resolve the PR through
  `repos/{owner}/{repo}/commits/{sha}/pulls` instead.
- **`deployment.payload` is an empty object (`{}`).** There is no `deploymentId`
  in it, so passing `deployment.payload.deploymentId` sends an empty string and
  `alias-set` fails with `Missing required argument: --deployment-id`. The
  deployment is instead identified by the hostname in
  `deployment_status.target_url`: `GET /v13/deployments/{hostname}` returns the
  real `dpl_...` ID.

#### Vercel alias API notes

- **An attached domain falls back to production on its own, so cleanup must remove the
  domain too.** A domain attached to a project with no git-branch binding is served by the
  latest **production** deployment whenever nothing else claims it. Deleting only the alias
  is therefore temporary: Vercel re-creates it against production within moments, and the
  closed PR's link answers **200 with the live site**. That is worse than a 404 — the link
  looks like it still shows the PR, silently and with no error. `alias-remove` deletes the
  alias **and then** `DELETE /v9/projects/{id}/domains/{host}`; doing it in the other order
  leaves a window for the alias to come back. Observed on a real PR close, 2026-07-19.
- **`cert_missing` is transient, and the name is misleading.** On a brand-new hostname the
  measured sequence is: `POST /v10/projects/{id}/domains` returns `verified: true`
  immediately → `POST /v2/deployments/{id}/aliases` fails with
  `{"error":{"code":"cert_missing"}}` → ~12 seconds later the host answers 200 over HTTPS
  → the identical alias call succeeds. It does not mean "this will never work"; it means
  "the TLS certificate is still being issued". `alias-set` therefore retries **only** this
  code, every 5 s up to 15 attempts (~70 s), and fails immediately on every other code.
  Without the retry the *first* alias of every pull request would fail — the one case that
  always happens.
- **Adding the domain is idempotent, but the status code cannot be what decides that.**
  A domain already on *this* project fails with **400**, whereas **409** means it belongs
  to *another* Vercel project. Accepting 409 as "already there" would silently alias into
  a domain someone else owns. `addProjectDomain` therefore resolves a failed add by asking
  `GET /v9/projects/{id}/domains/{host}` whether the domain is on this project: if yes the
  add was a no-op, if no the original error is rethrown.
- `POST /v2/deployments/{id}/aliases` answers **409** when the alias already points at
  *that same* deployment. It is the success case for a re-run, not a failure, so the CLI
  treats it as such. An alias held by a *different* deployment is moved over with a 200 —
  no delete-then-create dance is needed.
- Aliases are resolved by name through `GET /v4/aliases?projectId=…`, not
  `GET /v9/projects/{id}/domains`: only the alias list returns the alias `uid` that
  `DELETE /v2/aliases/{id}` needs. The list is paginated (`pagination.next` is a timestamp
  fed back as `until`), and a busy project accumulates one alias per deployment, so the
  client follows the cursor instead of reading only the first page.
- `DELETE /v2/aliases/{id}` returns 404 for an unknown alias, which the CLI treats as the
  desired end state.
