# Live Compaction, Image-Generator Subagent, Video & Eye Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port Google Antigravity's live conversation compaction (compacting while working without stopping), built-in `image-generator` subagent with 3-attempt self-inspection loop, video file inspection/keyframe analysis, and enhanced desktop "eye" (`live_eye`) perception into Aery.

**Architecture:** 
1. Live Compaction: decouple compaction from session abortion by snapshotting historical prefixes, running summarization in an asynchronous background worker, and atomically rebasing the compacted prefix into the live session without halting tool execution.
2. Image & Video: register the built-in `image-generator` subagent in `AgentRegistry` with a multi-attempt inspection loop and artifact persistence; add video metadata and keyframe extraction in `inspect-image.ts` / `read.ts`.
3. Eye Perception: configure `focusFirst: true` as the smart default for `live_eye`, enforce ephemeral context glance sweeping, and ensure word-level click target anchoring.

**Tech Stack:** TypeScript, Bun, Bun Test, `@aryee337/aery-core`, `@aryee337/aery-ai`, Zod, Tesseract OCR.

---

### Task 1: Non-Blocking Live Background Prefix Compaction

**Files:**
- Modify: `packages/coding-agent/src/session/agent-session.ts`
- Test: `packages/coding-agent/test/live-background-compaction.test.ts`

- [ ] **Step 1: Write the failing unit test for non-blocking prefix compaction**

```typescript
// packages/coding-agent/test/live-background-compaction.test.ts
import { describe, expect, it } from "bun:test";
import { AgentSession } from "../src/session/agent-session";

describe("Live Background Prefix Compaction", () => {
	it("executes background compaction without aborting the active agent loop", async () => {
		// Test that compactBackgroundPrefix snapshots prefix, allows live messages,
		// and rebases upon completion.
		expect(typeof (AgentSession.prototype as any).compactBackgroundPrefix).toBe("function");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/aryee/aery/ai_agent/aery/packages/coding-agent && bun test test/live-background-compaction.test.ts`
Expected: FAIL with `compactBackgroundPrefix is not a function`

- [ ] **Step 3: Implement `compactBackgroundPrefix` in `agent-session.ts`**

Add `#isCompactingInBackground` flag, `#backgroundCompactionPromise`, and `compactBackgroundPrefix()`:
1. Clones prefix entries up to the current turn boundary without invoking `this.abort()`.
2. Dispatches summarization in an unblocked background promise.
3. Upon summary completion, atomically splices compacted summary at the prefix boundary in `sessionManager` and rebases `this.agent.replaceMessages()` with the new compacted summary plus any newly generated messages.
4. Emits `session_compacted` and updates token count.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/aryee/aery/ai_agent/aery/packages/coding-agent && bun test test/live-background-compaction.test.ts`
Expected: PASS (1 pass, 0 fail)

- [ ] **Step 5: Commit**

```bash
cd /home/aryee/aery/ai_agent/aery
git add packages/coding-agent/src/session/agent-session.ts packages/coding-agent/test/live-background-compaction.test.ts
git commit -m "feat(compaction): implement non-blocking live background prefix compaction"
```

---

### Task 2: Built-in `image-generator` Subagent with Self-Inspection Loop

**Files:**
- Modify: `packages/coding-agent/src/registry/builtin-subagents.ts` (or `subagent-definitions.ts`)
- Modify: `packages/coding-agent/src/tools/manage-subagents.ts`
- Test: `packages/coding-agent/test/image-generator-subagent.test.ts`

- [ ] **Step 1: Write the failing test for `image-generator` subagent definition**

```typescript
// packages/coding-agent/test/image-generator-subagent.test.ts
import { describe, expect, it } from "bun:test";
import { getBuiltinSubagentDefinition } from "../src/registry/builtin-subagents";

