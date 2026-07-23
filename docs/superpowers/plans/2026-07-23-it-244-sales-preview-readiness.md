# IT-244 Sales Preview Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A brand-new sales PR's first Vercel preview build waits briefly for its Neon preview endpoint instead of failing at `migrate:ci`.

**Architecture:** Retry only the initial connection acquisition and only in Vercel preview. The migration transaction and SQL remain fail-fast. A dependency-injected generic retry helper makes timing and failure behavior unit-testable without a database.

**Tech Stack:** TypeScript, Node test runner, `@neondatabase/serverless`, Vercel, Neon.

## Global Constraints

- Retry is enabled only when `VERCEL_ENV === "preview"`.
- Maximum readiness window is 90 seconds; delay doubles from 1 second and caps at 15 seconds.
- Missing connection configuration, production connectivity failures, and all SQL errors remain fail-fast.
- No test may connect to production data.

---

### Task 1: Extract and test bounded connection retry

**Files:**
- Create: `scripts/connect-with-retry.ts`
- Create: `test/connect-with-retry.test.ts`
- Modify: `scripts/migrate.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `connectWithRetry<T>(connect, options): Promise<T>`.
- Consumes: injected `now` and `sleep` functions for deterministic tests.

- [ ] **Step 1: Add failing Node tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { connectWithRetry } from "../scripts/connect-with-retry.js";

test("previewban exponenciálisan vár, majd visszaadja a kapcsolatot", async () => {
  let attempts = 0;
  let now = 0;
  const sleeps: number[] = [];
  const result = await connectWithRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error(`not ready ${attempts}`);
      return "connected";
    },
    {
      enabled: true,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    },
  );
  assert.equal(result, "connected");
  assert.deepEqual(sleeps, [1000, 2000]);
});

test("previewn kívül az első hibát azonnal továbbadja", async () => {
  let attempts = 0;
  const error = new Error("offline");
  await assert.rejects(
    connectWithRetry(async () => {
      attempts += 1;
      throw error;
    }, { enabled: false }),
    error,
  );
  assert.equal(attempts, 1);
});

test("a határidő után az utolsó kapcsolati hibával bukik", async () => {
  let now = 0;
  await assert.rejects(
    connectWithRetry(
      async () => {
        throw new Error("still starting");
      },
      {
        enabled: true,
        maxWaitMs: 2500,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    ),
    /still starting/,
  );
  assert.equal(now, 2500);
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `node --import tsx --test test/connect-with-retry.test.ts`

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement the minimal helper**

```ts
type RetryOptions = {
  enabled: boolean;
  maxWaitMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export async function connectWithRetry<T>(
  connect: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.maxWaitMs ?? 90_000);
  const maxDelay = options.maxDelayMs ?? 15_000;
  let delay = options.initialDelayMs ?? 1_000;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await connect();
    } catch (error) {
      if (!options.enabled) throw error;
      const remaining = deadline - now();
      if (remaining <= 0) throw error;
      const wait = Math.min(delay, maxDelay, remaining);
      console.warn(`Preview DB még nem elérhető; újrapróbálás ${wait} ms múlva (kísérlet: ${attempt}).`);
      await sleep(wait);
      delay = Math.min(delay * 2, maxDelay);
    }
  }
}
```

- [ ] **Step 4: Wrap only pool creation plus `connect()` in the retry**

```ts
const connectionString = pooledDbUrl();
const { pool, client } = await connectWithRetry(
  async () => {
    const pool = new Pool({ connectionString });
    try {
      return { pool, client: await pool.connect() };
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  },
  { enabled: process.env.VERCEL_ENV === "preview" },
);
```

Keep every migration query after this block unchanged.

- [ ] **Step 5: Add the fast unit test to package scripts and CI**

Add:

```json
"test:retry": "node --import tsx --test test/connect-with-retry.test.ts"
```

Run `npm run test:retry` in the existing `ci` job before the database-backed Playwright suite.

- [ ] **Step 6: Run focused, type, lint, and full tests**

Run:

```bash
npm run test:retry
npm run lint
npm run typecheck
npm test
```

Expected: all PASS; `npm test` uses its existing ephemeral Neon test branch.

- [ ] **Step 7: Update architecture/runbook documentation**

Document the 90-second preview-only readiness retry and explicitly state that SQL errors and production failures are not retried.

- [ ] **Step 8: Commit**

```bash
git add scripts/connect-with-retry.ts scripts/migrate.ts test/connect-with-retry.test.ts package.json .github/workflows/ci.yml docs/ARCHITECTURE.md
git commit -m "fix(ci): wait for first sales preview database"
```

### Task 2: Prove the first-build path on a new PR

**Files:**
- No additional source file.

- [ ] **Step 1: Push the new branch and open a draft PR**

Do not reuse an existing PR because the bug only appears during first branch provisioning.

- [ ] **Step 2: Observe the first Vercel deployment without an empty follow-up commit**

Expected:

- the first non-cancelled deployment reaches `READY`;
- build logs show one or more bounded readiness retries only if Neon is late;
- `migrate:ci` then succeeds;
- the preview link workflow posts or updates exactly one PR comment.

- [ ] **Step 3: Confirm no SQL failure masking**

Run the unit deadline case and inspect that the final error remains non-zero. Do not introduce a deliberately broken migration into a shared or production branch.

