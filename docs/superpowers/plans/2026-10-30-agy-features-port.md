# Antigravity (`agy`) Feature Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port Google Antigravity (`agy`)'s three remaining core capabilities into Aery:
1. Promote `/btw` side-questions directly into the primary conversation with the exact agy banner.
2. Complete the Subagent Orchestration engine with `invoke_subagent` and `send_message` tools using the built-in subagent definitions (`research`, `self`, `image-generator`).
3. Complete Artifact System parity with `ArtifactMetadata` support in `edit-file.ts` and interactive `[Proceed]` feedback checkpoints.

**Architecture:** 
- Modular TypeScript running on Bun.
- `/btw` promotion delegates to `AgentSession.promoteSideQuestion()`, injecting the exact agy banner `This conversation was promoted from a side question (/btw); the side-question guardrail above no longer applies.`, appending the user turn and assistant reply to the session manager, and notifying the TUI.
- Subagent orchestration introduces `InvokeSubagentTool` and `SendMessageTool` to instantiate and communicate with child sessions tracked in `AgentRegistry`.
- Artifacts parity adds `ArtifactMetadata` schema to `edit-file.ts`, syncs updates to `ArtifactStore`, and adds an interactive `Proceed` button component.

**Tech Stack:** Bun, TypeScript, `@aryee337/aery-tui`, `@aryee337/aery-core`, `@aryee337/aery-ai`.

---

## Task 1: Promote `/btw` Side-Question to Main Conversation

**Files:**
- Modify: `packages/coding-agent/src/session/agent-session.ts`
- Modify: `packages/coding-agent/src/modes/controllers/btw-controller.ts`
- Modify: `packages/coding-agent/src/modes/components/btw-panel.ts`
- Modify: `packages/coding-agent/src/modes/controllers/command-controller.ts`
- Modify: `packages/coding-agent/src/slash-commands/builtin-registry.ts`
- Test: `packages/coding-agent/test/modes/controllers/btw-promote.test.ts`

- [ ] **Step 1: Write the failing test for `/btw` promotion**

```typescript
// packages/coding-agent/test/modes/controllers/btw-promote.test.ts
import { describe, expect, it, vi } from "bun:test";
import { BtwController } from "@aryee337/aery/modes/controllers/btw-controller";
import { Container, type TUI } from "@aryee337/aery-tui";
import type { InteractiveModeContext } from "@aryee337/aery/modes/types";

describe("BtwController.promote", () => {
	it("promotes the active or last /btw answer into the main conversation with the agy banner", async () => {
		const promoteSideQuestion = vi.fn();
		const ctx = {
			ui: { requestRender: vi.fn() } as unknown as TUI,
			btwContainer: new Container(),
			session: {
				model: { provider: "anthropic", id: "claude-sonnet-4-5" },
				promoteSideQuestion,
			},
			showStatus: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;

		const controller = new BtwController(ctx);
		controller.cacheAnswerForTest?.("How do tokens scale?", "Tokens scale linearly.");

		const result = await controller.promote();
		expect(result).toBe(true);
		expect(promoteSideQuestion).toHaveBeenCalledWith({
			question: "How do tokens scale?",
			answer: "Tokens scale linearly.",
		});
		expect(ctx.showStatus).toHaveBeenCalledWith("Promoted /btw response to main conversation.");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/aryee/aery/ai_agent/aery/packages/coding-agent && bun test test/modes/controllers/btw-promote.test.ts`
Expected: FAIL (promote method not defined)

- [ ] **Step 3: Implement `promoteSideQuestion` on `AgentSession` and `promote()` on `BtwController`**

In `AgentSession`:
```typescript
async promoteSideQuestion(args: { question: string; answer: string }): Promise<void> {
    const BANNER = "This conversation was promoted from a side question (/btw); the side-question guardrail above no longer applies.";
    const userMsg: UserMessage = {
        role: "user",
        content: [{ type: "text", text: args.question }],
        timestamp: Date.now(),
    };
    const assistantMsg: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: `${BANNER}\n\n${args.answer}` }],
        api: "anthropic-messages",
        provider: this.model?.provider ?? "anthropic",
        model: this.model?.id ?? "promoted-btw",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
    };

    this.sessionManager.appendMessage(userMsg);
    this.sessionManager.appendMessage(assistantMsg);
    this.agent.appendMessage(userMsg);
    this.agent.appendMessage(assistantMsg);
    await this.#emitSessionEvent({ type: "session_change" });
}
```

