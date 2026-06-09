import { describe, expect, it, mock } from "bun:test";
import { ExplorationGuard } from "./exploration-guard";

describe("ExplorationGuard", () => {
	it("increments streak on all-read-only turns", () => {
		const guard = new ExplorationGuard();
		guard.turnStart();
		guard.recordToolCall("read");
		guard.turnEnd();
		guard.turnStart();
		guard.recordToolCall("grep");
		guard.turnEnd();
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(2);
	});

	it("resets streak on write tool", () => {
		const guard = new ExplorationGuard();
		guard.turnStart();
		guard.recordToolCall("read");
		guard.turnEnd(); // +1
		guard.turnStart();
		guard.recordToolCall("edit");
		guard.turnEnd(); // reset
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(0);
	});

	it("resets streak on turn with no tools", () => {
		const guard = new ExplorationGuard();
		guard.turnStart();
		guard.recordToolCall("read");
		guard.turnEnd(); // +1
		guard.turnStart();
		guard.turnEnd(); // no tools → reset
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(0);
	});

	it("resets streak on neutral-only turn", () => {
		const guard = new ExplorationGuard();
		guard.turnStart();
		guard.recordToolCall("read");
		guard.turnEnd(); // +1
		guard.turnStart();
		guard.recordToolCall("set_phase");
		guard.turnEnd(); // neutral only → reset
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(0);
	});

	it("sends hypothesis reminder at threshold", () => {
		const steerFn = mock();
		const guard = new ExplorationGuard({ hypothesisThreshold: 2, steerThreshold: 5 });
		for (let i = 0; i < 2; i++) {
			guard.turnStart();
			guard.recordToolCall("read");
			guard.turnEnd(steerFn);
		}
		expect(steerFn).toHaveBeenCalledTimes(1);
		expect(steerFn).toHaveBeenCalledWith(expect.stringContaining("2 consecutive read-only turns"));
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(2);
	});

	it("sends mandatory steer at steerThreshold and resets", () => {
		const steerFn = mock();
		const guard = new ExplorationGuard({ hypothesisThreshold: 3, steerThreshold: 4 });
		for (let i = 0; i < 4; i++) {
			guard.turnStart();
			guard.recordToolCall("read");
			guard.turnEnd(steerFn);
		}
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(0); // reset after mandatory steer
		expect(steerFn).toHaveBeenCalledWith(expect.stringContaining("4 consecutive read-only turns"));
	});

	it("identifies read-only vs write tools", () => {
		const guard = new ExplorationGuard();
		expect(guard.isReadOnly("read")).toBe(true);
		expect(guard.isReadOnly("grep")).toBe(true);
		expect(guard.isReadOnly("find")).toBe(true);
		expect(guard.isReadOnly("web_search")).toBe(true);
		expect(guard.isReadOnly("lsp_hover")).toBe(true);
		expect(guard.isReadOnly("mcp")).toBe(true);
		expect(guard.isReadOnly("edit")).toBe(false);
		expect(guard.isReadOnly("write")).toBe(false);
		expect(guard.isReadOnly("bash")).toBe(false);
		expect(guard.isReadOnly("set_phase")).toBe(false); // neutral
	});

	it("resets on user input", () => {
		const guard = new ExplorationGuard();
		guard.turnStart();
		guard.recordToolCall("read");
		guard.turnEnd();
		guard.turnStart();
		guard.recordToolCall("read");
		guard.turnEnd();
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(2);
		guard.onUserInput();
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(0);
	});

	it("can be disabled via isEnabled", () => {
		let enabled = true;
		const guard = new ExplorationGuard({ isEnabled: () => enabled });
		guard.turnStart();
		guard.recordToolCall("read");
		guard.turnEnd();
		enabled = false;
		guard.turnStart();
		guard.recordToolCall("read");
		guard.turnEnd();
		expect(guard.getConsecutiveReadOnlyTurns()).toBe(0); // reset while disabled
	});

	it("custom read/write tool sets", () => {
		const guard = new ExplorationGuard({
			readTools: new Set(["inspect"]),
			writeTools: new Set(["modify"]),
		});
		expect(guard.isReadOnly("inspect")).toBe(true);
		expect(guard.isReadOnly("modify")).toBe(false);
		expect(guard.isReadOnly("read")).toBe(false); // not in custom set
	});
});
