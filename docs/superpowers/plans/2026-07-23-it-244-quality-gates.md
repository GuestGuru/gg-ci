# IT-244 Quality Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every scoped repository emits one stable quality-gate check, and GitHub plus Vercel can use that check as a fail-closed delivery policy.

**Architecture:** Repository-specific CI jobs stay where they are. A small tested CLI and reusable workflow in `GuestGuru/gg-ci` aggregate their results into one shared check; caller workflows only declare their mandatory job IDs. A centrally sourced organization-required workflow validates those declarations outside the target PR's control. CODEOWNERS records ownership, while an organization ruleset and Vercel production Deployment Checks enforce the resulting policy.

**Tech Stack:** GitHub Actions reusable workflows, TypeScript, Vitest, GitHub REST API, Vercel Deployment Checks.

## Global Constraints

- The `gg-ci` repository is public: no GuestGuru project IDs, tokens, or app-specific defaults may be added.
- Ruleset activation happens only after all targeted repositories have emitted the measured quality-gate check successfully.
- Required approving review count remains zero. Keep required code-owner review off while the organization has only one member; the centrally sourced policy workflow is the enforceable protection against caller gate rewrites.
- External settings must be read back after every mutation.

---

### Task 1: Tested quality-gate evaluator in `gg-ci`

**Files:**
- Create: `src/quality-gate.ts`
- Create: `test/quality-gate.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: JSON shaped like GitHub's `needs` context: `{ [jobId]: { result: string, outputs: object } }`.
- Produces: `evaluateNeeds(json: string): { passed: boolean; failures: Array<{ job: string; result: string }> }` and CLI exit code `0` only when every direct dependency is `success`.

- [ ] **Step 1: Write the failing evaluator tests**

```ts
import { describe, expect, it } from "vitest";
import { evaluateNeeds } from "../src/quality-gate.js";

