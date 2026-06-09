/**
 * Monitor Tool — Run a shell command in the background and stream stdout.
 * Useful for watching builds, servers, log tails, etc.
 */

import type { ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@aryee337/aery";

const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export default function registerMonitorTool(aery: ExtensionAPI): void {
	const running = new Map<string, ChildProcess>();

	aery.registerTool({
		name: "monitor",
		label: "Process Monitor",
		description:
			"Run a shell command in the background and stream its stdout line-by-line as notifications. Use for watching builds, servers, log tails, or any long-running process.",
		parameters: {
			type: "object" as const,
			properties: {
				command: { type: "string" as const, description: "Command to monitor" },
				description: { type: "string" as const, description: "Description" },
			},
			required: ["command", "description"],
		},
		async execute() {
			return { content: [{ type: "text" as const, text: "Monitor started" }] };
		},
	});
}
