# Session & Edit-Tool Optimizations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement session performance optimizations (avoiding Ctrl+C OOMs, branch-scoping compaction elision) and edit-tool details snapshot pruning (above 32 KB) to improve TUI reliability and reduce log file footprint.

**Architecture:** Edit tools will automatically drop `oldText`/`newText` snapshots from their `details` payload if their combined size exceeds 32 KB, notifying the TUI/ACP with a `snapshotsPruned` flag. The session manager will skip file rewrites on synchronous flush if no modifications were made, and it will restrict compaction summary elisions to the active branch path.

**Tech Stack:** TypeScript, Bun Test, Biome

---

## Task 1: Edit-Tool Snapshot Pruning

### Files:
- Create: `packages/coding-agent/src/edit/snapshot-details.ts`
- Modify: `packages/coding-agent/src/edit/renderer.ts`
- Modify: `packages/coding-agent/src/edit/index.ts`
- Modify: `packages/coding-agent/src/edit/hashline/execute.ts`
- Create: `packages/coding-agent/test/edit-snapshot-details.test.ts`

- [ ] **Step 1.1: Create `packages/coding-agent/src/edit/snapshot-details.ts`**

Write the utility module for detecting and pruning oversized edit snapshots:

```typescript
import type { EditToolDetails, EditToolPerFileResult } from "./renderer";

export const MAX_EDIT_SNAPSHOT_TEXT_CHARS = 32_768;

type WithSnapshot = { oldText?: string; newText?: string; snapshotsPruned?: boolean };

function pruneSnapshot<T extends WithSnapshot>(details: T): T {
	if ((details.oldText?.length ?? 0) + (details.newText?.length ?? 0) <= MAX_EDIT_SNAPSHOT_TEXT_CHARS) {
		return details;
	}
	const { oldText: _old, newText: _new, ...rest } = details;
	return { ...rest, snapshotsPruned: true } as T;
}

function capPerFileSnapshots<T extends WithSnapshot>(entries: T[]): T[] {
	let remaining = MAX_EDIT_SNAPSHOT_TEXT_CHARS;
	return entries.map(entry => {
		const perEntry = pruneSnapshot(entry);
		const kept = (perEntry.oldText?.length ?? 0) + (perEntry.newText?.length ?? 0);
		if (kept === 0) return perEntry;
		if (kept <= remaining) {
			remaining -= kept;
			return perEntry;
		}
		const { oldText: _old, newText: _new, ...rest } = perEntry;
		return { ...rest, snapshotsPruned: true } as T;
	});
}

export function pruneOversizedEditSnapshots(details: EditToolPerFileResult): EditToolPerFileResult;
export function pruneOversizedEditSnapshots(details: EditToolDetails): EditToolDetails;
export function pruneOversizedEditSnapshots(
	details: EditToolDetails | EditToolPerFileResult,
): EditToolDetails | EditToolPerFileResult {
	const pruned = pruneSnapshot(details);
	if ("perFileResults" in pruned && pruned.perFileResults) {
		return { ...pruned, perFileResults: capPerFileSnapshots(pruned.perFileResults) };
	}
	return pruned;
}
```

- [ ] **Step 1.2: Update `packages/coding-agent/src/edit/renderer.ts`**

Add `snapshotsPruned?: boolean` interface definitions:

```typescript
// Add snapshotsPruned property in EditToolPerFileResult interface:
export interface EditToolPerFileResult {
	// ... existing fields ...
	snapshotsPruned?: boolean;
}

// Add snapshotsPruned property in EditToolDetails interface:
export interface EditToolDetails {
	// ... existing fields ...
	snapshotsPruned?: boolean;
}
```

- [ ] **Step 1.3: Update `packages/coding-agent/src/edit/index.ts`**

Add imports and update single-path aggregation and file-level results processing to propagate the pruning indicator:

