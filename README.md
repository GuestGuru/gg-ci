# gg-ci

Cross-app CI infrastructure for GuestGuru. **This repository is public** — it contains
generic glue code only. Never add infrastructure identifiers, tokens, or app-specific
default values here.

## Organization quality gate

`.github/workflows/quality-gate.yml` turns a caller workflow's required job results into
one stable final result, and publishes that same result twice: as the
`quality-gate / verify` Check Run the organization ruleset requires, and as the
`GG deployment gate` commit status Vercel consumes. Vercel must consume the commit
status rather than the job's Check Run because GitHub Check Run synchronization can
race with Vercel Deployment Checks.

**One call, not two.** A separate `deployment-gate` job used to run the identical
evaluation on a second VM; because GitHub rounds every job up to a billed minute,
that was one wasted minute per run. The policy now *requires* the single-call shape
and rejects a leftover `deployment-gate` job.

Call the gate once, after every mandatory CI job:

```yaml
permissions:
  contents: read
  statuses: write

quality-gate:
  name: quality-gate
  if: ${{ always() }}
  needs: [lint, test]
  uses: GuestGuru/gg-ci/.github/workflows/quality-gate.yml@main
  with:
    needs-json: ${{ toJSON(needs) }}
    status-context: GG deployment gate
```

`if: always()` is essential: without it GitHub skips the final job when a dependency
fails, leaving a required check pending instead of reporting a useful failure.
Every direct dependency must finish with `success`; `failure`, `cancelled`, `skipped`,
missing results, malformed JSON, and an empty dependency set all fail closed.

`.github/workflows/policy-gate.yml` is the matching organization-required workflow.
Because GitHub loads it from this repository rather than from the target pull request,
the pull request cannot replace the policy that checks it. The workflow runs
`src/workflow-policy.ts`, which verifies the exact canonical workflow path, mandatory
job IDs, distinct gate names, `always()` condition, reusable-workflow reference, and
`needs-json` input for each protected repository. It also verifies a SHA-256 inventory of the complete
`.github/workflows` directory, so a pull request cannot weaken a mandatory job, add a
lookalike check, or silently change another delivery workflow. For `gg-ci` itself, the
policy also verifies its own trusted sources — the central evaluator and package files
listed in `src/trust-inventory.json`. That check is deliberately **self-consistent**: the
target's central files are compared against the target's own manifest, not against hashes
frozen into the trusted evaluator. Comparing to frozen hashes would deadlock every update
to the trusted sources — including this policy file — because the evaluator runs from
`main`, so no pull request could ever match `main`'s frozen hash. The self-consistent check
still guarantees that (1) every path the baseline pins stays declared in the manifest (a
trusted file cannot be silently dropped) and (2) every declared file matches its declared
hash, so a changed central file is only accepted when the same PR updates its hash in the
manifest — visible in the diff. Whether such a change is *authorized* is governed by review
of the `gg-ci` PR, not by the hash comparison.
Both policy evaluators run through a direct Node entry point with an empty
`NODE_OPTIONS`, while dependency installation disables lifecycle scripts. This keeps
target-repository npm configuration outside the trust path.

An intentional workflow change is a two-PR operation: first update and merge the
approved inventory here, then change the target repository to the pre-approved content.
This keeps the trusted policy update outside the target pull request.

### Which runner these workflows use

Every job in this repository's reusable workflows — and in the ruleset-injected
`policy-gate.yml` — picks its runner the same way:

```yaml
runs-on: ${{ (github.event_name != 'schedule' && vars.GG_CI_RUNNER) || 'ubuntu-latest' }}
```

`vars` resolves against the **caller's** repository and organization (for
`policy-gate.yml`, against the target repository), so the choice is made entirely
here: a caller passes nothing, and no caller workflow needs to change when the
runner changes. The rules that follow from the expression:

| situation | runner |
|---|---|
| `GG_CI_RUNNER` is not shared with the repository — including every public repository, this one among them | `ubuntu-latest` |
| `GG_CI_RUNNER` is shared with the repository | that label |
| the caller's triggering event is `schedule` | `ubuntu-latest`, always |

Three things this shape buys, each of them deliberate:

