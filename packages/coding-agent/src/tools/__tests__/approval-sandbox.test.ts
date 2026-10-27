import { describe, expect, it } from "bun:test";
import { resolveApproval } from "../approval";

describe("proceed-in-sandbox Approval Mode (ported from agy 1.0.1)", () => {
	const mockBashTool = {
		name: "bash",
		approval: "exec" as const,
	};

	it("auto-approves tool execution under proceed-in-sandbox mode", () => {
		const res = resolveApproval(mockBashTool, { command: "npm test" }, "proceed-in-sandbox");
		expect(res.policy).toBe("allow");
	});

	it("honors explicit user deny policy in proceed-in-sandbox mode", () => {
		const res = resolveApproval(mockBashTool, { command: "curl https://example.com" }, "proceed-in-sandbox", {
			bash: "deny",
		});
		expect(res.policy).toBe("deny");
	});

	it("honors explicit user prompt policy in proceed-in-sandbox mode", () => {
		const res = resolveApproval(mockBashTool, { command: "deploy" }, "proceed-in-sandbox", { bash: "prompt" });
		expect(res.policy).toBe("prompt");
	});
});