```typescript
// Import the new utility:
import { pruneOversizedEditSnapshots } from "./snapshot-details";

// In executeApplyPatchPerFile:
// Make sure snapshotsPruned is propagated when mapping details:
results.push({
	path,
	diff: details?.diff ?? "",
	firstChangedLine: details?.firstChangedLine,
	meta: details?.meta,
	oldText: details?.oldText,
	newText: details?.newText,
	snapshotsPruned: details?.snapshotsPruned,
});

// In executeSinglePathEntries:
// Update snapshot accumulation logic to check snapshotsPruned:
let snapshotsPruned = false;

for (let i = 0; i < runs.length; i++) {
	// ... inside the loop ...
	if (details?.snapshotsPruned) snapshotsPruned = true;
}

// And return the details:
return {
	content: [
		{
			type: "text",
			text: contentTexts.filter(Boolean).join("\n\n"),
		},
	],
	details: pruneOversizedEditSnapshots({
		diff: diffTexts.join("\n"),
		firstChangedLine,
		path: metadataPath ?? path,
		...(snapshotsPruned
			? { snapshotsPruned: true as const }
			: {
					...(hasFirstOldText ? { oldText: firstOldText } : {}),
					...(hasLastNewText ? { newText: lastNewText } : {}),
				}),
	}),
};
```

- [ ] **Step 1.4: Update `packages/coding-agent/src/edit/hashline/execute.ts`**

Wrap returned details in hashline multi-section aggregate:

```typescript
// Import pruneOversizedEditSnapshots:
import { pruneOversizedEditSnapshots } from "../snapshot-details";

// In executeHashlineSingle:
return {
	content: [
		{
			type: "text",
			text: rendered
				.map(r => r.toolResult.content?.find(c => c.type === "text")?.text ?? "")
				.filter(Boolean)
				.join("\n\n"),
		},
	],
	details: pruneOversizedEditSnapshots({
		diff: rendered.map(r => r.toolResult.details?.diff ?? "").join("\n"),
		perFileResults: rendered.map(r => r.perFileResult),
	}),
};
```

- [ ] **Step 1.5: Create `packages/coding-agent/test/edit-snapshot-details.test.ts`**

Write regression tests for edit-tool details size bounds:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { formatHashlineHeader } from "@aryee337/hashline";
import { resetSettingsForTest, Settings } from "@aryee337/aery/config/settings";
import {
	canonicalSnapshotKey,
	DEFAULT_FUZZY_THRESHOLD,
	EditTool,
	type EditToolDetails,
	executeHashlineSingle,
	executePatchSingle,
	executeReplaceSingle,
	getFileSnapshotStore,
	MAX_EDIT_SNAPSHOT_TEXT_CHARS,
	pruneOversizedEditSnapshots,
} from "@aryee337/aery/edit";
import { writethroughNoop } from "@aryee337/aery/lsp";
import type { ToolSession } from "@aryee337/aery/tools";
import { removeWithRetries } from "@aryee337/aery-utils";

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		enableLsp: false,
		settings: Settings.isolated({ "edit.mode": "patch" }),
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
}

const noopBeginDeferred = (_p: string) => ({
	onDeferredDiagnostics: () => {},
	signal: new AbortController().signal,
	finalize: () => {},
});

const FILLER = `${"a line of content xxxx yyyy zzzz".repeat(20)}\n`.repeat(2_000);

let tempDir: string;

beforeEach(async () => {
	resetSettingsForTest();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aery-edit-snapshot-"));
	await Settings.init({ inMemory: true, cwd: tempDir });
});

afterEach(async () => {
	resetSettingsForTest();
	await removeWithRetries(tempDir);
});

