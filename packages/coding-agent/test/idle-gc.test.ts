import { describe, expect, jest, test } from "bun:test";
import { IdleHeapRelease } from "../src/performance/idle-gc.js";
import type { AgentSession } from "../src/session/agent-session.js";

// ─── Mock AgentSession ────────────────────────────────────────────────────────

function createMockSession(): { session: AgentSession; unsubscribed: { count: number } } {
	const unsubscribed = { count: 0 };
	const session = {
		subscribe: jest.fn(() => {
			return () => {
				unsubscribed.count++;
			};
		}),
	} as unknown as AgentSession;
	return { session, unsubscribed };
}

describe("IdleHeapRelease", () => {
	test("stop() clears the watchdog interval and releases the session subscription", () => {
		const { session, unsubscribed } = createMockSession();

		const watchdog = new IdleHeapRelease(session);
		expect(watchdog.isRunning).toBe(false);

		watchdog.start();
		expect(watchdog.isRunning).toBe(true);
		expect(session.subscribe).toHaveBeenCalledTimes(1);

		watchdog.stop();
		expect(watchdog.isRunning).toBe(false);
		expect(unsubscribed.count).toBe(1);
	});

	test("stop() is idempotent", () => {
		const { session, unsubscribed } = createMockSession();
		const watchdog = new IdleHeapRelease(session);

		watchdog.start();
		watchdog.stop();
		watchdog.stop();

		expect(watchdog.isRunning).toBe(false);
		expect(unsubscribed.count).toBe(1);
	});

	test("start() after stop() re-subscribes cleanly", () => {
		const { session, unsubscribed } = createMockSession();
		const watchdog = new IdleHeapRelease(session);

		watchdog.start();
		watchdog.stop();
		watchdog.start();

		expect(watchdog.isRunning).toBe(true);
		expect(session.subscribe).toHaveBeenCalledTimes(2);
		expect(unsubscribed.count).toBe(1);

		watchdog.stop();
		expect(unsubscribed.count).toBe(2);
	});
});