* **Public repositories stay on GitHub-hosted runners.** Self-hosted runners are a
  security hazard on public repositories, and their minutes are free anyway. Share
  the variable with private repositories only (visibility `selected`), and keep that
  list in step with the runner group that owns the label — a repository that reads a
  label it may not use queues forever.
* **Scheduled work stays on GitHub-hosted runners.** A self-hosted runner may be
  asleep at cron time. Putting the exclusion here rather than in each caller means a
  future cron caller cannot get it wrong.
* **One-step emergency brake.** Deleting the organization variable moves every
  caller back to `ubuntu-latest` immediately — no workflow change, no policy
  inventory update, no ruleset re-pin:

  ```bash
  gh variable delete GG_CI_RUNNER --org <org>
  ```

This repository's own `.github/workflows/ci.yml` is pinned to `ubuntu-latest` on
purpose, for the same reason as the first row of the table.

#### No dependency cache on self-hosted runners

Because the same job may land on either runner kind, every `actions/setup-node`
step here enables the GitHub dependency cache only on GitHub-hosted runners:

```yaml
cache: ${{ runner.environment == 'github-hosted' && 'npm' || '' }}
package-manager-cache: false
```

A persistent self-hosted runner keeps its package-manager cache (`~/.npm`, the pnpm
store) from job to job, so restoring the GitHub cache there only re-downloads what is
already on disk. It is also far larger than on a fresh runner: every repository
installs into the same `~/.npm`, so each saved entry carries all of their packages.
Measured on arm64 self-hosted runners: a 1.07 GB restore at ~16 MB/s, 50–100 s of
every job, 70–80% of total job time. `package-manager-cache: false` stops
setup-node v5 from switching caching back on by itself when the workspace's
`package.json` has a `packageManager` field. A caller's own jobs that always run on
self-hosted runners should leave `cache:` out for the same reason.

The policy gate enforces this (IT-974): in every workflow file of the inventory, a
job whose `runs-on` names `gg-runner` or `GG_CI_RUNNER` may not give
`actions/setup-node` a `cache:` input other than the conditional expression above,
and — when the repository's root `package.json` declares a `packageManager` (or
`devEngines.packageManager`), which is exactly when setup-node v5 would switch the
cache back on — must give it `package-manager-cache: false`. The error names the
file, the job, the step and the fix.

#### pnpm installs into `runner.temp` on self-hosted runners

`pnpm/action-setup` installs pnpm into its `dest` input, `~/setup-pnpm` by default,
and on every run it first deletes that directory and reinstalls. Several
self-hosted runner instances under one user share a `HOME`, so two jobs starting
together delete each other's pnpm mid-job (`ENOTEMPTY … rmdir '~/setup-pnpm/node_modules'`,
or a pnpm worker exiting during `pnpm install`). A caller's pnpm step on a
self-hosted runner therefore sets a per-instance, per-job directory:

```yaml
- uses: pnpm/action-setup@<sha>
  with:
    dest: ${{ runner.temp }}/setup-pnpm
```

It costs nothing: the action reinstalls on every run anyway (measured 0–1 s).

The policy gate enforces this too (IT-974): a `pnpm/action-setup` step in a job
whose `runs-on` names `gg-runner` or `GG_CI_RUNNER` must set exactly that `dest`,
in every workflow file of the inventory.

### Releasing a policy change

The organization ruleset must pin this required workflow to an immutable commit `sha`,
never `refs/heads/main`. The pin freezes the entire trusted checkout — the policy code
**and** the approved inventory it evaluates against — so approving new content is a
three-step release operation:

1. **Merge the `gg-ci` pull request** that approves it: the new hash in
   `approvedWorkflowInventories`, plus `src/trust-inventory.json` whenever a central file
   changed. Hashes are byte-exact (`shasum -a 256 <file>`).
2. **Re-pin the ruleset** to the resulting `main` SHA (`PUT /orgs/{org}/rulesets/{id}`,
   organization admin). Not optional: until this happens every target repository still
   evaluates the *previous* policy. It also invalidates the policy check of every open
   pull request in the covered repositories, so re-run step 3 on each of them.
3. **Close/reopen the target pull request** so the policy runs again under the fresh pin.
   A plain re-run does not help — `ref: ${{ job.workflow_sha }}` inherits the old pin.

