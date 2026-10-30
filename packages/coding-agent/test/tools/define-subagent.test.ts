/**
 * Tests for DefineSubagentTool — agy custom subagent type definition.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AgentRegistry } from "../../src/registry/agent-registry";
import {
	defineCustomSubagent,
	getCustomSubagentDefinition,
	getSubagentDefinition,
	resetCustomSubagentsForTests,
} from "../../src/registry/builtin-subagents";
import { DefineSubagentTool } from "../../src/tools/define-subagent";
import { InvokeSubagentTool } from "../../src/tools/invoke-subagent";
import { ManageSubagentsTool } from "../../src/tools/manage-subagents";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	const c = result.content[0];
	return c?.type === "text" && c.text ? c.text : "";
}

describe("DefineSubagentTool", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		resetCustomSubagentsForTests();
	});

	afterEach(() => {
		resetCustomSubagentsForTests();
	});

	it("has the correct tool name and approval level", () => {
		const tool = new DefineSubagentTool();
		expect(tool.name).toBe("define_subagent");
		expect(tool.approval).toBe("read");
		expect(tool.loadMode).toBe("discoverable");
	});

	it("rejects definition with missing required parameters", async () => {
		const tool = new DefineSubagentTool();
		const result = await tool.execute("call-err", {
			Name: "",
			Description: "A description",
			SystemPrompt: "A prompt",
		});
		expect(result.isError).toBe(true);
		expect(getText(result as any)).toContain("Name is required");
	});

	it("successfully registers a custom subagent type", async () => {
		const tool = new DefineSubagentTool();
		const result = await tool.execute("call-1", {
			Name: "test-runner",
			Description: "Runs test suites and diagnoses failures",
			SystemPrompt: "You are an automated test runner. Run tests and report output.",
			EnableWriteTools: true,
			EnableSubagentTools: false,
			EnableMCPTools: false,
		});

		expect(result.isError).toBeUndefined();
		const text = getText(result as any);
		expect(text).toContain("Subagent Type Defined: `test-runner`");
		expect(text).toContain("File Writes & Commands");

		const def = getCustomSubagentDefinition("test-runner");
		expect(def).toBeDefined();
		expect(def?.name).toBe("test-runner");
		expect(def?.enableWriteTools).toBe(true);
	});

	it("allows invoke_subagent to instantiate the defined custom subagent", async () => {
		const defineTool = new DefineSubagentTool();
		await defineTool.execute("def-1", {
			Name: "db-migrator",
			Description: "Applies database migrations safely",
			SystemPrompt: "You are a database migration agent.",
			EnableWriteTools: true,
		});

		// Invoke the subagent using the newly defined custom type
		const invokeTool = new InvokeSubagentTool();
		const invokeResult = await invokeTool.execute("invoke-1", {
			TypeName: "db-migrator",
			Role: "Database Migrator",
			Prompt: "Run migration 004_add_users",
		});

		const text = getText(invokeResult as any);
		expect(text).toContain("Subagent launched successfully");
		expect(text).toContain("Applies database migrations safely");

		const details = invokeResult.details as Record<string, unknown>;
		expect(details.typeName).toBe("db-migrator");
		expect(details.description).toBe("Applies database migrations safely");
	});

	it("manage_subagents lists custom defined subagents in details", async () => {
		const defineTool = new DefineSubagentTool();
		await defineTool.execute("def-2", {
			Name: "security-auditor",
			Description: "Audits code for vulnerabilities",
			SystemPrompt: "You are a security auditor.",
		});

		const manageTool = new ManageSubagentsTool();
		const listResult = await manageTool.execute("list-1", { Action: "list" });

		const details = listResult.details as Record<string, unknown>;
		expect(details.customSubagents).toBeDefined();
		const customList = details.customSubagents as Array<{ name: string }>;
		expect(customList.some(s => s.name === "security-auditor")).toBe(true);
	});
});