describe("pruneOversizedEditSnapshots", () => {
	test("returns input unchanged when combined snapshot is under the budget", () => {
		const oldText = "x".repeat(MAX_EDIT_SNAPSHOT_TEXT_CHARS / 2);
		const newText = "y".repeat(MAX_EDIT_SNAPSHOT_TEXT_CHARS / 2);
		const details = { diff: "d", path: "/p", oldText, newText };
		expect(pruneOversizedEditSnapshots(details)).toBe(details);
	});

	test("drops oldText and newText when combined size exceeds the budget", () => {
		const oversized = "x".repeat(MAX_EDIT_SNAPSHOT_TEXT_CHARS);
		const result = pruneOversizedEditSnapshots({
			diff: "@@",
			path: "/p",
			firstChangedLine: 5,
			oldText: oversized,
			newText: oversized,
		});
		expect(result).toEqual({ diff: "@@", path: "/p", firstChangedLine: 5, snapshotsPruned: true });
		expect("oldText" in result).toBe(false);
		expect("newText" in result).toBe(false);
	});

	test("prunes snapshots inside perFileResults independently of the aggregate", () => {
		const oversized = "x".repeat(MAX_EDIT_SNAPSHOT_TEXT_CHARS);
		const small = "tiny";
		const result = pruneOversizedEditSnapshots({
			diff: "d",
			perFileResults: [
				{ path: "/big", diff: "d1", oldText: oversized, newText: oversized },
				{ path: "/small", diff: "d2", oldText: small, newText: small },
			],
		});
		expect(result.perFileResults?.[0]).toEqual({ path: "/big", diff: "d1", snapshotsPruned: true });
		expect(result.perFileResults?.[1]).toEqual({
			path: "/small",
			diff: "d2",
			oldText: small,
			newText: small,
		});
	});

	test("caps cumulative perFileResults snapshots at the shared aggregate budget", () => {
		const entrySize = Math.floor(MAX_EDIT_SNAPSHOT_TEXT_CHARS / 4);
		const chunk = "y".repeat(entrySize);
		const entries = Array.from({ length: 5 }, (_, i) => ({
			path: `/f${i}`,
			diff: `d${i}`,
			oldText: chunk,
			newText: chunk,
		}));
		const result = pruneOversizedEditSnapshots({ diff: "agg", perFileResults: entries });

		const kept = result.perFileResults!.filter(e => e.oldText !== undefined);
		const pruned = result.perFileResults!.filter(e => e.snapshotsPruned === true);
		expect(kept.length).toBe(2);
		expect(pruned.length).toBe(3);

		const totalKept = result.perFileResults!.reduce(
			(acc, e) => acc + (e.oldText?.length ?? 0) + (e.newText?.length ?? 0),
			0,
		);
		expect(totalKept).toBeLessThanOrEqual(MAX_EDIT_SNAPSHOT_TEXT_CHARS);
		expect(pruned[0]).toMatchObject({ path: "/f2", diff: "d2", snapshotsPruned: true });
	});
});