Steps 2 and 3 are one command in `GuestGuru/tools` (`packages/delivery-doctor`):
`pnpm chain release --dry-run`, then `pnpm chain release` — it re-pins only when
`src/`, `.github/workflows/` or a root `package*.json` changed since the current pin,
then closes/reopens every open pull request in the ruleset's repositories and prints a
summary table.

Changing `gg-ci`'s own `.github/workflows/` files needs one extra turn of the same crank,
since the trusted checkout also carries the inventory that approves them: pin the ruleset
to the reviewed candidate SHA, verify, merge, then pin to the resulting main SHA.

**A skipped step 2 fails misleadingly.** The target repository reports
`Workflow content is not approved: <path>` for content that *is* approved, in a repository
whose pull request never touched that file. Every policy run therefore names the commit it
ran from, and on failure compares it with `main` — so the output itself separates a stale
pin from a real violation:

```
workflow-policy: Workflow content is not approved: .github/workflows/preview-db.yml
workflow-policy: Policy source: GuestGuru/gg-ci@eda86e0… — the commit the organization ruleset pins .github/workflows/policy-gate.yml to.
workflow-policy: GuestGuru/gg-ci main is at 1690247…, which is NOT the pinned commit — this run evaluated an older policy than main's.
workflow-policy: If the content above was approved in a GuestGuru/gg-ci pull request that has since merged, that is the cause: re-pin …
```

The pinned commit comes from the trusted checkout's own `HEAD` (`GITHUB_WORKFLOW_SHA` as a
fallback), and `main` from `git ls-remote` — no token, because this repository is public.
When the pin already matches `main`, the run says so instead, ruling the stale pin out.

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