In `BtwController`:
- Store `#lastQuestion: string | undefined`.
- Add `promote(): Promise<boolean>`.
- Wire `P` key in `BtwPanelComponent` to trigger `onPromote`.
- Wire `/btw promote` and `/promote` slash command.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/aryee/aery/ai_agent/aery/packages/coding-agent && bun test test/modes/controllers/btw-promote.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/session/agent-session.ts packages/coding-agent/src/modes/controllers/btw-controller.ts packages/coding-agent/src/modes/components/btw-panel.ts packages/coding-agent/test/modes/controllers/btw-promote.test.ts
git commit -m "feat(/btw): add promotion to main conversation with exact agy banner"
```

---

## Task 2: Subagent Orchestration Engine (`invoke_subagent` & `send_message`)

**Files:**
- Create: `packages/coding-agent/src/tools/invoke-subagent.ts`
- Create: `packages/coding-agent/src/tools/send-message.ts`
- Modify: `packages/coding-agent/src/tools/index.ts`
- Test: `packages/coding-agent/test/tools/invoke-subagent.test.ts`

- [ ] **Step 1: Write the failing tests for `invoke_subagent` and `send_message`**

```typescript
// packages/coding-agent/test/tools/invoke-subagent.test.ts
import { describe, expect, it } from "bun:test";
import { InvokeSubagentTool } from "@aryee337/aery/tools/invoke-subagent";
import { SendMessageTool } from "@aryee337/aery/tools/send-message";

describe("InvokeSubagentTool", () => {
	it("validates parameters matching agy schema and instantiates subagent", async () => {
		const tool = new InvokeSubagentTool();
		expect(tool.name).toBe("invoke_subagent");
		const params = {
			TypeName: "research",
			Role: "Codebase Researcher",
			Prompt: "Inspect authentication flow in auth.ts",
		};
		const result = await tool.execute("call-1", params);
		expect(result.isError).toBe(false);
		expect(result.content[0].text).toContain("Subagent invoked successfully");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/aryee/aery/ai_agent/aery/packages/coding-agent && bun test test/tools/invoke-subagent.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `InvokeSubagentTool` and `SendMessageTool`**

In `invoke-subagent.ts`:
- Match agy schema: `TypeName`, `Role`, `Prompt`, `Model` (optional), `Workspace` (optional).
- Look up `BuiltinSubagentDefinition` via `getBuiltinSubagentDefinition(params.TypeName)`.
- Register the child conversation in `AgentRegistry`.
- Return the child conversationId for future `send_message` calls.

In `send-message.ts`:
- Match agy schema: `Recipient`, `Message`.
- Forward message to registered conversationId.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/aryee/aery/ai_agent/aery/packages/coding-agent && bun test test/tools/invoke-subagent.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/tools/invoke-subagent.ts packages/coding-agent/src/tools/send-message.ts packages/coding-agent/src/tools/index.ts packages/coding-agent/test/tools/invoke-subagent.test.ts
git commit -m "feat(subagents): add invoke_subagent and send_message tools matching agy schema"
```

---

## Task 3: Artifact Parity in `edit-file.ts` & Interactive Proceed Feedback Checkpoint

**Files:**
- Modify: `packages/coding-agent/src/tools/edit-file.ts`
- Modify: `packages/coding-agent/src/artifacts/artifact-store.ts`
- Test: `packages/coding-agent/test/tools/edit-file-artifact.test.ts`

- [ ] **Step 1: Write the failing test for `ArtifactMetadata` on `edit-file.ts`**

```typescript
// packages/coding-agent/test/tools/edit-file-artifact.test.ts
import { describe, expect, it } from "bun:test";
import { EditFileTool } from "@aryee337/aery/tools/edit-file";
import { ArtifactStore } from "@aryee337/aery/artifacts/artifact-store";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

describe("EditFileTool with ArtifactMetadata", () => {
	it("updates artifact metadata when editing an artifact in the artifact directory", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-test-"));
		const store = new ArtifactStore(tempDir);
		const initial = await store.saveArtifact("plan", "# Initial Plan\nStep 1", { summary: "Initial summary" });

		const tool = new EditFileTool();
		await tool.execute("call-1", {
			Path: initial.path,
			Target: "Step 1",
			Replacement: "Step 1 (completed)",
			ArtifactMetadata: {
				Summary: "Updated summary with step 1 complete",
				RequestFeedback: true,
				UserFacing: true,
			},
		});

		const updated = await store.getArtifact("plan");
		expect(updated?.content).toContain("Step 1 (completed)");
		expect(updated?.metadata.summary).toBe("Updated summary with step 1 complete");
		expect(updated?.metadata.requestFeedback).toBe(true);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/aryee/aery/ai_agent/aery/packages/coding-agent && bun test test/tools/edit-file-artifact.test.ts`
Expected: FAIL (ArtifactMetadata not accepted or not synced)

- [ ] **Step 3: Update `edit-file.ts` schema and implementation**

- Add `ArtifactMetadata` / `artifactMetadata` to `edit-file.ts` zod schema.
- When path is in an artifact directory or matches an artifact, update `.meta.json` via `ArtifactStore`.
- Return `artifact` details in result.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/aryee/aery/ai_agent/aery/packages/coding-agent && bun test test/tools/edit-file-artifact.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/tools/edit-file.ts packages/coding-agent/test/tools/edit-file-artifact.test.ts
git commit -m "feat(artifacts): support ArtifactMetadata updates in edit-file matching agy specification"
```