describe("evaluateNeeds", () => {
  it("passes only when every dependency succeeded", () => {
    expect(evaluateNeeds('{"lint":{"result":"success"},"test":{"result":"success"}}')).toEqual({
      passed: true,
      failures: [],
    });
  });

  it.each(["failure", "cancelled", "skipped"])("rejects %s dependencies", (result) => {
    expect(evaluateNeeds(JSON.stringify({ test: { result } }))).toEqual({
      passed: false,
      failures: [{ job: "test", result }],
    });
  });

  it("rejects empty and malformed payloads", () => {
    expect(() => evaluateNeeds("{}")).toThrow("legalább egy");
    expect(() => evaluateNeeds("not-json")).toThrow("érvénytelen JSON");
  });
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm test -- test/quality-gate.test.ts`

Expected: FAIL because `src/quality-gate.ts` does not exist.

- [ ] **Step 3: Implement the evaluator and CLI**

```ts
import { pathToFileURL } from "node:url";

type Need = { result?: unknown };

export function evaluateNeeds(json: string): {
  passed: boolean;
  failures: Array<{ job: string; result: string }>;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("A quality-gate inputja érvénytelen JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("A quality-gate inputja nem needs objektum.");
  }
  const entries = Object.entries(parsed as Record<string, Need>);
  if (entries.length === 0) {
    throw new Error("A quality-gate-hez legalább egy kötelező job kell.");
  }
  const failures = entries
    .map(([job, need]) => ({ job, result: String(need?.result ?? "missing") }))
    .filter(({ result }) => result !== "success");
  return { passed: failures.length === 0, failures };
}

export function run(argv: string[]): number {
  const result = evaluateNeeds(argv[0] ?? "");
  if (result.passed) {
    console.log("quality-gate: minden kötelező job sikeres");
    return 0;
  }
  for (const failure of result.failures) {
    console.error(`quality-gate: ${failure.job} → ${failure.result}`);
  }
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run(process.argv.slice(2));
}
```

Add to `package.json`:

```json
"quality-gate": "tsx src/quality-gate.ts"
```

- [ ] **Step 4: Run focused and full verification**

Run:

```bash
npm test -- test/quality-gate.test.ts
npm test
npm run typecheck
```

Expected: all tests and typecheck PASS.

- [ ] **Step 5: Commit**

```bash
git add src/quality-gate.ts test/quality-gate.test.ts package.json package-lock.json
git commit -m "feat(ci): add shared quality-gate evaluator"
```

### Task 2: Reusable workflow and self-consumption

**Files:**
- Create: `.github/workflows/quality-gate.yml`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/neon-preview.yml`
- Modify: `.github/workflows/preview-alias.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: required string workflow input `needs-json`.
- Produces: one reusable job named `verify`; caller check name is measured on the rollout PR.

- [ ] **Step 1: Add the reusable workflow**

```yaml
name: Quality gate

on:
  workflow_call:
    inputs:
      needs-json:
        description: "A caller kötelező jobjainak toJSON(needs) értéke."
        required: true
        type: string

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          repository: GuestGuru/gg-ci
          ref: ${{ job.workflow_sha }}
      - uses: actions/setup-node@v5
        with:
          node-version: "24"
          cache: npm
      - run: npm ci
      - name: Kötelező jobok eredménye
        env:
          NEEDS_JSON: ${{ inputs.needs-json }}
        run: npm run quality-gate -- "$NEEDS_JSON"
```

- [ ] **Step 2: Make `gg-ci` consume its local reusable workflow**

Append to `.github/workflows/ci.yml`:

```yaml
  quality-gate:
    name: quality-gate
    if: ${{ always() }}
    needs: [test]
    uses: ./.github/workflows/quality-gate.yml
    with:
      needs-json: ${{ toJSON(needs) }}
```

- [ ] **Step 3: Incorporate the already-green PR #3 checkout fix**

Change both reusable CLI workflows from:

```yaml
ref: main
```

to:

```yaml
ref: ${{ job.workflow_sha }}
```

Document that a caller pinned to a feature ref runs the matching CLI commit, so reusable workflow changes are testable before merge.

- [ ] **Step 4: Validate workflow syntax and local behavior**

Run:

```bash
actionlint .github/workflows/ci.yml .github/workflows/quality-gate.yml
npm run quality-gate -- '{"test":{"result":"success","outputs":{}}}'
! npm run quality-gate -- '{"test":{"result":"failure","outputs":{}}}'
npm test
npm run typecheck
```

Expected: YAML validation succeeds; success payload exits 0; failure payload exits non-zero; suite passes.

- [ ] **Step 5: Push and open the `gg-ci` draft PR**

Push `codex/it-244-gg-ci-upgrade`, open a draft PR, and record the exact rendered quality-gate check name from `gh pr checks`.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows README.md
git commit -m "feat(ci): publish reusable quality gate"
```

### Task 2A: Centrally enforce the caller wiring

**Files:**
- Create: `src/workflow-policy.ts`
- Create: `test/workflow-policy.test.ts`
- Create: `.github/workflows/policy-gate.yml`
- Modify: `package.json`, `package-lock.json`, `.github/actionlint.yaml`

The policy maps each protected repository to one canonical workflow path and exact
mandatory job list. It rejects missing or extra `needs`, bypassable conditions,
fabricated `needs-json`, mutable reusable-workflow refs, malformed YAML, and unknown
repositories. The organization ruleset sources `policy-gate.yml` from `gg-ci`, so a
target PR cannot replace the validator that checks it.

Validate with:

```bash
npm test -- test/workflow-policy.test.ts
npm run typecheck
actionlint -config-file .github/actionlint.yaml .github/workflows/policy-gate.yml
GITHUB_REPOSITORY=GuestGuru/gg-ci npm run workflow-policy -- .
```

### Task 3: Add caller gates in isolated worktrees

**Files:**
- Modify: `gg-sales/.github/workflows/ci.yml`
- Modify: `gg-design/.github/workflows/registry.yml`
- Modify: `BPDBv2/.github/workflows/ci.yml`
- Modify: `gg-agents/.github/workflows/ci.yml`
- Modify: `tools/.github/workflows/ci.yml`
- Modify: `irnok/.github/workflows/ci.yml`
- Create: `.github/CODEOWNERS` in every scoped repository
- Modify: each repo's delivery documentation (`CLAUDE.md`, `AGENTS.md`, or architecture doc as applicable)

**Interfaces:**
- Consumes: `GuestGuru/gg-ci/.github/workflows/quality-gate.yml@main`.
- Produces: the same rendered required check in every repository.

- [ ] **Step 1: Create one isolated `codex/it-244-ci-gate` worktree per repository**

Use each repository's existing `.worktrees/` directory and verify it is ignored before creation. Add every path and branch to `.feladat.md`.

- [ ] **Step 2: Append the caller job with exact dependencies**

`gg-sales` and `tools`:

```yaml
  quality-gate:
    name: quality-gate
    if: ${{ always() }}
    needs: [ci]
    uses: GuestGuru/gg-ci/.github/workflows/quality-gate.yml@main
    with:
      needs-json: ${{ toJSON(needs) }}
```

`gg-design`:

```yaml
    needs: [registry, meresek]
```

`BPDBv2`:

```yaml
    needs: [web, pipeline]
```

`gg-agents`:

```yaml
    needs: [ci, integration]
```

`irnok`:

```yaml
    needs: [web, cloud-function]
```

All other lines match the first snippet.

- [ ] **Step 3: Record delivery workflow ownership**

Add `.github/CODEOWNERS` in every caller repo, owning both the file itself and `.github/workflows/`. In `gg-ci`, also own the central workflow, `src/`, package manifests, and TypeScript config. Do not enable `require_code_owner_review` until a second eligible reviewer exists.

- [ ] **Step 4: Validate every workflow and run each repo's documented CI commands**

Expected: workflow lint PASS and every existing CI job command PASS before commit.

- [ ] **Step 5: Commit and open one draft PR per repository**

Use commit message:

```text
feat(ci): add organization quality gate
```

On each PR, verify the rendered quality-gate check name matches the `gg-ci` measurement.

### Task 4: Stage and activate the organization ruleset

**Files:**
- No repository file; GitHub organization setting.

**Interfaces:**
- Consumes: measured quality-gate check context and GitHub Actions integration ID.
- Produces: one organization-level ruleset targeting the seven scoped repositories' `~DEFAULT_BRANCH`.

- [ ] **Step 1: Resolve the GitHub Actions app integration ID from a real check run**

Run the commit check-runs API and record `.app.id` for the measured quality-gate check.

- [ ] **Step 2: Create the ruleset disabled**

Payload shape:

```json
{
  "name": "GG default branch delivery gate",
  "target": "branch",
  "enforcement": "disabled",
  "bypass_actors": [],
  "conditions": {
    "repository_name": {
      "include": ["gg-sales", "gg-design", "BPDBv2", "gg-agents", "tools", "irnok", "gg-ci"],
      "exclude": [],
      "protected": true
    },
    "ref_name": {
      "include": ["~DEFAULT_BRANCH"],
      "exclude": []
    }
  },
  "rules": [
    {
      "type": "pull_request",
      "parameters": {
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_approving_review_count": 0,
        "required_review_thread_resolution": true
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "do_not_enforce_on_create": true,
        "required_status_checks": [
          {
            "context": "<MEASURED_CONTEXT>",
            "integration_id": "<MEASURED_INTEGRATION_ID>"
          }
        ],
        "strict_required_status_checks_policy": false
      }
    },
    {
      "type": "workflows",
      "parameters": {
        "do_not_enforce_on_create": true,
        "workflows": [
          {
            "path": ".github/workflows/policy-gate.yml",
            "repository_id": "<GG_CI_REPOSITORY_ID>",
            "ref": "refs/heads/main"
          }
        ]
      }
    },
    { "type": "deletion" },
    { "type": "non_fast_forward" }
  ]
}
```

Replace both placeholders with measured values; do not assume the sample integration ID.

- [ ] **Step 3: Read back and compare the disabled ruleset**

Expected: targets, ref selector, check source, and no bypass actors match exactly.

- [ ] **Step 4: Activate only after all seven gates exist on default branches**

Update only `enforcement` to `active`, read back, then verify a controlled failing PR cannot merge.

### Task 5: Configure Vercel production Deployment Checks

**Files:**
- No repository file; six Vercel project production environment settings.

**Interfaces:**
- Consumes: the same measured GitHub quality-gate check.
- Produces: blocked production domain promotion until the `main` gate succeeds.

- [ ] **Step 1: Configure the required GitHub check in each project**

Projects: `gg-sales`, `gg-design`, `bpdb-v2`, `gg-agents`, `gg-tools`, `gg-irnok`.

- [ ] **Step 2: Read back each project's production check setting**

Expected: all six point to the same GitHub check and only the production environment is blocking.

- [ ] **Step 3: Run a controlled failure proof**

Use a reversible test branch/PR whose check intentionally fails. Verify merge is blocked. After a test merge in an authorized test path, verify Vercel creates but does not promote a production deployment until the gate succeeds.
