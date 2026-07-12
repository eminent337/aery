import type { TaskState } from "./types";

export function formatCoordinatorDashboard(taskStates: Map<string, TaskState>): string[] {
	const lines: string[] = [];
	lines.push("┌─ Swarm Coordinator ────────────────────────┐");

	for (const state of taskStates.values()) {
		let statusGlyph = "";
		let statusColor = (s: string) => s;

		switch (state.status) {
			case "completed":
				statusGlyph = "✓ completed";
				statusColor = s => `\x1b[32m${s}\x1b[39m`; // Green
				break;
			case "running":
				statusGlyph = "▶ running";
				statusColor = s => `\x1b[33m${s}\x1b[39m`; // Yellow
				break;
			case "retrying":
				statusGlyph = "⟳ retrying";
				statusColor = s => `\x1b[35m${s}\x1b[39m`; // Magenta
				break;
			case "blocked":
				statusGlyph = "● blocked";
				statusColor = s => `\x1b[90m${s}\x1b[39m`; // Dim Grey
				break;
			case "failed":
				statusGlyph = "✗ failed";
				statusColor = s => `\x1b[31m${s}\x1b[39m`; // Red
				break;
			default:
				statusGlyph = "○ pending";
				statusColor = s => s;
				break;
		}

		const attemptInfo = state.attempts > 0 ? ` (${state.attempts} attempt${state.attempts > 1 ? "s" : ""})` : "";
		const errorInfo = state.error ? ` - Error: ${state.error}` : "";
		const taskLine = `│ ${state.id.padEnd(12)} ${statusColor(statusGlyph).padEnd(25)} ${attemptInfo}${errorInfo}`;
		lines.push(taskLine);
	}

	lines.push("└────────────────────────────────────────────┘");
	return lines;
}
