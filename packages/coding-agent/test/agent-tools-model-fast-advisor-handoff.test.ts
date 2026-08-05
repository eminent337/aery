import { describe, expect, it } from "bun:test";
import type { ToolSession } from "@aryee337/aery/tools";
import { AdvisorTool } from "@aryee337/aery/tools/advisor";
import { HandoffTool } from "@aryee337/aery/tools/handoff";
import { SetFastTool } from "@aryee337/aery/tools/set-fast";
import { SetModelTool } from "@aryee337/aery/tools/set-model";
import { ToolError } from "@aryee337/aery/tools/tool-errors";
import type { AgentToolResult } from "@aryee337/aery-core";

function text(result: AgentToolResult | undefined): string {
	return (result?.content ?? [])
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

function baseSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		...overrides,
	} as ToolSession;
}

describe("set_model tool", () => {
	it("switches model temporarily (session-scoped) by default", async () => {
		const tool = new SetModelTool(
			baseSession({
				getModelState: () => ({ currentModel: "a/x", available: ["a/x", "b/y"], roles: ["default"] }),
				setModel: async params => {
					expect(params.model).toBe("b/y");
					expect(params.persist).toBeUndefined();
					return { applied: "b/y", persisted: false, nextTurn: true };
				},
			}),
		);
		const result = await tool.execute("call_1", { model: "b/y" });
		expect(text(result)).toContain("Model switched to b/y");
		expect(text(result)).toContain("session-scoped");
		expect(result.details).toEqual({ applied: "b/y", persisted: false, nextTurn: true });
	});

	it("persists when persist is set", async () => {
		const tool = new SetModelTool(
			baseSession({
				setModel: async params => {
					expect(params.persist).toBe(true);
					return { applied: "b/y", role: "default", persisted: true, nextTurn: true };
				},
			}),
		);
		const result = await tool.execute("call_1", { model: "b/y", persist: true });
		expect(text(result)).toContain("Assignment persisted to settings.");
	});

	it("throws ToolError when the hook is unavailable", async () => {
		const tool = new SetModelTool(baseSession());
		await expect(tool.execute("call_1", { model: "b/y" })).rejects.toThrow(ToolError);
	});

	it("wraps session errors as ToolError", async () => {
		const tool = new SetModelTool(
			baseSession({
				setModel: async () => {
					throw new Error("No API key for a/x");
				},
			}),
		);
		await expect(tool.execute("call_1", { model: "a/x" })).rejects.toThrow("No API key for a/x");
	});
});

describe("set_fast tool", () => {
	it("reports status without changing when enabled is omitted", async () => {
		const tool = new SetFastTool(
			baseSession({
				getFastModeState: () => ({
					enabled: true,
					active: true,
					serviceTier: "priority",
					model: "a/x",
				}),
			}),
		);
		const result = await tool.execute("call_1", {});
		expect(text(result)).toContain("Enabled (setting): yes");
		expect(text(result)).toContain("Active (current model/provider): yes");
	});

	it("warns when enabled but not active for the current provider", async () => {
		const tool = new SetFastTool(
			baseSession({
				getFastModeState: () => ({ enabled: true, active: false, model: "a/x" }),
				setFastMode: () => {},
			}),
		);
		const result = await tool.execute("call_1", { enabled: true });
		expect(text(result)).toContain("not active for the current model/provider");
	});
});

describe("advisor tool", () => {
	it("disables the advisor and reports state", async () => {
		const tool = new AdvisorTool(
			baseSession({
				getAdvisorState: () => ({
					configured: false,
					active: false,
					status: "Advisor is disabled.",
					history: null,
				}),
				setAdvisorEnabled: enabled => {
					expect(enabled).toBe(false);
					return false;
				},
			}),
		);
		const result = await tool.execute("call_1", { action: "disable" });
		expect(text(result)).toContain("Advisor disabled.");
		expect(text(result)).toContain("Advisor is disabled.");
	});

	it("dumps history when requested", async () => {
		const tool = new AdvisorTool(
			baseSession({
				getAdvisorState: options => ({
					configured: true,
					active: true,
					status: "Advisor is enabled (a/x).",
					history: options?.history ? "advisor transcript" : null,
				}),
			}),
		);
		const result = await tool.execute("call_1", { action: "dump" });
		expect(text(result)).toContain("advisor transcript");
	});
});

describe("handoff tool", () => {
	const session = (overrides: Partial<ToolSession> = {}): ToolSession =>
		baseSession({
			getHandoffState: () => ({ isGenerating: false, messageCount: 5 }),
			handoff: async instructions => {
				expect(instructions).toBe("hand to successor");
				return { document: "# handoff", savedPath: "/tmp/handoff.md" };
			},
			...overrides,
		});

	it("is permission-gated (write tier with override)", () => {
		const tool = new HandoffTool(session());
		const decision = (tool.approval as (args?: unknown) => { tier: string; override?: boolean })(undefined);
		expect(decision.tier).toBe("write");
		expect(decision.override).toBe(true);
	});

	it("executes a handoff and reports the saved path", async () => {
		const tool = new HandoffTool(session());
		const result = await tool.execute("call_1", { customInstructions: "hand to successor" });
		expect(text(result)).toContain("Handoff complete.");
		expect(text(result)).toContain("/tmp/handoff.md");
		expect(result.details).toEqual({ document: "# handoff", savedPath: "/tmp/handoff.md" });
	});

	it("refuses with fewer than 2 messages", async () => {
		const tool = new HandoffTool(session({ getHandoffState: () => ({ isGenerating: false, messageCount: 1 }) }));
		await expect(tool.execute("call_1", { customInstructions: "x" })).rejects.toThrow(/fewer than 2 messages/);
	});

	it("refuses while a handoff is already generating", async () => {
		const tool = new HandoffTool(session({ getHandoffState: () => ({ isGenerating: true, messageCount: 5 }) }));
		await expect(tool.execute("call_1", { customInstructions: "x" })).rejects.toThrow(/already in progress/);
	});

	it("refuses consecutive handoffs with no new work", async () => {
		const tool = new HandoffTool(
			session({
				getHandoffState: () => ({
					isGenerating: false,
					messageCount: 2,
					lastHandoffText: "Handoff complete.",
				}),
			}),
		);
		await expect(tool.execute("call_1", { customInstructions: "x" })).rejects.toThrow(/just completed/);
	});
});
