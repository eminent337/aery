/**
 * Registry of active PTY sessions for background interactive commands.
 *
 * When bash runs with pty: true in background mode, the agent needs to
 * send stdin to the running command (e.g., passwords). This registry
 * tracks those sessions so the send_input tool can write to them.
 */

import type { PtySession } from "@aryee337/aery-engine";

export interface InteractiveSessionState {
	session: PtySession;
	output: string;
	status: "running" | "completed" | "failed" | "timed_out";
	exitCode: number | undefined;
	command: string;
}

const sessions = new Map<string, InteractiveSessionState>();

/** Create a new tracked PTY session. Returns the job ID. */
export function createInteractiveSession(
	jobId: string,
	session: PtySession,
	command: string,
	onChunk?: (chunk: string) => void,
): InteractiveSessionState {
	const state: InteractiveSessionState = {
		session,
		output: "",
		status: "running",
		exitCode: undefined,
		command,
	};
	sessions.set(jobId, state);
	return state;
}

/** Get a tracked session by job ID. */
export function getInteractiveSession(jobId: string): InteractiveSessionState | undefined {
	return sessions.get(jobId);
}

/** Write stdin to a tracked session. Returns true if the session exists and accepted the write. */
export function writeInteractiveSession(jobId: string, data: string): boolean {
	const state = sessions.get(jobId);
	if (!state || state.status !== "running") return false;
	try {
		state.session.write(data);
		return true;
	} catch {
		return false;
	}
}

/** Update a session's output buffer (called by the PTY onChunk handler). */
export function appendInteractiveOutput(jobId: string, chunk: string): void {
	const state = sessions.get(jobId);
	if (state) {
		state.output += chunk;
	}
}

/** Mark a session as completed. */
export function completeInteractiveSession(jobId: string, exitCode: number | undefined): void {
	const state = sessions.get(jobId);
	if (state) {
		state.status = exitCode === 0 ? "completed" : "failed";
		state.exitCode = exitCode;
	}
}

/** Mark a session as timed out. */
export function timeoutInteractiveSession(jobId: string): void {
	const state = sessions.get(jobId);
	if (state) {
		state.status = "timed_out";
	}
}

/** Close and remove a tracked session. */
export function closeInteractiveSession(jobId: string): void {
	const state = sessions.get(jobId);
	if (state) {
		try {
			state.session.kill();
		} catch {
			// ignore
		}
	}
	sessions.delete(jobId);
}

/** Get all active (running) session IDs. */
export function getActiveSessionIds(): string[] {
	const active: string[] = [];
	for (const [id, state] of sessions) {
		if (state.status === "running") active.push(id);
	}
	return active;
}