`alias-set` points the host at the deployment as a **plain deployment alias — it never
attaches the host to the project as a project domain** (IT-1046, see "Vercel alias API
notes"). A project domain without a git-branch binding is a *production* domain that
every production deployment takes over; one bound to the PR's branch is a *preview*
domain behind Deployment Protection. A plain alias is neither: production deployments
leave it alone. Because a plain alias to a preview deployment *is* protected, `alias-set`
also makes it a **Deployment Protection Exception** (`alias-protection-override`) when
the project's protection scope is narrower than `all` — so the host is exactly as
reachable as it was when it was a project domain, and the smoke needs no bypass secret;
the deployment's own `*.vercel.app` URLs stay protected.

Before writing anything `alias-set` refuses: a host that is not a PR host (first label
`<app>-pr-<number>`), a deployment of another project, a **production** deployment, and a
host whose existing alias belongs to another project. A host still attached as a project
domain from before IT-1046 is detached first, then re-created as a plain alias.

The reusable workflow that runs this end to end is
**`.github/workflows/preview.yml`** — it resolves the pull request and the Vercel
deployment, decides whether the deployment is already superseded, attaches the alias,
and posts the PR comment. Callers pass their own identifiers and nothing else.

Prerequisite: the **apex domain** (`example.com`) must be owned by the Vercel **team**
that owns the project, with DNS pointing at Vercel. Sub-domains of a team-owned apex come
back `verified: true` immediately, with no TXT challenge. If the apex sits in a personal
account instead, every added host stays unverified and will not serve traffic — move the
domain to the team first.

### Commands

| Command | When | What it does |
|---|---|---|
| `alias-set` | `deployment_status` = success | Points `alias-host` at the given preview deployment as a plain alias, with a Deployment Protection Exception |
| `alias-remove` | PR closed / merged | Removes the alias, and detaches `alias-host` from the project if a pre-IT-1046 host is still attached |

Both are idempotent and support `dry-run`. `alias-set` re-run against a newer deployment
moves the alias over — that is the normal path on every push. `alias-remove` succeeds when
the alias, the domain, or both are already gone.

The **CLI** stays independent of GitHub's PR model — it knows about Vercel deployments
and hostnames, nothing else (the same reasoning behind `open-pr-numbers`). The
**workflow** is bound to that model anyway, since `deployment_status` and
`pull_request` are what trigger it, so it does post the PR comment; `comment: false`
opts out and the caller uses the `preview-url` output instead.

#### Inputs

| Input | Type | Required | Meaning |
|---|---|---|---|
| `alias-host-pattern` | string | yes | Alias hostname with a `{pr}` placeholder, e.g. `myapp-pr-{pr}.preview.example.com`. A bare hostname — passing a URL is rejected. |
| `vercel-project-id` | string | yes | Vercel project ID that owns the deployment and the alias. |
| `vercel-team-id` | string | yes | Vercel team (organization) ID that owns the project above. |
| `comment` | boolean | no (default `true`) | Post — and keep updating — a single PR comment with the preview link. |
| `comment-note` | string | no | Extra sentence shown under the link in that comment. |
| `dry-run` | boolean | no (default `false`) | Logs the actions without calling the Vercel write APIs. |
| `preview-db` | boolean | no (default `false`) | Set it when the app's previews run on a per-PR database from `neon-preview.yml`. A deployment built **before** that database existed — no `PREVIEW_DB_ISOLATED` in its environment — is reported as `stale`: `ensure` redeploys it, and the redeploy's own run covers the commit (IT-913, below). |

`VERCEL_TOKEN` is a required secret.

#### Outputs

| Output | Meaning |
|---|---|
| `preview-url` | `https://<alias-host>`, set once the alias is attached. Empty on a stale run, which deliberately does not touch the alias. |
| `pr-number` | Pull request number the deployment belongs to, or empty. Resolved from the deployment's metadata, and — when the PR was opened after the push that built the deployment — from GitHub's `commits/{sha}/pulls`, polled for up to two minutes (IT-983, below). |
| `deployment-id` | Vercel deployment ID, or empty when the run was skipped. |
| `stale` | `true` when a newer preview deployment already exists for the same git ref. A caller's smoke job should skip on this — the newer deployment's run covers it. TWO checks feed it: a cheap one before checkout, and a second one immediately before the alias write, which catches a deployment that became newer in between (IT-810). |

#### Caller example

The whole caller is identifiers. `deployment_status` fires once Vercel reports the
preview as ready — aliasing earlier fails, since a deployment that is not `READY`
cannot be aliased — and `pull_request: closed` drives the cleanup.

```yaml
name: Preview alias

on:
  deployment_status:
  pull_request:
    types: [closed]

jobs:
  preview:
    uses: GuestGuru/gg-ci/.github/workflows/preview.yml@main
    permissions:
      contents: read
      pull-requests: write
    with:
      alias-host-pattern: myapp-pr-{pr}.preview.example.com
      vercel-project-id: your-vercel-project-id
      vercel-team-id: your-vercel-team-id
    secrets:
      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
```

⚠️ A smoke job in the caller must gate on the PR number **and** on `stale` — see the
`GG smoke gate` pattern in the delivery standard — otherwise a superseded deployment
can publish a green status for code that is no longer current.

Do **not** additionally gate on `preview-url` being non-empty. That would also swallow
the real failure — an alias that never got attached — and the smoke job's whole job is
to catch exactly that. Gating on `stale` is enough: a run that deliberately leaves the
alias alone always reports `stale=true`, both from the early check and from the late one
(this was the IT-810 bug: the late branch stayed silent, so callers smoke-tested an empty
URL and wrote a red status onto a healthy commit).

⚠️ **A stale run does not attach the alias** (since 2026-09-11, IT-780). It used to,
on the reasoning that the newer deployment's run would overwrite it anyway. That
holds only while runs FINISH in the order they start — and on self-hosted runners
they queue. Measured on `GuestGuru/tools#141`: the newer run aliased at 09:51:24 and
an older one overwrote it **eight seconds later**, pinning the pull request to a
deployment whose preview database had already been destroyed. The smoke test then
reported `HTTP 500` as if the application were broken — a failure that points away
from its own cause.

The alias step also re-measures recency immediately before writing, because the
`stale` decision is taken ~40 seconds earlier (before checkout and `npm ci`), and
longer still when the runner queues.

⚠️ **A run for a closed pull request does not attach the alias either** (since IT-975).
The same queue reorders a `deployment_status` run against the `unalias` run of the
PR's close: a run that started before the close and reached the alias step after it
re-attached the host, and from then on the closed PR's link showed a live preview, the
host stayed on the Vercel project and its certificate kept renewing (IT-969).
Measured on `GuestGuru/gg-sales#54` (unalias at 14:09:59, aliased at 14:10:19) and
`#43` (unalias at 17:16:52, aliased at 17:17:13 from a run started at 17:15:09), both
2026-09-23. Recency cannot catch it — the deployment is still the newest for its ref —
so the alias step now reads the PR's state (`GET /repos/{owner}/{repo}/pulls/{n}`,
with the caller's `github.token`) immediately before writing: `closed` means no alias
and `stale=true`, so the caller's smoke skips as on a superseded deployment. An
unreadable state counts as open, like every undecidable case here. The window is
narrowed to one API call, not closed; the daily `preview-hosztok` measurement in
`tools/packages/delivery-doctor` (IT-970) reports what slips through.

⚠️ **With a per-PR database, pass `preview-db: true`** (since IT-913). The first
deployment of a new pull request is built by the push — before the PR is opened, and
minutes before `neon-preview ensure` has created the branch and written the
branch-scoped env vars. That build sees no `PREVIEW_DB_ISOLATED`, runs on the shared
fallback database without the PR's migrations, and `ensure` then requests a redeploy.
Recency cannot catch it: when the push-built deployment's run decides, the redeploy
does not exist yet. Measured on `GuestGuru/ainita#29` (2026-09-18): the push-built
deployment was READY at 15:08:45, its smoke ran 15:11:40–15:12:57 against a page
answering HTTP 500, `ensure` created the database at 15:12:12 and the redeploy at
15:12:20 — whose own run went green. The same shape on `ainita#42` (three deployments
in a row, the `opened` event never ran `ensure`), `gg-ops#17` and `BPDBv2#135`.

The evidence is in the deployment itself: `GET /v13/deployments/{hostname}` — the
call `preview.yml` already makes — returns `env`, the list of env var **names** the
build saw (measured 2026-09-23 on eleven deployments across five projects: the flag is
absent from every push-built one and present on every redeploy). With `preview-db:
true`, a deployment without the flag is reported as `stale`, so the caller's smoke
skips and the alias is left alone; the redeploy's run does the work. It is opt-in
because an app without a per-PR database never has the flag, and would skip its smoke
forever. An unknown state (no `env` list in the response) is treated as not stale,
like every other undecidable case here.

#### What the Vercel deployment event actually contains

Both facts below were measured against a live Vercel–GitHub integration
(2026-07-19) and contradict the obvious reading of GitHub's `deployment_status`
schema. `preview.yml` already accounts for both — which is why the caller above passes
no deployment id and no PR number. They are recorded here because anything that reads
these events directly will hit them again.

- **`deployment.ref` is a commit SHA, not a branch name.** `gh pr list --head "$REF"`
  therefore matches nothing and the alias job is skipped — silently, since "no PR
  found" is a legitimate outcome for a non-PR deployment. `preview.yml` does not
  resolve the PR from the git ref at all: it reads `meta.githubPrId` out of the same
  `GET /v13/deployments/{hostname}` response it already needs for the deployment id —
  measured 2026-07-25 on 18 preview deployments across six projects, present on every
  one — every one of which had its PR open before the push. It is written at
  deployment creation, so a PR opened after the push is missing from it at the time
  the `deployment_status` run looks (measured 2026-09-23; Vercel does backfill it
  later, when the PR opens). Since IT-983 the workflow falls back to the GitHub-side
  lookup (`repos/{owner}/{repo}/commits/{sha}/pulls`, with `deployment.sha`) for up
  to two minutes — see "What the smoke gate guarantees when the PR is opened late".
- **`deployment.payload` is an empty object (`{}`).** There is no `deploymentId`
  in it, so passing `deployment.payload.deploymentId` sends an empty string and
  `alias-set` fails with `Missing required argument: --deployment-id`. The
  deployment is instead identified by the hostname in
  `deployment_status.target_url`: `GET /v13/deployments/{hostname}` returns the
  real `dpl_...` ID.

#### What the smoke gate guarantees when the PR is opened late (IT-983)

`deployment_status` fires when the deployment is READY — typically 30–60 seconds after
the push — and the pull request is often opened after that push. Vercel writes
`meta.githubPrId` when it creates the deployment, so a PR opened later is not in it,
and until IT-983 the run said "does not belong to a pull request" and stopped. On an
app **without** a per-PR database nothing runs again for that commit: no alias, no
smoke job, no `GG smoke gate` status — every other check green and the merge BLOCKED,
with nothing pointing at the cause. Measured on `GuestGuru/gg-design#119` (2026-09-23):
READY at 15:59:22, PR opened at 16:18:16, the only run for that commit skipped at
16:04:39.

How often it happens (measured 2026-09-23, the last 100 preview deployments of ten
projects, 381 branches): in 209 the PR was opened **after** its first deployment was
created (p50 20 s, p90 46 s after), and in 61 after that deployment was READY — 58 of
those within 60 s, then nothing until 192 s, and single cases at 310 s and 19 min. (A
107-minute case in the first count was an artifact of branch-name reuse: eleven
`gg-design` PRs shared one branch, and that PR's own head was READY 32 s *after* it
opened — re-measured 2026-09-23, IT-985.)

What `preview.yml` now guarantees:

- If the PR exists when the job starts, or opens within **two minutes** after it, the
  PR is resolved and the caller's smoke job runs. When `meta.githubPrId` is empty, the
  run asks GitHub (`repos/{owner}/{repo}/commits/{sha}/pulls`, the deployment's own
  commit, open PRs only) twelve times, ten seconds apart. That covers the measured
  cluster with 2x headroom; it costs at most two minutes of runner time, and only on
  deployments that have no PR yet. The self-hosted runner queue alone is p50 87 s and
  p90 15 min on these runs (300 runs measured), so in practice the window from READY is
  wider than two minutes. Vercel also backfills `githubPrId` onto existing deployments
  when the PR opens (measured on all 209) — but that is undocumented, so GitHub is asked.
- With a per-PR database (`neon-preview.yml`), a PR opened even later still gets its
  smoke: `ensure` runs on `opened`, redeploys, and the redeploy's `deployment_status`
  run finds the PR. Pass `preview-db: true` (IT-913) so the push-built deployment's
  run is reported `stale` instead of measuring the wrong instance.
- **Without** a per-PR database (today: `gg-design`), a PR opened more than two minutes
  after READY still gets no run for that commit. The remedy is a fresh deployment:
  push a real change, or an empty commit — an empty commit does start a Vercel
  deployment and therefore a `deployment_status` run, even though it starts no
  `pull_request` workflow. Do not reach for it before checking the run: a missing
  status is far more often the runner queue (see the numbers above) than this case —
  the job log says `does not belong to a pull request` when it is this case.
  How rare it is there: of the 76 `gg-design` PRs opened 2026-08-24 – 09-23, exactly
  one (#119, 19 min) opened more than two minutes after its head's READY; every other
  one opened before READY or within 42 s of it (re-measured 2026-09-23, IT-985).

**Why there is no automatic re-trigger (IT-985).** Two designs were weighed and
rejected at one case a month:

- *Re-post a `success` deployment status on `pull_request: opened`, so the existing
  `deployment_status` chain runs again.* It cannot work with the workflow's own token:
  events caused by `GITHUB_TOKEN` start no workflow runs, except `workflow_dispatch`
  and `repository_dispatch` (GitHub docs, "GITHUB_TOKEN"). The status would appear on
  the deployment and nothing would run. It would take a GitHub App token or a PAT in
  every caller — a new long-lived secret for a monthly edge case.
- *Resolve, alias and output from a `pull_request` branch of this workflow.* That
  event has no `deployment_status.target_url` and its `github.sha` is the merge commit,
  so the caller's smoke job would need a different target SHA and URL source on that
  path — a caller change on top of the trigger change, and two code paths to keep
  equivalent.

A Vercel-side redeploy on `opened` (what `neon-preview ensure` does on the database
apps) would work, since Vercel's own `deployment_status` does start runs — but it
still costs a caller trigger change, a pin cycle and a build per PR, for the same one
case a month. The documented remedy above stays the answer; revisit if the
frequency changes, or if a second app without a per-PR database joins.

The token for the GitHub lookup is the caller's `github.token`; the `pull-requests:
write` the caller example already grants for the comment covers it.

#### Vercel alias API notes

- **A PR host must not be a project domain at all — neither unbound nor branch-bound.**
  Measured 2026-09-25 (IT-1046) on production and on a scratch project with the team's
  default `all_except_custom_domains` protection:
  - an **unbound** project domain is a production domain: an open PR's `…-pr-157…` host
    sat in the `alias` list of the two production deployments built that morning
    (`aliasAssignedAt` 1 s after `ready`), and on the scratch project it moved to the next
    production deployment within seconds — the PR link served the live site and the
    production database while still looking like the PR. Even `POST /v10/projects/{id}/domains`
    itself answers with `oldDeploymentId` = the production deployment;
  - a **branch-bound** project domain (`gitBranch`, gg-ci#93) is a preview domain: Deployment
    Protection covers it, and every PR smoke got 302/401 (`vercel_auth_callback`) until
    gg-ci#94 reverted it;
  - a **plain alias** (`POST /v2/deployments/{id}/aliases` on a host of a team-owned zone,
    with no project domain) works on the first call, stays on its preview deployment
    across a production deployment, and does not come back after `DELETE /v2/aliases/{uid}`.
    It answers 302 (protected) until `PATCH /aliases/{uid}/protection-bypass` with
    `{"override":{"scope":"alias-protection-override","action":"create"}}` makes it a
    Deployment Protection Exception; then 200, while the deployment's `*.vercel.app` URL
    still answers 302. The exception belongs to the alias: moving the alias to a newer
    deployment keeps it (the `uid` is stable), deleting the alias drops it. Creating it
    twice answers **400 `exception_already_exists`**, which `alias-set` treats as success.
  - Detaching a project domain also deletes its alias (the host answers 404 at once) — the
    migration path `alias-set` takes for a host attached before IT-1046.
- **An attached domain falls back to production on its own, so cleanup must remove the
  domain too** (hosts attached before IT-1046; `alias-set` no longer attaches any). A domain attached to a project with no git-branch binding is served by the
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
  always happens **unless the alias zone has a wildcard certificate** (next point).
- **A wildcard certificate on the alias zone removes the wait altogether — and is the
  sustainable setup.** Measured 2026-09-23: with a per-host certificate the first alias of a
  PR waited ~18 s in the retry loop (three 5 s rounds) while holding the runner. Once the
  team held a Vercel-issued `*.preview.example.com` certificate, a brand-new host was
  aliased on the first call (the whole `alias-set` took 3.2 s including `npm` start-up), no
  per-host certificate was issued, and existing hosts switched to the wildcard too. Two
  constraints decide whether you can have one:
  - Vercel issues (and renews) a wildcard only via DNS-01, so **the zone must be served by
    Vercel's nameservers** — otherwise `POST /v3/now/certs` answers
    `dns_pretest_cns_not_using_vercel_ns_error`. The apex does not have to move: delegating
    just the preview sub-zone (`preview NS ns1.vercel-dns.com / ns2.vercel-dns.com` at the
    apex's DNS provider) is enough, provided the apex domain belongs to the same Vercel
    team (its Vercel-side zone then answers for the delegated names).
  - Without it, every PR host costs one certificate, and they count against Let's
    Encrypt's **50 certificates per registered domain per week**. That quota is shared with
    the apex's *production* hosts, and a busy set of repos exhausts it — measured
    2026-09-23: `too many certificates (50) already issued … in the last 168h`, after which
    Vercel silently fell back to another CA for the previews.
- **The per-host certificates left behind cannot be deleted — and do not need to be.**
  `DELETE /v8/certs/{id}` (and `/v7`) on a Vercel-issued certificate answers **400
  `cert_deletion_denied`** ("SSL Certificates provided by the system cannot be deleted");
  only uploaded certificates are deletable. They are also harmless: Vercel renews only the
  certificates of hosts that are **still attached to a project**. Measured 2026-09-23: of 62
  per-PR certificates inside the renewal window, none was renewed — every one of their hosts
  had been detached by `alias-remove` — while the production certificates expiring on the
  same days had been renewed 25–29 days early. The leftovers simply expire. What keeps the
  quota safe is therefore `alias-remove` detaching the host; a host left attached after its
  PR closed keeps renewing its own certificate. A host that has both a per-host and the
  wildcard certificate may be served either one by the edge; both are valid.
- **A host held by another project must be refused before aliasing** (before IT-1046 the
  project-domain add did this: its **409** meant "another project"). `alias-set` reads the
  alias team-wide with `GET /v4/aliases/{host}` (404 = no alias yet) and refuses when its
  `projectId` is not the caller's.
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
