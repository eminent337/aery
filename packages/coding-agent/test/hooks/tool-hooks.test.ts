import { describe, expect, it } from "bun:test";
import {
	executeWithHooks,
	registerPostExecute,
	registerPreExecute,
	ToolDenyError,
} from "@aryee337/aery/hooks/tool-hooks";
import type { AgentTool, AgentToolResult } from "@aryee337/aery-core";

function makeTool(name: string, result: AgentToolResult): AgentTool {
	return {
		name,
		parameters: { type: "object", properties: {} },
		execute: async (_id: string, _args: unknown) => result,
	} as unknown as AgentTool;
}

describe("tool hooks", () => {
	it("executes tool without hooks", async () => {
		const tool = makeTool("test1", { content: [{ type: "text", text: "ok" }] });
		const result = await executeWithHooks(tool, "call_1", { foo: "bar" }, new AbortController().signal);
		expect(result.content[0]).toEqual({ type: "text", text: "ok" });
	});

	it("runs pre-execute hooks in order", async () => {
		const calls: string[] = [];
		registerPreExecute("test2", async args => {
			calls.push("pre1");
			return args;
		});
		registerPreExecute("test2", async args => {
			calls.push("pre2");
			return args;
		});

		const tool = makeTool("test2", { content: [{ type: "text", text: "done" }] });
		await executeWithHooks(tool, "call_2", {}, new AbortController().signal);
		expect(calls).toEqual(["pre1", "pre2"]);
	});

	it("runs post-execute hooks in order", async () => {
		const calls: string[] = [];
		registerPostExecute("test3", async result => {
			calls.push("post1");
			return result;
		});
		registerPostExecute("test3", async result => {
			calls.push("post2");
			return result;
		});

		const tool = makeTool("test3", { content: [{ type: "text", text: "done" }] });
		await executeWithHooks(tool, "call_3", {}, new AbortController().signal);
		expect(calls).toEqual(["post1", "post2"]);
	});

	it("pre-execute hook can modify args", async () => {
		registerPreExecute("test4", async _args => {
			return { modified: true };
		});

		let receivedArgs: unknown;
		const tool = {
			name: "test4",
			parameters: { type: "object", properties: {} },
			execute: async (_id: string, args: unknown) => {
				receivedArgs = args;
				return { content: [{ type: "text", text: "ok" }] };
			},
		} as unknown as AgentTool;

		await executeWithHooks(tool, "call_4", { original: true }, new AbortController().signal);
		expect(receivedArgs).toEqual({ modified: true });
	});

	it("post-execute hook can modify result", async () => {
		registerPostExecute("test5", async _result => {
			return { content: [{ type: "text", text: "replaced" }] };
		});

		const tool = makeTool("test5", { content: [{ type: "text", text: "original" }] });
		const result = await executeWithHooks(tool, "call_5", {}, new AbortController().signal);
		expect(result.content[0]).toEqual({ type: "text", text: "replaced" });
	});

	it("pre-execute hook can deny tool call", async () => {
		registerPreExecute("test6", async () => {
			throw new ToolDenyError("not allowed", "test6");
		});

		const tool = makeTool("test6", { content: [{ type: "text", text: "should not run" }] });
		await expect(executeWithHooks(tool, "call_6", {}, new AbortController().signal)).rejects.toThrow(ToolDenyError);
	});

	it("global hooks run for all tools", async () => {
		const calls: string[] = [];
		registerPreExecute("*", async args => {
			calls.push("global-pre");
			return args;
		});
		registerPostExecute("*", async result => {
			calls.push("global-post");
			return result;
		});

		const tool = makeTool("test7", { content: [{ type: "text", text: "ok" }] });
		await executeWithHooks(tool, "call_7", {}, new AbortController().signal);
		expect(calls).toEqual(["global-pre", "global-post"]);
	});

	it("disposer unregisters hook", async () => {
		const calls: string[] = [];
		const dispose = registerPreExecute("test8", async args => {
			calls.push("hooked");
			return args;
		});

		const tool = makeTool("test8", { content: [{ type: "text", text: "ok" }] });

		await executeWithHooks(tool, "call_8a", {}, new AbortController().signal);
		expect(calls).toEqual(["hooked"]);

		dispose();

		await executeWithHooks(tool, "call_8b", {}, new AbortController().signal);
		expect(calls).toEqual(["hooked"]); // no additional call
	});
});
