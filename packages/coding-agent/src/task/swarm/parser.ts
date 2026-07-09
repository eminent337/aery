import type { SwarmTask, SwarmWorkflow } from "./types";

export function parseSwarmYaml(content: string): SwarmWorkflow {
	const lines = content.split("\n");
	const workflow: Partial<SwarmWorkflow> = { tasks: [] };
	let currentTask: Partial<SwarmTask> | null = null;

	for (let line of lines) {
		// Strip comments and trim whitespace
		const commentIdx = line.indexOf("#");
		if (commentIdx >= 0) {
			line = line.slice(0, commentIdx);
		}
		const trimmed = line.trim();
		if (!trimmed) continue;

		// Handle top-level keys
		if (trimmed.startsWith("name:")) {
			workflow.name = trimmed
				.slice(5)
				.trim()
				.replace(/^['"]|['"]$/g, "");
			continue;
		}
		if (trimmed.startsWith("maxConcurrency:")) {
			workflow.maxConcurrency = parseInt(trimmed.slice(15).trim(), 10) || 3;
			continue;
		}

		// Handle task items starting with "-"
		if (trimmed.startsWith("-")) {
			if (currentTask && currentTask.id) {
				workflow.tasks!.push(currentTask as SwarmTask);
			}
			currentTask = {};
			const inner = trimmed.slice(1).trim();
			parseTaskField(inner, currentTask);
			continue;
		}

		// Handle standard task properties
		if (currentTask) {
			parseTaskField(trimmed, currentTask);
		}
	}

	if (currentTask && currentTask.id) {
		workflow.tasks!.push(currentTask as SwarmTask);
	}

	return {
		name: workflow.name ?? "Swarm Workflow",
		tasks: workflow.tasks ?? [],
		maxConcurrency: workflow.maxConcurrency ?? 3,
	};
}

function parseTaskField(line: string, task: Partial<SwarmTask>): void {
	const colonIdx = line.indexOf(":");
	if (colonIdx < 0) return;
	const key = line.slice(0, colonIdx).trim();
	const val = line
		.slice(colonIdx + 1)
		.trim()
		.replace(/^['"]|['"]$/g, "");

	if (key === "id") task.id = val;
	else if (key === "agent") task.agent = val;
	else if (key === "assignment") task.assignment = val;
	else if (key === "needs") {
		// Parse needs array format e.g., ["task1", "task2"]
		task.needs = val
			.replace(/[[\]]/g, "")
			.split(",")
			.map(s => s.trim().replace(/^['"]|['"]$/g, ""))
			.filter(Boolean);
	}
}
