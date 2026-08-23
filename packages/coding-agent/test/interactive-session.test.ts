import { beforeEach, describe, expect, it } from "bun:test";
import {
	appendInteractiveOutput,
	closeInteractiveSession,
	completeInteractiveSession,
	createInteractiveSession,
	getActiveSessionIds,
	getInteractiveSession,
	writeInteractiveSession,
} from "@aryee337/aery/tools/bash-interactive-session";
import type { PtySession } from "@aryee337/aery-engine";

// Mock PtySession
function createMockSession(): PtySession {
	const session = {
		write: (data: string) => {
			(session as { _lastWrite?: string })._lastWrite = data;
		},
		start: async () => ({ exitCode: 0, cancelled: false, timedOut: false }),
		resize: () => {},
		kill: () => {},
	} as unknown as PtySession;
	return session;
}

describe("interactive session registry", () => {
	beforeEach(() => {
		// Clear all sessions by closing them
		for (const id of getActiveSessionIds()) {
			closeInteractiveSession(id);
		}
	});

	it("creates and retrieves a session", () => {
		const session = createMockSession();
		const state = createInteractiveSession("job-1", session, "sudo apt update");
		expect(state.status).toBe("running");
		expect(state.command).toBe("sudo apt update");

		const retrieved = getInteractiveSession("job-1");
		expect(retrieved).toBeDefined();
		expect(retrieved!.status).toBe("running");
	});

	it("writes input to a running session", () => {
		const session = createMockSession();
		createInteractiveSession("job-1", session, "sudo apt update");

		const sent = writeInteractiveSession("job-1", "password\n");
		expect(sent).toBe(true);

		// Verify the mock received the write
		const lastWrite = (session as { _lastWrite?: string })._lastWrite;
		expect(lastWrite).toBe("password\n");
	});

	it("returns false when writing to a non-existent session", () => {
		const sent = writeInteractiveSession("nonexistent", "data");
		expect(sent).toBe(false);
	});

	it("returns false when writing to a completed session", () => {
		const session = createMockSession();
		createInteractiveSession("job-1", session, "sudo apt update");
		completeInteractiveSession("job-1", 0);

		const sent = writeInteractiveSession("job-1", "password\n");
		expect(sent).toBe(false);
	});

	it("appends output and updates state", () => {
		const session = createMockSession();
		createInteractiveSession("job-1", session, "sudo apt update");

		appendInteractiveOutput("job-1", "[sudo] password for user: ");
		const state = getInteractiveSession("job-1");
		expect(state!.output).toBe("[sudo] password for user: ");
	});

	it("completes a session", () => {
		const session = createMockSession();
		createInteractiveSession("job-1", session, "sudo apt update");

		completeInteractiveSession("job-1", 0);
		const state = getInteractiveSession("job-1");
		expect(state!.status).toBe("completed");
		expect(state!.exitCode).toBe(0);
	});

	it("marks a failed session", () => {
		const session = createMockSession();
		createInteractiveSession("job-1", session, "sudo apt update");

		completeInteractiveSession("job-1", 1);
		const state = getInteractiveSession("job-1");
		expect(state!.status).toBe("failed");
		expect(state!.exitCode).toBe(1);
	});

	it("removes a session on close", () => {
		const session = createMockSession();
		createInteractiveSession("job-1", session, "sudo apt update");

		closeInteractiveSession("job-1");
		expect(getInteractiveSession("job-1")).toBeUndefined();
	});

	it("tracks active sessions", () => {
		const session1 = createMockSession();
		const session2 = createMockSession();
		createInteractiveSession("job-1", session1, "cmd1");
		createInteractiveSession("job-2", session2, "cmd2");

		const active = getActiveSessionIds();
		expect(active.length).toBe(2);
		expect(active).toContain("job-1");
		expect(active).toContain("job-2");

		// Complete one, active count drops
		completeInteractiveSession("job-1", 0);
		const activeAfter = getActiveSessionIds();
		expect(activeAfter.length).toBe(1);
		expect(activeAfter).toContain("job-2");
	});
});
