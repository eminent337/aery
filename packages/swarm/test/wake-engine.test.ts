import { describe, expect, it } from "bun:test";
import type { BoardMessage } from "../src/types";
import { ParkGuard } from "../src/wake/park-guard";
import { WakeEngine } from "../src/wake/wake-engine";

describe("WakeEngine & ParkGuard", () => {
	it("resolves wake promise when target agent is mentioned", async () => {
		const engine = new WakeEngine();

		const waitPromise = engine.waitForWake("worker-1", 5000);

		const incomingMsg: BoardMessage = {
			seq: 10,
			timestamp: new Date().toISOString(),
			from: "coordinator",
			mentions: ["worker-1"],
			content: "@worker-1 wake up",
		};

		engine.notifyMessage(incomingMsg);

		const result = await waitPromise;
		expect(result).toHaveLength(1);
		expect(result[0].seq).toBe(10);
	});

	it("resolves wake promise on broadcast mentions", async () => {
		const engine = new WakeEngine();

		const p1 = engine.waitForWake("worker-1", 5000);
		const p2 = engine.waitForWake("worker-2", 5000);

		const broadcastMsg: BoardMessage = {
			seq: 11,
			timestamp: new Date().toISOString(),
			from: "coordinator",
			mentions: ["all"],
			content: "@all urgent standup",
		};

		engine.notifyMessage(broadcastMsg);

		const [r1, r2] = await Promise.all([p1, p2]);
		expect(r1[0].seq).toBe(11);
		expect(r2[0].seq).toBe(11);
	});

	it("park guard prevents coordinator from parking", () => {
		const guard = new ParkGuard();
		expect(guard.canPark("worker-1")).toBe(true);
		expect(guard.canPark("coordinator")).toBe(false);
	});
});
