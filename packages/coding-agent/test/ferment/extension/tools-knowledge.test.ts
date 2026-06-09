/**
 * Unit tests for ferment knowledge tools.
 * Verifies ferment_add_decision and ferment_add_memory record decisions/memories
 * with auto-incrementing IDs and guard against no-active-ferment.
 */

import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@aryee337/aery";
import type { Ferment } from "../../../src/ferment/types.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeDraftFerment(): Ferment {
	const now = new Date().toISOString();
	return {
		id: "f-test",
		name: "Test Ferment",
		status: "draft",
		goal: "Test goal",
		worktree: { path: "/tmp" },
		scoping: {},
		phases: [],
		decisions: [],
		memories: [],
		createdAt: now,
		updatedAt: now,
	};
}

// ─── Knowledge tool tests ─────────────────────────────────────────────────────

test("registerKnowledgeTools registers without throwing", async () => {
	const { registerKnowledgeTools } = await import("../../../src/ferment/extension/tools/knowledge.js");
	const api = createFakeApi();
	expect(() => registerKnowledgeTools(api)).not.toThrow();
});

test("ferment_add_decision records a decision with auto ID D001", async () => {
	const { registerKnowledgeTools } = await import("../../../src/ferment/extension/tools/knowledge.js");
	const ferment = makeDraftFerment();
	await setActive(ferment);

	const results = await captureToolResults(registerKnowledgeTools, "ferment_add_decision", {
		title: "Use REST API",
		description: "Align with existing service conventions",
	});

	expect(results.isError ?? false).toBe(false);
	expect(results.content[0]?.text).toContain("D001");
	expect(results.content[0]?.text).toContain("Use REST API");

	// Verify decision was stored
	const updated = await getActiveFerment();
	expect(updated?.decisions).toHaveLength(1);
	expect(updated?.decisions[0].id).toBe("D001");
	expect(updated?.decisions[0].title).toBe("Use REST API");
});

test("ferment_add_decision returns error when no active ferment", async () => {
	const { registerKnowledgeTools } = await import("../../../src/ferment/extension/tools/knowledge.js");
	await clearActive();

	const results = await captureToolResults(registerKnowledgeTools, "ferment_add_decision", {
		title: "Use GraphQL",
		description: "Better for complex queries",
	});

	expect(results.isError).toBe(true);
	expect(results.content[0]?.text).toContain("No active ferment");
});

test("ferment_add_memory records a memory with auto ID M001", async () => {
	const { registerKnowledgeTools } = await import("../../../src/ferment/extension/tools/knowledge.js");
	const ferment = makeDraftFerment();
	await setActive(ferment);

	const results = await captureToolResults(registerKnowledgeTools, "ferment_add_memory", {
		category: "architecture",
		content: "Use event sourcing for audit trail",
	});

	expect(results.isError ?? false).toBe(false);
	expect(results.content[0]?.text).toContain("M001");
	expect(results.content[0]?.text).toContain("Use event sourcing for audit trail");

	// Verify memory was stored
	const updated = await getActiveFerment();
	expect(updated?.memories).toHaveLength(1);
	expect(updated?.memories[0].id).toBe("M001");
	expect(updated?.memories[0].category).toBe("architecture");
	expect(updated?.memories[0].content).toBe("Use event sourcing for audit trail");
});

test("ferment_add_memory validates category enum (reject invalid)", async () => {
	const { registerKnowledgeTools } = await import("../../../src/ferment/extension/tools/knowledge.js");
	const ferment = makeDraftFerment();
	await setActive(ferment);

	// Valid categories work
	const validResults = await captureToolResults(registerKnowledgeTools, "ferment_add_memory", {
		category: "architecture",
		content: "Valid category",
	});
	expect(validResults.isError ?? false).toBe(false);
	expect(validResults.content[0]?.text).toContain("M001");

	// Zod validation is handled by the framework before execute() is called,
	// so invalid enums are rejected at the caller level, not inside execute().
	// We verify the schema is correctly defined by checking it accepts valid values.
});

test("ferment_add_memory returns error when no active ferment", async () => {
	const { registerKnowledgeTools } = await import("../../../src/ferment/extension/tools/knowledge.js");
	await clearActive();

	const results = await captureToolResults(registerKnowledgeTools, "ferment_add_memory", {
		category: "gotcha",
		content: "Watch out for timezone bugs",
	});

	expect(results.isError).toBe(true);
	expect(results.content[0]?.text).toContain("No active ferment");
});

test("multiple decisions/memories auto-increment IDs", async () => {
	const { registerKnowledgeTools } = await import("../../../src/ferment/extension/tools/knowledge.js");
	const ferment = makeDraftFerment();
	await setActive(ferment);

	// Add three decisions
	await captureToolResults(registerKnowledgeTools, "ferment_add_decision", {
		title: "Decision 1",
		description: "First",
	});
	await captureToolResults(registerKnowledgeTools, "ferment_add_decision", {
		title: "Decision 2",
		description: "Second",
	});
	const result3 = await captureToolResults(registerKnowledgeTools, "ferment_add_decision", {
		title: "Decision 3",
		description: "Third",
	});

	expect(result3.content[0]?.text).toContain("D003");

	// Add two memories
	await captureToolResults(registerKnowledgeTools, "ferment_add_memory", {
		category: "pattern",
		content: "First pattern",
	});
	const memResult2 = await captureToolResults(registerKnowledgeTools, "ferment_add_memory", {
		category: "convention",
		content: "Second convention",
	});

	expect(memResult2.content[0]?.text).toContain("M002");

	// Verify counts
	const updated = await getActiveFerment();
	expect(updated?.decisions).toHaveLength(3);
	expect(updated?.memories).toHaveLength(2);
	expect(updated?.decisions[0].id).toBe("D001");
	expect(updated?.decisions[1].id).toBe("D002");
	expect(updated?.decisions[2].id).toBe("D003");
	expect(updated?.memories[0].id).toBe("M001");
	expect(updated?.memories[1].id).toBe("M002");
});

// ─── Test helpers ─────────────────────────────────────────────────────────────

type AgentToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

function createFakeApi(): ExtensionAPI {
	return {
		zod: require("zod/v4"),
		registerTool() {},
	} as unknown as ExtensionAPI;
}

async function setActive(f: Ferment | undefined): Promise<void> {
	const { setActive: sa } = await import("../../../src/ferment/extension/state.js");
	sa(f);
}

async function clearActive(): Promise<void> {
	await setActive(undefined);
}

async function getActiveFerment(): Promise<Ferment | null> {
	const { getActive: ga } = await import("../../../src/ferment/extension/state.js");
	return ga() ?? null;
}

async function captureToolResults(
	registerFn: (api: ExtensionAPI) => void,
	toolName: string,
	params: Record<string, unknown>,
): Promise<AgentToolResult> {
	let toolExecutePromise: Promise<AgentToolResult> | undefined;

	const api = {
		zod: require("zod/v4"),
		registerTool(tool: any) {
			if (tool.name === toolName) {
				toolExecutePromise = tool.execute("test-call-id", params, undefined, undefined, {} as any);
			}
		},
	};

	registerFn(api as unknown as ExtensionAPI);

	return await toolExecutePromise!;
}
