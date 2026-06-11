f = "packages/coding-agent/src/task/index.ts"
content = open(f).read()

content = content.replace('''		const tasks = Array.isArray(params.tasks) ? params.tasks : [];
		const firstTask = tasks[0];
		if (firstTask) {
			lines.push(`Task: ${truncateForPrompt(firstTask.id)}`);
			lines.push(`Assignment:\\n${truncateForPrompt(firstTask.assignment)}`);
			if (tasks.length > 1) {
				lines.push(`+${tasks.length - 1} more task${tasks.length === 2 ? "" : "s"}`);
			}
		}
		if (typeof params.context === "string" && params.context.trim()) {
			lines.push(`Context:\\n${truncateForPrompt(params.context)}`);
		}
		const tasks = Array.isArray(params.tasks) ? params.tasks : [];
		const firstTask = tasks[0];
		if (firstTask) {
			if (typeof firstTask.id === "string" && firstTask.id.trim()) {
				lines.push(`Task: ${truncateForPrompt(firstTask.id)}`);
			}
			if (typeof firstTask.assignment === "string") {
				lines.push(`Assignment:\\n${truncateForPrompt(firstTask.assignment)}`);
			}
			if (tasks.length > 1) {
				lines.push(`+${tasks.length - 1} more task${tasks.length === 2 ? "" : "s"}`);
			}
		}''', '''		const tasks = Array.isArray(params.tasks) ? params.tasks : [];
		const firstTask = tasks[0];
		if (firstTask) {
			if (typeof firstTask.id === "string" && firstTask.id.trim()) {
				lines.push(`Task: ${truncateForPrompt(firstTask.id)}`);
			}
			if (typeof firstTask.assignment === "string") {
				lines.push(`Assignment:\\n${truncateForPrompt(firstTask.assignment)}`);
			}
			if (tasks.length > 1) {
				lines.push(`+${tasks.length - 1} more task${tasks.length === 2 ? "" : "s"}`);
			}
		}
		if (typeof params.context === "string" && params.context.trim()) {
			lines.push(`Context:\\n${truncateForPrompt(params.context)}`);
		}''')

content = content.replace('''import { generateCommitMessage } from "../utils/commit-message-generator";
import type { AsyncJobManager } from "../async";''', '''import { generateCommitMessage } from "../utils/commit-message-generator";''')

content = content.replace('''const { agent: agentName || "", context, schema: outputSchema } = params;''', '''const { agent: agentName = "", context, schema: outputSchema } = params;''')

open(f, "w").write(content)
