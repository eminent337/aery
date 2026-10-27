import { describe, expect, it } from "bun:test";
import { AgentRegistry } from "../../registry/agent-registry";
import { AskQuestionTool } from "../ask-question";
import { ManageSubagentsTool } from "../manage-subagents";

describe("AskQuestionTool & ManageSubagentsTool (ported from agy)", () => {
	it("AskQuestionTool formats questions and parses recommended answers", async () => {
		const tool = new AskQuestionTool();
		const result = await tool.execute("call-1", {
			questions: [
				{
					question: "Which database engine should we target?",
					options: ["(Recommended) SQLite / LibSQL", "PostgreSQL", "DuckDB"],
					is_multi_select: false,
				},
			],
		});

		expect(result.content[0].text).toContain("Which database engine should we target?");
		expect(result.content[0].text).toContain("SQLite / LibSQL");
		expect(result.details.answers[0].answers).toEqual(["SQLite / LibSQL"]);
	});

	it("ManageSubagentsTool lists, kills, and kill_all subagents via AgentRegistry", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "subagent-test-1",
			displayName: "QA Subagent",
			kind: "sub",
			session: {
				abort: async () => {},
			} as any,
		});

		const tool = new ManageSubagentsTool();

		// Test list
		const listRes = await tool.execute("call-list", { Action: "list" });
		expect(listRes.content[0].text).toContain("subagent-test-1");
		expect(listRes.content[0].text).toContain("QA Subagent");

		// Test kill single
		const killRes = await tool.execute("call-kill", {
			Action: "kill",
			ConversationIds: ["subagent-test-1"],
		});
		expect(killRes.content[0].text).toContain("Killed subagents: subagent-test-1");

		// Register second subagent and test kill_all
		registry.register({
			id: "subagent-test-2",
			displayName: "Researcher Subagent",
			kind: "sub",
			session: {
				abort: async () => {},
			} as any,
		});

		const killAllRes = await tool.execute("call-kill-all", { Action: "kill_all" });
		expect(killAllRes.content[0].text).toContain("Terminated all");
	});
});
