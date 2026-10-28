import { describe, expect, it } from "bun:test";
import { AgentRegistry } from "../src/registry/agent-registry";

describe("Subagent Live Activity Streaming to Status Line & Parent", () => {
	it("stores and emits currentTool, currentToolArgs, and lastIntent on AgentRef", () => {
		const registry = new AgentRegistry();
		const ref = registry.register({
			id: "sub-1",
			displayName: "Code Reviewer",
			kind: "sub",
			session: null,
			status: "running",
		});

		expect(ref.id).toBe("sub-1");
		expect(ref.status).toBe("running");

		let eventFired = false;
		registry.onChange(event => {
			if (event.type === "status_changed" && event.ref.id === "sub-1") {
				eventFired = true;
			}
		});

		registry.setProgress("sub-1", {
			currentTool: "run_command",
			currentToolArgs: "bun test",
			lastIntent: "Running tests",
		});

		expect(eventFired).toBe(true);
		expect(ref.currentTool).toBe("run_command");
		expect(ref.currentToolArgs).toBe("bun test");
		expect(ref.lastIntent).toBe("Running tests");
	});

	it("automatically hooks attached subagent session events for tool execution and turn lifecycle", () => {
		const registry = new AgentRegistry();
		const ref = registry.register({
			id: "sub-2",
			displayName: "QA Subagent",
			kind: "sub",
			session: null,
			status: "idle",
		});

		// Mock subagent session with subscribe event emitter
		let listener: ((event: any) => void) | undefined;
		const mockSession: any = {
			subscribe: (cb: (event: any) => void) => {
				listener = cb;
				return () => {};
			},
		};

		registry.attachSession("sub-2", mockSession);
		expect(listener).toBeDefined();

		// Simulate tool_execution_start
		listener!({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "inspect_image",
			args: { path: "assets/icon.png", question: "Check quality" },
		});

		expect(ref.status).toBe("running");
		expect(ref.currentTool).toBe("inspect_image");
		expect(ref.currentToolArgs).toContain("assets/icon.png");

		// Simulate tool_execution_end
		listener!({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "inspect_image",
			result: { content: [{ type: "text", text: "OK" }] },
		});

		expect(ref.currentTool).toBeUndefined();
		expect(ref.currentToolArgs).toBeUndefined();

		// Simulate turn_end
		listener!({
			type: "turn_end",
		});

		expect(ref.status).toBe("idle");
	});
});
