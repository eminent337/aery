# July 2026 Upstream Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port high-value UX and performance fixes from the July 2026 upstream updates into Aery's sovereign codebase.

**Architecture:** 
1. Improve TUI editor autocomplete behavior to auto-refresh and cancel stale selections on destructive actions (e.g. backspace, Ctrl+W, Ctrl+U).
2. Drain stderr of the `git apply` process concurrently to avoid deadlocks when applying large patches.
3. Optimize TUI system clipboard operations by replacing synchronous blocking `execSync` with non-blocking async `Bun.spawn` calls.

**Tech Stack:** TypeScript, Bun, Rust (aery-iso), Git.

---

### Task 1: Autocomplete Invalidation & Mid-Prompt Skill Autocomplete

Improve autocomplete invalidation behavior and add support for mid-prompt skill completion (mirroring commits `1c05d059a` and `603791283`).

**Files:**
- Modify: `packages/tui/src/autocomplete.ts`
- Modify: `packages/tui/src/components/editor.ts`
- Modify: `packages/tui/test/autocomplete.test.ts`
- Modify: `packages/tui/test/editor-autocomplete-actions.test.ts`

- [ ] **Step 1: Implement trailing slash parser in `packages/tui/src/autocomplete.ts`**
  Add the helper functions:
  ```typescript
  export function findTrailingSlashCommandStart(text: string): number | null {
  	const match = /(?:^|\s)\/([^\s/]*)$/.exec(text);
  	if (!match || match.index === undefined) return null;
  	const slashOffset = match[0].indexOf("/");
  	return match.index + slashOffset;
  }

  function hasPromptTextBeforeSlash(
  	lines: string[],
  	cursorLine: number,
  	textBeforeCursor: string,
  	slashStart: number,
  ): boolean {
  	for (let i = 0; i < cursorLine; i += 1) {
  		if ((lines[i] || "").trim() !== "") return true;
  	}
  	return textBeforeCursor.slice(0, slashStart).trim() !== "";
  }

  function buildMidPromptSkillCompletions(commands: CommandEntry[], lowerPrefix: string): AutocompleteItem[] {
  	return buildSlashCommandCompletions(
  		commands.filter(cmd => getCommandName(cmd)?.startsWith("skill:")),
  		lowerPrefix,
  	);
  }
  ```
  Integrate these helpers into `CombinedAutocompleteProvider.getSuggestions` and `CombinedAutocompleteProvider.applyCompletion` to detect mid-prompt skill lookup (`/skill:...`) and allow accepting completions.

- [ ] **Step 2: Update autocomplete checking and destructive edit listeners in `packages/tui/src/components/editor.ts`**
  Modify `#autocompletePrefixMatchesCursorText` to support the new re-anchoring branches for paths, slash-commands, and `@`-files.
  Call `this.#retriggerAutocompleteAtCursor()` inside destructive actions like backspace, deletion of words, and yanking.
  Cancel autocomplete when Enter/Tab matches a stale state.

- [ ] **Step 3: Run the existing tests to ensure no regressions**
  Run: `bun test packages/tui`
  Expected: PASS

- [ ] **Step 4: Add new tests for autocomplete stale invalidation in `packages/tui/test/editor-autocomplete-actions.test.ts`**
  Write tests confirming Tab does not insert stale suggestions after `Ctrl+W` or `Ctrl+U`, and mid-prompt skill completions are successfully handled.

- [ ] **Step 5: Run tests and commit**
  Run: `bun test packages/tui`
  Expected: PASS
  Commit:
  ```bash
  git add packages/tui/src/autocomplete.ts packages/tui/src/components/editor.ts packages/tui/test/autocomplete.test.ts packages/tui/test/editor-autocomplete-actions.test.ts
  git commit -m "feat(tui): invalidate autocomplete on destructive edits and support mid-prompt skill completion"
  ```

---

### Task 2: Git Apply Stderr Deadlock Fix

Drain stderr concurrently to prevent pipe buffer exhaustion deadlocks when writing a large patch file to `git apply`.

**Files:**
- Modify: `crates/aery-iso/src/rcopy.rs`

- [ ] **Step 1: Update Rust code in `crates/aery-iso/src/rcopy.rs`**
  Introduce `git_apply_with_program` helper.
  Spawn an asynchronous `std::thread` reader to read and drain stderr from the child process concurrently while writing the patch to `stdin`.
  Collect the thread's result and propagate any git apply errors.

- [ ] **Step 2: Add integration test inside `crates/aery-iso/src/rcopy.rs`**
  Add a Unix-only unit test `git_apply_drains_stderr_while_writing_stdin` that spawns a fake git script writing 4MB to stderr, confirming it doesn't hang or deadlock.

- [ ] **Step 3: Run Rust tests**
  Run: `cargo test --manifest-path crates/aery-iso/Cargo.toml`
  Expected: PASS

- [ ] **Step 4: Commit**
  ```bash
  git add crates/aery-iso/src/rcopy.rs
  git commit -m "fix(aery-iso): drain git apply stderr concurrently during patch writes"
  ```

---

### Task 3: Non-Blocking Clipboard Operations

Replace blocking `execSync` calls with non-blocking async `Bun.spawn` calls to prevent frame stutters in the TUI (mirroring commit `5bc796d4c`).

**Files:**
- Modify: `packages/coding-agent/src/utils/clipboard.ts`
- Modify: `packages/coding-agent/test/utils/clipboard.test.ts`

- [ ] **Step 1: Replace clipboard reading sync calls in `packages/coding-agent/src/utils/clipboard.ts`**
  Implement helper `spawnCapture(cmd: string[], options: { input?: string; timeoutMs?: number }): Promise<string>`.
  Rewrite `readMacFileUrlsFromClipboard`, `copyToClipboard`, and `readTextFromClipboard` to use `spawnCapture` instead of `execSync`.

- [ ] **Step 2: Update clipboard tests in `packages/coding-agent/test/utils/clipboard.test.ts`**
  Migrate clipboard mocks and tests to assert on `Bun.spawn` calls instead of `execSync`, adding a test verifying the event loop remains responsive during slow paste actions.

- [ ] **Step 3: Run workspace tests and commit**
  Run: `bun test packages/coding-agent/test/utils/clipboard.test.ts`
  Expected: PASS
  Commit:
  ```bash
  git add packages/coding-agent/src/utils/clipboard.ts packages/coding-agent/test/utils/clipboard.test.ts
  git commit -m "perf(clipboard): read system clipboard asynchronously via Bun.spawn to avoid blocking TUI"
  ```