describe("Built-in image-generator Subagent", () => {
	it("defines image-generator with self-inspection loop and artifact writing", () => {
		const def = getBuiltinSubagentDefinition("image-generator");
		expect(def).toBeDefined();
		expect(def?.role).toContain("Image");
		expect(def?.systemPrompt).toContain("image_gen");
		expect(def?.systemPrompt).toContain("attempts");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/aryee/aery/ai_agent/aery/packages/coding-agent && bun test test/image-generator-subagent.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement built-in `image-generator` subagent definition**

1. Create/update `packages/coding-agent/src/registry/builtin-subagents.ts` exporting `getBuiltinSubagentDefinition` and the builtin definitions (`self`, `research`, `image-generator`).
2. Provide the system prompt for `image-generator`:
   - Decomposes briefs into high-fidelity parameters: subject, action, scene, lighting, composition, style.
   - Calls `image_gen`.
   - Inspects generated output using `inspect_image` to verify against prompt constraints (up to 3 attempts).
   - Writes final image into `<artifactDir>/images/` and outputs markdown artifact preview `![image](file:///...)`.
3. Wire `getBuiltinSubagentDefinition` into `manage-subagents.ts` and `AgentRegistry`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/aryee/aery/ai_agent/aery/packages/coding-agent && bun test test/image-generator-subagent.test.ts`
Expected: PASS (1 pass, 0 fail)

- [ ] **Step 5: Commit**

```bash
cd /home/aryee/aery/ai_agent/aery
git add packages/coding-agent/src/registry/ packages/coding-agent/src/tools/manage-subagents.ts packages/coding-agent/test/image-generator-subagent.test.ts
git commit -m "feat(subagents): add built-in image-generator subagent with 3-attempt inspection loop"
```

---

### Task 3: Video File Inspection & Audio Ingestion

**Files:**
- Modify: `packages/coding-agent/src/tools/inspect-image.ts`
- Modify: `packages/coding-agent/src/tools/read.ts`
- Test: `packages/coding-agent/test/video-inspection.test.ts`

- [ ] **Step 1: Write the failing test for video and audio format inspection**

```typescript
// packages/coding-agent/test/video-inspection.test.ts
import { describe, expect, it } from "bun:test";
import { isVideoOrAudioExtension, inspectMediaMetadata } from "../src/tools/inspect-image";

describe("Video and Audio File Inspection", () => {
	it("identifies supported video and audio extensions", () => {
		expect(isVideoOrAudioExtension("recording.mp4")).toBe(true);
		expect(isVideoOrAudioExtension("clip.webm")).toBe(true);
		expect(isVideoOrAudioExtension("voice.m4a")).toBe(true);
		expect(isVideoOrAudioExtension("document.txt")).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/aryee/aery/ai_agent/aery/packages/coding-agent && bun test test/video-inspection.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement video/audio detection and inspection**

1. In `inspect-image.ts`, export `isVideoOrAudioExtension` and `inspectMediaMetadata`.
2. Support extensions: `.mp4`, `.mov`, `.webm`, `.ogv`, `.mkv`, `.mp3`, `.m4a`, `.wav`, `.opus`, `.ogg`.
3. In `read.ts`, when encountering a video or audio file:
   - Provide structured media metadata (dimensions, duration, codecs, bitrate).
   - If `ffmpeg` is available on the machine, extract keyframes and attach them so vision models can inspect video progression visually.
   - If ffmpeg is absent, report clear media metadata without hanging or throwing raw binary errors.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/aryee/aery/ai_agent/aery/packages/coding-agent && bun test test/video-inspection.test.ts`
Expected: PASS (1 pass, 0 fail)

- [ ] **Step 5: Commit**

```bash
cd /home/aryee/aery/ai_agent/aery
git add packages/coding-agent/src/tools/inspect-image.ts packages/coding-agent/src/tools/read.ts packages/coding-agent/test/video-inspection.test.ts
git commit -m "feat(media): add video inspection, keyframe extraction, and audio metadata handling"
```

---

### Task 4: Desktop "Eye" (`live_eye`) Focus-First & Ephemeral Sweeping Parity

**Files:**
- Modify: `packages/coding-agent/src/tools/desktop-control.ts`
- Modify: `packages/coding-agent/src/tools/live-eye.ts`
- Test: `packages/coding-agent/test/live-eye-enhancements.test.ts`

- [ ] **Step 1: Write the failing test for `live_eye` focus-first default and ephemeral sweeping**

```typescript
// packages/coding-agent/test/live-eye-enhancements.test.ts
import { describe, expect, it } from "bun:test";
import { resolveLiveEyeTarget } from "../src/tools/desktop-control";

describe("Desktop live_eye Enhancements", () => {
	it("resolves focusFirst correctly when window target is omitted", () => {
		const target = resolveLiveEyeTarget({ target: "fullscreen", focusFirst: true, focusedWindow: "Terminal" });
		expect(target.mode).toBe("focused_window");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/aryee/aery/ai_agent/aery/packages/coding-agent && bun test test/live-eye-enhancements.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `resolveLiveEyeTarget` and ephemeral sweep verification**

1. In `desktop-control.ts`, expose and refine `resolveLiveEyeTarget` to ensure focus-first window framing defaults smoothly when an application is active.
2. Enforce ephemeral sweeping: prior `live_eye` reading blocks in conversation context are purged on new glance, keeping context lean.
3. Validate semantic click-target OCR cache integration.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/aryee/aery/ai_agent/aery/packages/coding-agent && bun test test/live-eye-enhancements.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /home/aryee/aery/ai_agent/aery
git add packages/coding-agent/src/tools/desktop-control.ts packages/coding-agent/src/tools/live-eye.ts packages/coding-agent/test/live-eye-enhancements.test.ts
git commit -m "feat(desktop): optimize live_eye with focus-first window framing and ephemeral context sweeping"
```

---

### Task 5: End-to-End Verification and Push

**Files:**
- Run all test suites: `bun test` in `packages/coding-agent`
- Run typecheck: `bunx tsc --noEmit`
- Push to remote `origin/main`

- [ ] **Step 1: Run full test battery**
Run: `cd /home/aryee/aery/ai_agent/aery/packages/coding-agent && bun test test/live-background-compaction.test.ts test/image-generator-subagent.test.ts test/video-inspection.test.ts test/live-eye-enhancements.test.ts`
Expected: ALL PASS

- [ ] **Step 2: Run TypeScript strict check**
Run: `cd /home/aryee/aery/ai_agent/aery/packages/coding-agent && bunx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 3: Push commits to GitHub**
Run: `cd /home/aryee/aery/ai_agent/aery && git push origin main`
Expected: Successful push to origin/main
