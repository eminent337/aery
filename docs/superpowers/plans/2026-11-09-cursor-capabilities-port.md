# Cursor Agent Capabilities Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port four high-impact architectural capabilities identified from Cursor Agent CLI (`@anysphere/agent-cli-runtime`) into Aery: (1) `blockGitWrites` metadata protection in Damage Control, (2) Structured Decision & Security Audit Logging (`decisionLogPath`), (3) Merkle DAG / Git Tree Hash Change Detection, and (4) the Autonomous "Grind Loop" (`grind`) test-driven fixing tool.

**Architecture:** Integrate safety protections directly into `@aryee337/aery-extensions` damage control, add structured audit streaming to disk, implement ultra-fast git tree hash caching for repo state diffing, and register a first-class `grind` tool in `@aryee337/aery-coding-agent` for autonomous test-fix verification cycles.

**Tech Stack:** TypeScript, Bun, Bun Test, Git CLI / tree object hashing, Biome.

---

### File Structure Map

1. **Damage Control & Git Protection:**
   - Modify: `packages/aery-extensions/src/core/damage-control.ts`
   - Test: `packages/aery-extensions/test/damage-control.test.ts`
2. **Structured Decision & Audit Logging:**
   - Create: `packages/aery-extensions/src/core/security-audit.ts`
   - Modify: `packages/aery-extensions/src/core/damage-control.ts`
   - Test: `packages/aery-extensions/test/security-audit.test.ts`
3. **Merkle DAG / Git Tree Hash Detector:**
   - Create: `packages/coding-agent/src/utils/git-tree-hash.ts`
   - Test: `packages/coding-agent/test/git-tree-hash.test.ts`
4. **Autonomous Grind Loop Tool (`grind`):**
   - Create: `packages/coding-agent/src/tools/grind.ts`
   - Modify: `packages/coding-agent/src/tools/index.ts`
   - Test: `packages/coding-agent/test/tools/grind.test.ts`

---

## Tasks

### Task 1: `blockGitWrites` in Damage Control

Prevent accidental or destructive writes to `.git/` metadata (e.g., editing hooks, corrupting index, destructive checkouts) while keeping regular repository files editable.

**Files:**
- Modify: `packages/aery-extensions/src/core/damage-control.ts`
- Create: `packages/aery-extensions/test/damage-control.test.ts`

- [ ] **Step 1: Write failing tests for git metadata write protection**
  Test that writes/edits targeting `.git/...` paths are blocked by default.
  Test that dangerous bash commands writing into `.git/` (e.g. `> .git/hooks/pre-commit`, `rm -rf .git`) are blocked.
  Test that standard git read commands (e.g. `git status`, `git diff`) and standard commit commands remain allowed.

- [ ] **Step 2: Run test to verify it fails**
  Run: `HOME=/tmp bun test packages/aery-extensions/test/damage-control.test.ts`
  Expected: FAIL (missing `.git` enforcement)

- [ ] **Step 3: Implement `blockGitWrites` in `damage-control.ts`**
  Add built-in protection for `.git/` in file operations (`write`, `edit`).
  Add pattern matching to intercept commands attempting to overwrite or delete `.git/`.
  Support optional override in `damage-control.yaml` under `allow_git_writes: true`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `HOME=/tmp bun test packages/aery-extensions/test/damage-control.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  Run: `git commit -m "feat(security): enforce blockGitWrites in damage control"`

---

### Task 2: Structured Security & Sandbox Decision Audit Log (`decisionLogPath`)

Stream every tool authorization, block, or sandbox policy decision as structured JSONL entries to disk so security posture is observable and auditable.

**Files:**
- Create: `packages/aery-extensions/src/core/security-audit.ts`
- Modify: `packages/aery-extensions/src/core/damage-control.ts`
- Create: `packages/aery-extensions/test/security-audit.test.ts`

- [x] **Step 1: Write failing tests for security audit logging**
  Test record creation with schema: `{ timestamp, toolName, action, target, decision: "allow" | "block", reason?, metadata? }`.
  Test JSONL append behavior with error-handling to ensure logging never crashes tool execution.

- [x] **Step 2: Run test to verify it fails**
  Run: `HOME=/tmp bun test packages/aery-extensions/test/security-audit.test.ts`
  Expected: FAIL

- [x] **Step 3: Implement `SecurityAuditLogger`**
  Implement non-blocking append to configured audit path (`~/.aery/logs/security-audit.jsonl`).
  Hook into `damage-control.ts` to log both allowed sensitive operations and blocked violations.

- [x] **Step 4: Run test to verify it passes**
  Run: `HOME=/tmp bun test packages/aery-extensions/test/security-audit.test.ts`
  Expected: PASS

- [x] **Step 5: Commit**
  Run: `git commit -m "feat(security): add structured security audit decision logging"`

---

### Task 3: Merkle DAG / Git Tree Hash Change Detector

Implement sub-millisecond repository change detection using Git tree hashing to know whether files changed without scanning the filesystem.

**Files:**
- Create: `packages/coding-agent/src/utils/git-tree-hash.ts`
- Create: `packages/coding-agent/test/git-tree-hash.test.ts`

- [ ] **Step 1: Write failing test for `getGitTreeHash`**
  Test hash computation on a clean git directory.
  Test hash changes after modifying or staging a file.
  Test fallback when directory is not a git repository.

- [ ] **Step 2: Run test to verify it fails**
  Run: `HOME=/tmp bun test packages/coding-agent/test/git-tree-hash.test.ts`
  Expected: FAIL

- [ ] **Step 3: Implement `getGitTreeHash` and `hasRepoChangedSince`**
  Use `git rev-parse HEAD^{tree}` and `git write-tree` (or index hash fallback) via Bun subprocess.
  Provide `hasRepoChangedSince(cwd, previousHash)` returning `{ changed: boolean, currentHash: string }`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `HOME=/tmp bun test packages/coding-agent/test/git-tree-hash.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  Run: `git commit -m "feat(repo): add fast git tree hash change detector"`

---

### Task 4: Autonomous Grind Loop Tool (`grind`)

Provide a dedicated tool that executes an autonomous test-and-repair loop: runs a verification command, parses error output, allows the model to iterate, and stops when clean.

**Files:**
- Create: `packages/coding-agent/src/tools/grind.ts`
- Modify: `packages/coding-agent/src/tools/index.ts`
- Create: `packages/coding-agent/test/tools/grind.test.ts`

- [ ] **Step 1: Write failing test for `GrindTool`**
  Test execution of a passing test command (returns `{ passed: true, output }`).
  Test execution of a failing command (returns `{ passed: false, errorSummary, failures, exitCode }`).
  Test iteration limit and timeout protections.

- [ ] **Step 2: Run test to verify it fails**
  Run: `HOME=/tmp bun test packages/coding-agent/test/tools/grind.test.ts`
  Expected: FAIL

- [ ] **Step 3: Implement `GrindTool`**
  Register tool with schema: `{ command: string, timeoutMs?: number, maxOutputChars?: number }`.
  Execute command, sanitize ANSI escape codes, extract failures/stack traces, and return structured outcome.
  Wire `GrindTool` into `packages/coding-agent/src/tools/index.ts`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `HOME=/tmp bun test packages/coding-agent/test/tools/grind.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  Run: `git commit -m "feat(tools): implement autonomous grind loop tool"`

---

### Verification and Integration
- [ ] Run full test suite across touched packages.
- [ ] Verify zero AI dashes across all new and modified files.
- [ ] Merge `feat/cursor-agent-capabilities` into `main`.
