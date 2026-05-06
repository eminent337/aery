# Aery Reliability Polish Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve Aery's day-to-day trust by polishing provider setup, core extension repair guidance, and release/update visibility.

**Architecture:** Keep changes small and close to existing CLI/TUI surfaces. Add reusable formatter helpers for user-facing guidance, then wire them into current auth, startup, and package-manager flows without changing provider execution semantics.

**Tech Stack:** TypeScript, Vitest, GitHub Actions, npm workspace packages.

---

## Chunk 1: Provider Setup Polish

### Task 1: Provider-Specific Auth Guidance

**Files:**
- Modify: `packages/coding-agent/src/core/auth-guidance.ts`
- Modify: `packages/coding-agent/src/core/model-registry.ts`
- Test: `packages/coding-agent/test/auth-guidance.test.ts`
- Test: `packages/coding-agent/test/model-registry.test.ts`

- [ ] **Step 1: Write failing guidance tests**
  Add tests that assert Cloudflare guidance mentions both API token and account ID, and generic guidance remains concise.

- [ ] **Step 2: Run tests to verify failure**
  Run: `npm run test --prefix packages/coding-agent -- auth-guidance.test.ts model-registry.test.ts`
  Expected locally in this workspace may fail with `vitest: command not found`; CI must run this successfully after push.

- [ ] **Step 3: Implement minimal guidance helpers**
  Add functions such as `getProviderSetupRequirements(provider)` and `formatMissingProviderRequirement(provider, requirement)` in `auth-guidance.ts`.

- [ ] **Step 4: Surface missing Cloudflare account ID in auth status**
  Extend `ModelRegistry.getProviderAuthStatus("cloudflare-workers-ai")` to report an unconfigured status with a clear label when an API key exists but no account ID is available.

- [ ] **Step 5: Verify**
  Run `git diff --check` and the targeted test command.

### Task 2: Login Prompt Guidance

**Files:**
- Modify: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- Test: `packages/coding-agent/test/oauth-selector.test.ts` or a new focused test if needed

- [ ] **Step 1: Add test coverage for Cloudflare display/guidance**
  Assert Cloudflare remains available in `/login` and has the correct display name.

- [ ] **Step 2: Improve Cloudflare prompts**
  Use clearer prompt text: `Enter Cloudflare API token:` and `Enter Cloudflare account ID:`.

- [ ] **Step 3: Verify**
  Run `git diff --check` and targeted tests.

## Chunk 2: Extension Reliability

### Task 3: Core Extension Status Formatter

**Files:**
- Modify: `packages/coding-agent/src/migrations.ts`
- Modify: `packages/coding-agent/src/main.ts`
- Test: `packages/coding-agent/test/core-extensions-status.test.ts`

- [ ] **Step 1: Write formatter tests**
  Cover offline install, missing files, missing settings entries, and explicit errors.

- [ ] **Step 2: Extract formatter**
  Add a small exported formatter that turns `CoreExtensionEnsureResult` into actionable startup text.

- [ ] **Step 3: Use formatter in startup**
  Replace inline startup message logic in `main.ts`.

- [ ] **Step 4: Verify**
  Run targeted test and `git diff --check`.

### Task 4: Update Command Result Clarity

**Files:**
- Modify: `packages/coding-agent/src/package-manager-cli.ts`
- Test: add or update package-manager CLI tests if existing coverage supports it

- [ ] **Step 1: Identify current update test pattern**
  Search tests for package-manager CLI update behavior.

- [ ] **Step 2: Improve successful extension update wording**
  Print clearer text for `aery update --extensions`, including whether all packages or one source was updated.

- [ ] **Step 3: Verify**
  Run targeted tests and `git diff --check`.

## Chunk 3: Release/Update Confidence

### Task 5: Publish Workflow Diagnostics

**Files:**
- Modify: `.github/workflows/publish.yml`

- [ ] **Step 1: Add workflow summary lines**
  Write `$GITHUB_STEP_SUMMARY` entries for publish eligibility, target commit, new version, npm package, and release tag.

- [ ] **Step 2: Preserve existing gating**
  Keep workflow_run gating and source-file eligibility unchanged.

- [ ] **Step 3: Verify syntax**
  Run `git diff --check` and inspect YAML.

### Task 6: Release Verification Command

**Files:**
- Modify or create: `packages/coding-agent/scripts` only if an existing script pattern is present; otherwise skip this task.
- Test: script smoke test if added

- [ ] **Step 1: Check existing scripts**
  Inspect `packages/coding-agent/scripts` and root `scripts/`.

- [ ] **Step 2: Add only if it fits existing patterns**
  If there is a clear local pattern, add a simple verification script that prints npm version, latest GitHub release, and local package version.

- [ ] **Step 3: Verify**
  Run the script locally if network/gh access is available.

## Final Verification

- [ ] Run `git diff --check`.
- [ ] Run targeted tests locally if dependencies are present.
- [ ] Push and watch CI.
- [ ] Confirm automatic publish either skips workflow-only changes or publishes source changes as expected.
- [ ] Pull the version-bump commit after publish.
