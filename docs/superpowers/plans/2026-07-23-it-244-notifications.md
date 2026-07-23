# IT-244 Notification Noise Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Intermediate agent pushes stop generating GitHub Actions and Vercel deployment emails while final status and preview links stay visible in Codex, GitHub, and Vercel web UIs.

**Architecture:** Use the platforms' user-level channel settings rather than workflow code. Keep web notifications and PR deployment comments; disable only the email channel for per-run deployment events. Security, billing, usage, and domain alerts remain untouched.

**Tech Stack:** GitHub notification settings, Vercel My Notifications, existing PR comments/checks.

## Global Constraints

- Only Krasser Tamás's own notification preferences may be changed.
- Keep web notifications enabled.
- Do not alter billing, spend, usage anomaly, security, domain, or certificate alerts.
- Preserve Vercel PR comments and GG preview comments because they carry preview URLs.

---

### Task 1: GitHub Actions email channel

**Files:**
- No repository file; user-level GitHub setting.

- [ ] **Step 1: Open GitHub notification settings while signed in as `kratam`**

Navigate to the System → Actions notification control.

- [ ] **Step 2: Disable Actions email notifications**

Choose `Don't notify` for Actions workflow-run notifications. Do not change pull-request, review, security, or repository watching preferences.

- [ ] **Step 3: Reload and verify**

Expected: Actions shows no email delivery; unrelated notification categories are unchanged.

### Task 2: Vercel deployment email channel

**Files:**
- No repository file; user-level Vercel team setting.

- [ ] **Step 1: Open GuestGuru → Settings → My Notifications**

Verify the signed-in user and team before changing anything.

- [ ] **Step 2: Turn off email only for deployment events**

For `Deployment Failures` and `Deployment Promotions`:

- email: off;
- web: on.

Leave every other category unchanged.

- [ ] **Step 3: Reload and verify**

Expected: both deployment rows retain web delivery and no longer use email.

### Task 3: Verify preview-link visibility remains

**Files:**
- No repository file.

- [ ] **Step 1: Inspect a recent application PR**

Expected: the Vercel check/comment or the GG marker comment still exposes the current preview URL.

- [ ] **Step 2: Confirm comment update behavior**

Verify repeated preview deploys update the existing bot/marker comment instead of adding a new comment per push.

- [ ] **Step 3: Record the policy**

Add a short section to the central delivery documentation explaining that per-push deployment email is intentionally disabled and final status is communicated through the active agent task plus the stable PR quality gate.