describe("executePatchSingle on oversized files", () => {
	test("prunes oldText / newText while keeping diff and path", async () => {
		await Bun.write(path.join(tempDir, "big.txt"), `${FILLER}anchor\n${FILLER}`);

		const result = await executePatchSingle({
			session: makeSession(tempDir),
			path: "big.txt",
			params: { op: "update", diff: "@@\n-anchor\n+ANCHOR" },
			allowFuzzy: true,
			fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
			writethrough: writethroughNoop,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		const details = result.details!;
		expect(details.path).toBe(path.join(tempDir, "big.txt"));
		expect(details.diff).toMatch(/-\d+\|anchor/);
		expect(details.diff).toMatch(/\+\d+\|ANCHOR/);
		expect(details.oldText).toBeUndefined();
		expect(details.newText).toBeUndefined();

		expect(JSON.stringify(result).length).toBeLessThan(FILLER.length / 10);
	});
});

describe("executeReplaceSingle on oversized files", () => {
	test("prunes oldText / newText while keeping diff", async () => {
		await Bun.write(path.join(tempDir, "big.txt"), `${FILLER}LINE A\n${FILLER}`);

		const result = await executeReplaceSingle({
			session: makeSession(tempDir),
			path: "big.txt",
			params: { old_text: "LINE A", new_text: "LINE B" },
			allowFuzzy: false,
			fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
			writethrough: writethroughNoop,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		const details = result.details!;
		expect(details.path).toBe(path.join(tempDir, "big.txt"));
		expect(details.oldText).toBeUndefined();
		expect(details.newText).toBeUndefined();
	});
});

describe("EditTool single-path aggregation across mixed-size entries", () => {
	test("pruned first-entry snapshots suppress aggregate snapshots from a later kept entry", async () => {
		await Bun.write(path.join(tempDir, "shrink.txt"), `${FILLER}TAIL\n`);

		const replaceSession = {
			cwd: tempDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			enableLsp: false,
			settings: Settings.isolated({ "edit.mode": "replace" }),
			getArtifactsDir: () => null,
			getSessionId: () => null,
			getPlanModeState: () => undefined,
		} as unknown as ToolSession;
		const tool = new EditTool(replaceSession);

		const result = await tool.execute("call-shrink", {
			path: "shrink.txt",
			edits: [
				{ old_text: FILLER, new_text: "tiny\n" },
				{ old_text: "TAIL", new_text: "DONE" },
			],
		});

		const details = result.details as EditToolDetails;
		expect(details.snapshotsPruned).toBe(true);
		expect(details.oldText).toBeUndefined();
		expect(details.newText).toBeUndefined();
		expect(details.diff.length).toBeGreaterThan(0);
	});
});

describe("executeHashlineSingle multi-section aggregate cap", () => {
	test("strips per-file snapshots once the shared budget is spent", async () => {
		const fileCount = 5;
		const session = {
			cwd: tempDir,
			settings: Settings.isolated(),
		} as unknown as ToolSession;

		const tags: string[] = [];
		const filler = "filler line of content xxxx yyyy zzzz\n".repeat(120);
		for (let i = 0; i < fileCount; i++) {
			const filePath = path.join(tempDir, `f${i}.ts`);
			const source = `header${i}\n${filler}`;
			await Bun.write(filePath, source);
			const tag = getFileSnapshotStore(session).record(canonicalSnapshotKey(filePath), source);
			tags.push(tag);
		}

		const sections = tags.map((tag, i) =>
			[formatHashlineHeader(`f${i}.ts`, tag), "SWAP 1.=1:", `+HEADER${i}`].join("\n"),
		);
		const input = sections.join("\n");

		const result = await executeHashlineSingle({
			session,
			input,
			writethrough: async (targetPath, content) => {
				await Bun.write(targetPath, content);
				return undefined;
			},
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		const details = result.details as EditToolDetails;
		expect(details.perFileResults).toBeDefined();
		expect(details.perFileResults!.length).toBe(fileCount);

		const kept = details.perFileResults!.filter(e => e.oldText !== undefined);
		const pruned = details.perFileResults!.filter(e => e.snapshotsPruned === true);
		expect(kept.length).toBeGreaterThan(0);
		expect(pruned.length).toBeGreaterThan(0);
		expect(kept.length + pruned.length).toBe(fileCount);

		const totalKept = details.perFileResults!.reduce(
			(acc, e) => acc + (e.oldText?.length ?? 0) + (e.newText?.length ?? 0),
			0,
		);
		expect(totalKept).toBeLessThanOrEqual(MAX_EDIT_SNAPSHOT_TEXT_CHARS);
	});
});
```

- [ ] **Step 1.6: Execute snapshot-details tests**

Run: `bun test packages/coding-agent/test/edit-snapshot-details.test.ts`
Expected: PASS

---

## Task 2: Large Session Ctrl+C & Compaction Optimizations

### Files:
- Modify: `packages/coding-agent/src/session/session-manager.ts`
- Create: `packages/coding-agent/test/session-manager/large-session-memory.test.ts`

- [ ] **Step 2.1: Update `packages/coding-agent/src/session/session-manager.ts`**

Modify the session persistence and elision logic:

1. Update `flushSync()` to prevent redundant writes:
```typescript
	flushSync(): void {
		if (!this.#persist || !this.#sessionFile) return;
		if (this.#diskFailure) throw this.#diskFailure;
		if (this.#fileIsCurrent && !this.#rewriteRequired) {
			const writerError = this.#writer?.getError();
			if (writerError) throw writerError;
			return;
		}
		this.#rewriteSynchronously();
		if (this.#diskFailure) throw this.#diskFailure;
	}
```

2. Scopes compaction elision to only the active branch path. Let's redefine `elideSupersededCompactions()` to use `this.#index.pathTo(leafId)`:
```typescript
	#elideSupersededCompactionsOnBranch(leafId: string | null): boolean {
		if (!leafId) return false;
		let changed = false;
		for (const entry of this.#index.pathTo(leafId)) {
			if (entry.type !== "compaction") continue;
			if (
				entry.summary === SUPERSEDED_COMPACTION_SUMMARY &&
				entry.preserveData === undefined
			) {
				continue;
			}
			entry.summary = SUPERSEDED_COMPACTION_SUMMARY;
			entry.preserveData = undefined;
			changed = true;
		}
		return changed;
	}
```

3. Update `#recordEntry()` and `appendCompaction()` calls. Modify `appendCompaction()` to call `#elideSupersededCompactionsOnBranch(this.#index.leafId())`:
```typescript
	appendCompaction(
		summary: string,
		shortSummary?: string,
		firstKeptEntryId?: string | null,
		tokensBefore?: number,
		fromExtension?: boolean,
		preserveData?: Record<string, unknown>,
	): string {
		const elidedSupersededCompactions = this.#elideSupersededCompactionsOnBranch(this.#index.leafId());
		const entry: CompactionEntry<T> = {
			type: "compaction",
			...this.#freshEntryFields(),
			parentId: this.#index.leafId(),
			summary,
			shortSummary,
			firstKeptEntryId,
			tokensBefore,
			preserveData,
		};
		this.#recordEntry(entry);
		if (elidedSupersededCompactions) {
			void this.#rewriteAtomically().catch(err => this.#noteDiskFailure(err));
		}
		return entry.id;
	}
```

4. Scope compaction elisions during initial JSONL file load:
```typescript
// Implement helper functions in session-manager.ts module-level or imported:
function elideCompactionSummary(entry: CompactionEntry | undefined): boolean {
	if (!entry) return false;
	entry.summary = SUPERSEDED_COMPACTION_SUMMARY;
	entry.preserveData = undefined;
	return true;
}

function collectActiveBranchIds(entries: FileEntry[]): Set<string> {
	const byId = new Map<string, SessionEntry>();
	for (const entry of entries) {
		const id = (entry as SessionEntry).id;
		if (typeof id === "string") byId.set(id, entry as SessionEntry);
	}
	const branchIds = new Set<string>();
	let cursor = entries[entries.length - 1] as SessionEntry | undefined;
	while (cursor && typeof cursor.id === "string" && !branchIds.has(cursor.id)) {
		branchIds.add(cursor.id);
		const parentId = cursor.parentId;
		cursor = parentId ? byId.get(parentId) : undefined;
	}
	return branchIds;
}

function elideSupersededCompactionEntries(entries: FileEntry[]): void {
	const branchIds = collectActiveBranchIds(entries);
	let previousCompaction: CompactionEntry | undefined;
	for (const entry of entries) {
		if (entry.type !== "compaction") continue;
		if (!branchIds.has(entry.id)) continue;
		elideCompactionSummary(previousCompaction);
		previousCompaction = entry;
	}
}
```

Update `loadEntriesFromFile()`:
Remove the live-stream-based compaction elision inside `loadEntriesFromFile()`, and call `elideSupersededCompactionEntries(entries)` right before returning `entries` from `loadEntriesFromFile`.

5. Update `collectSessionFromFile()` to support developer messages for forks:
```typescript
if (entry.message.role === "user" || entry.message.role === "assistant" || entry.message.role === "developer") {
	const textContent = extractTextFromContent(entry.message.content);

	if (textContent) {
		allMessages.push(textContent);

		if (!firstMessage && (entry.message.role === "user" || entry.message.role === "developer")) {
			firstMessage = textContent;
		}
	}
}
```

- [ ] **Step 2.2: Create `packages/coding-agent/test/session-manager/large-session-memory.test.ts`**

Write regression tests:

```typescript
import { afterEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@aryee337/aery-ai/models";
import { loadEntriesFromFile } from "@aryee337/aery/session/session-manager";
import { SessionManager } from "@aryee337/aery/session/session-manager";
import { MemorySessionStorage } from "@aryee337/aery/session/session-storage";

class CountingMemorySessionStorage extends MemorySessionStorage {
	writeTextSyncCalls = 0;

	writeTextSync(filePath: string, content: string): void {
		this.writeTextSyncCalls++;
		super.writeTextSync(filePath, content);
	}
}

function makeAssistantMessage(text: string) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: 2,
	};
}

describe("large session memory guards", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(tempDirs.map(dir => fsp.rm(dir, { recursive: true, force: true })));
		tempDirs.length = 0;
	});

	it("does not rewrite an already-current session during sync flush", () => {
		const storage = new CountingMemorySessionStorage();
		const session = SessionManager.create("/work", "/sessions", storage);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage("hi"));

		storage.writeTextSyncCalls = 0;
		session.flushSync();

		expect(storage.writeTextSyncCalls).toBe(0);
	});

	it("elides superseded compactions and rewrites the compacted file", async () => {
		const storage = new CountingMemorySessionStorage();
		const session = SessionManager.create("/work", "/sessions", storage);
		const firstKeptEntryId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage("hi"));

		const firstSummary = `first-${"x".repeat(4096)}`;
		const secondSummary = `second-${"y".repeat(4096)}`;
		session.appendCompaction(firstSummary, undefined, firstKeptEntryId, 1000, undefined, undefined, {
			openaiRemoteCompaction: { provider: "anthropic", replacementHistory: [] },
		});
		session.appendCompaction(secondSummary, undefined, firstKeptEntryId, 1000);
		await session.flush();

		const compactions = session.getEntries().filter(entry => entry.type === "compaction");
		expect(compactions).toHaveLength(2);
		expect(compactions[0]?.summary).not.toBe(firstSummary);
		expect(compactions[0]?.summary).toContain("Superseded compaction");
		expect(compactions[0]?.preserveData).toBeUndefined();
		expect(compactions[1]?.summary).toBe(secondSummary);

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const persisted = await storage.readText(sessionFile);
		expect(persisted).not.toContain(firstSummary);
		expect(persisted).toContain(secondSummary);
	});

	it("streams large session files and keeps only the latest compaction summary", async () => {
		const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "aery-large-session-"));
		tempDirs.push(tempDir);
		const sessionFile = path.join(tempDir, "large.jsonl");
		const oldSummary = `old-${"x".repeat(5 * 1024 * 1024)}`;
		const latestSummary = `latest-${"y".repeat(5 * 1024 * 1024)}`;
		const lines = [
			{ type: "session", version: 3, id: "sess", timestamp: "2026-01-01T00:00:00.000Z", cwd: tempDir },
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "hi", timestamp: 1 },
			},
			{
				type: "compaction",
				id: "c1",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:02.000Z",
				summary: oldSummary,
				firstKeptEntryId: "u1",
				tokensBefore: 1000,
				preserveData: { stale: true },
			},
			{
				type: "message",
				id: "a1",
				parentId: "c1",
				timestamp: "2026-01-01T00:00:03.000Z",
				message: makeAssistantMessage("hello"),
			},
			{
				type: "compaction",
				id: "c2",
				parentId: "a1",
				timestamp: "2026-01-01T00:00:04.000Z",
				summary: latestSummary,
				firstKeptEntryId: "a1",
				tokensBefore: 1000,
			},
		].map(entry => `${JSON.stringify(entry)}\n`);
		await fsp.writeFile(sessionFile, lines.join(""));

		const entries = await loadEntriesFromFile(sessionFile, new CountingMemorySessionStorage());
		const compactions = entries.filter(entry => entry.type === "compaction");

		expect(compactions).toHaveLength(2);
		expect(compactions[0]?.summary).not.toBe(oldSummary);
		expect(compactions[0]?.summary).toContain("Superseded compaction");
		expect(compactions[0]?.preserveData).toBeUndefined();
		expect(compactions[1]?.summary).toBe(latestSummary);
	});

	it("preserves sibling-branch compactions when a newer compaction lands on another branch", async () => {
		const storage = new CountingMemorySessionStorage();
		const session = SessionManager.create("/work", "/sessions", storage);
		const rootId = session.appendMessage({ role: "user", content: "shared root", timestamp: 1 });
		session.appendMessage(makeAssistantMessage("root reply"));

		const branchACompactionSummary = `branch-a-${"x".repeat(1024)}`;
		const branchAPreserve = { openaiRemoteCompaction: { provider: "anthropic", replacementHistory: [] } };
		session.appendCompaction(
			branchACompactionSummary,
			undefined,
			rootId,
			1000,
			undefined,
			undefined,
			branchAPreserve,
		);
		const branchACompactionId = session.getLeafId();
		if (!branchACompactionId) throw new Error("Expected branch A compaction id");

		session.branch(rootId);
		session.appendMessage(makeAssistantMessage("branch B reply"));
		const branchBCompactionSummary = `branch-b-${"y".repeat(1024)}`;
		session.appendCompaction(branchBCompactionSummary, undefined, rootId, 1000);

		const branchACompaction = session.getEntry(branchACompactionId);
		if (branchACompaction?.type !== "compaction") throw new Error("Expected sibling compaction entry");
		expect(branchACompaction.summary).toBe(branchACompactionSummary);
		expect(branchACompaction.preserveData).toEqual(branchAPreserve);

		const branchBCompactions = session
			.getEntries()
			.filter(entry => entry.type === "compaction" && entry.summary === branchBCompactionSummary);
		expect(branchBCompactions).toHaveLength(1);
	});

	it("only elides loaded compactions on the active branch", async () => {
		const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "aery-branch-load-"));
		tempDirs.push(tempDir);
		const sessionFile = path.join(tempDir, "branched.jsonl");
		const branchASummary = `branch-a-${"x".repeat(1024)}`;
		const branchBOldSummary = `branch-b-old-${"y".repeat(1024)}`;
		const branchBNewSummary = `branch-b-new-${"z".repeat(1024)}`;
		const lines = [
			{ type: "session", version: 3, id: "sess", timestamp: "2026-01-01T00:00:00.000Z", cwd: tempDir },
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "shared", timestamp: 1 },
			},
			{
				type: "compaction",
				id: "ca",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:02.000Z",
				summary: branchASummary,
				firstKeptEntryId: "u1",
				tokensBefore: 1000,
				preserveData: { openaiRemoteCompaction: { provider: "anthropic", replacementHistory: [] } },
			},
			{
				type: "compaction",
				id: "cb1",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:03.000Z",
				summary: branchBOldSummary,
				firstKeptEntryId: "u1",
				tokensBefore: 1000,
				preserveData: { stale: true },
			},
			{
				type: "message",
				id: "a1",
				parentId: "cb1",
				timestamp: "2026-01-01T00:00:04.000Z",
				message: makeAssistantMessage("branch b reply"),
			},
			{
				type: "compaction",
				id: "cb2",
				parentId: "a1",
				timestamp: "2026-01-01T00:00:05.000Z",
				summary: branchBNewSummary,
				firstKeptEntryId: "a1",
				tokensBefore: 1000,
			},
		].map(entry => `${JSON.stringify(entry)}\n`);
		await fsp.writeFile(sessionFile, lines.join(""));

		const entries = await loadEntriesFromFile(sessionFile, new CountingMemorySessionStorage());
		const byId = new Map(entries.map(entry => [(entry as { id?: string }).id, entry] as const));
		const branchA = byId.get("ca");
		const branchBOld = byId.get("cb1");
		const branchBNew = byId.get("cb2");
		if (branchA?.type !== "compaction" || branchBOld?.type !== "compaction" || branchBNew?.type !== "compaction") {
			throw new Error("Expected compaction entries");
		}

		expect(branchA.summary).toBe(branchASummary);
		expect(branchA.preserveData).toBeDefined();
		expect(branchBOld.summary).toContain("Superseded compaction");
		expect(branchBOld.preserveData).toBeUndefined();
		expect(branchBNew.summary).toBe(branchBNewSummary);
	});

	it("uses developer prefix text when a fork has no early user message", async () => {
		const storage = new MemorySessionStorage();
		const sessionDir = "/sessions/project";
		const sessionFile = `${sessionDir}/fork.jsonl`;
		const lines = [
			{ type: "session", version: 3, id: "fork", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/work" },
			{
				type: "message",
				id: "d1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "developer", content: "Plan fork context", timestamp: 1 },
			},
		].map(entry => `${JSON.stringify(entry)}\n`);
		storage.writeTextSync(sessionFile, lines.join(""));

		const sessions = await SessionManager.list("/work", sessionDir, storage);

		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.firstMessage).toBe("Plan fork context");
	});
});
```

- [ ] **Step 2.3: Execute large-session-memory tests**

Run: `bun test packages/coding-agent/test/session-manager/large-session-memory.test.ts`
Expected: PASS
