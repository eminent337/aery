import re

with open("/home/aryee/aery/ai_agent/aery/packages/coding-agent/src/task/types.ts", "r") as f:
    text = f.read()

# Fix types.ts exactly
text = re.sub(r'import \{ getTaskSimpleModeCapabilities, type TaskSimpleMode \} from "\./simple-mode";\n', '', text)
start_idx = text.find('const assignmentDescription = "per-task instructions; self-contained";')
end_idx = text.find('export interface ReviewFinding {')
if start_idx != -1 and end_idx != -1:
    new_types = """/**
 * One unit of work. The single-spawn schema is `{ agent, ...taskItemSchema }`;
 * the batch schema (`task.batch`) is `{ agent, context, tasks: taskItemSchema[] }`.
 * When task isolation is enabled, `isolated` joins the item shape (per-item in
 * batch form, top-level in the flat form via the spread).
 */
const taskItemShape = {
	id: z.string().max(48).optional().describe("stable agent id; default generated"),
	description: z.string().optional().describe("ui label, not seen by subagent"),
	assignment: z.string().describe("the work; self-contained instructions"),
};
const isolatedShape = {
	isolated: z.boolean().optional().describe("run in isolated env; returns patches"),
};
const agentShape = {
	agent: z.string().describe("agent type to spawn"),
};
const contextShape = {
	context: z.string().describe("shared background prepended to each assignment"),
};

export const taskItemSchema = z.object(taskItemShape);
const taskItemSchemaIsolated = z.object({ ...taskItemShape, ...isolatedShape });

/** Single task item. Fields are optional defensively: args stream in token by token. */
export interface TaskItem {
	/** Stable agent id; default = generated AdjectiveNoun. */
	id?: string;
	/** UI label, not seen by the subagent. */
	description?: string;
	/** The work; required by the schema. */
	assignment?: string;
	/** Run this spawn in an isolated worktree (batch form; flat form carries it top-level). */
	isolated?: boolean;
}

export const taskSchema = z.object({ ...agentShape, ...taskItemShape, ...isolatedShape });
const taskSchemaNoIsolation = z.object({ ...agentShape, ...taskItemShape });
const taskSchemaBatch = z.object({
	...agentShape,
	...contextShape,
	tasks: z.array(taskItemSchemaIsolated).describe("tasks to spawn; one subagent per item"),
});
const taskSchemaBatchNoIsolation = z.object({
	...agentShape,
	...contextShape,
	tasks: z.array(taskItemSchema).describe("tasks to spawn; one subagent per item"),
});
const ALL_TASK_SCHEMAS = [taskSchema, taskSchemaNoIsolation, taskSchemaBatch, taskSchemaBatchNoIsolation] as const;

type DynamicTaskSchema = (typeof ALL_TASK_SCHEMAS)[number];
export type TaskSchema = typeof taskSchema;
/** Active task tool parameter schema for the current isolation / batch flags */
export type TaskToolSchemaInstance = DynamicTaskSchema;

export function getTaskSchema(options: { isolationEnabled: boolean; batchEnabled: boolean }): DynamicTaskSchema {
	if (options.batchEnabled) {
		return options.isolationEnabled ? taskSchemaBatch : taskSchemaBatchNoIsolation;
	}
	return options.isolationEnabled ? taskSchema : taskSchemaNoIsolation;
}

/**
 * Runtime params union over both wire shapes. The model sees exactly one shape
 * (`{ agent, context, tasks[] }` when `task.batch` is on, `{ agent, ...item }`
 * otherwise); runtime stays permissive so internal callers and stale
 * transcripts using the flat form keep working under either setting.
 */
export interface TaskParams {
	/** Agent type; required. */
	agent?: string;
	/** Stable agent id (flat form); default = generated AdjectiveNoun. */
	id?: string;
	/** UI label (flat form), not seen by the subagent. */
	description?: string;
	/** The work (flat form). */
	assignment?: string;
	/** Batch form (`task.batch`): one subagent per item. */
	tasks?: TaskItem[];
	/** Batch form: shared background prepended to every assignment; required by the batch schema. */
	context?: string;
	/** Run in an isolated worktree (flat form; per-item in batch form). */
	isolated?: boolean;
}

"""
    text = text[:start_idx] + new_types + text[end_idx:]

with open("/home/aryee/aery/ai_agent/aery/packages/coding-agent/src/task/types.ts", "w") as f:
    f.write(text)

with open("/home/aryee/aery/ai_agent/aery/packages/coding-agent/src/task/index.ts", "r") as f:
    idx = f.read()

# Fix executeSyncFanout inside the class
import re
idx = re.sub(
    r'\nasync #executeSyncFanout\([^}]+\}\n',
    '',
    idx,
    flags=re.MULTILINE | re.DOTALL
)

methods = """
	#isBatchEnabled(): boolean {
		return this.session.settings.get("task.batch");
	}

	async #executeSyncFanout(
		toolCallId: string,
		params: TaskParams,
		spawnItems: TaskItem[],
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
	): Promise<AgentToolResult<TaskToolDetails>> {
		const maxConcurrency = this.session.settings.get("task.maxConcurrency");
		const semaphore = new Semaphore(maxConcurrency);

		if (spawnItems.length === 1) {
			await semaphore.acquire();
			try {
				return await this.#executeSync(toolCallId, spawnParamsFor(params, spawnItems[0]), signal, onUpdate);
			} finally {
				semaphore.release();
			}
		}

		const startTime = Date.now();
		const latestProgress = new Map<number, AgentProgress>();
		const emitCombined = () => {
			onUpdate?.({
				content: [{ type: "text", text: `Running ${spawnItems.length} agents...` }],
				details: {
					projectAgentsDir: null,
					results: [],
					totalDurationMs: Date.now() - startTime,
					progress: Array.from(latestProgress.entries())
						.sort((a, b) => a[0] - b[0])
						.map(([, progress]) => progress),
				},
			});
		};

		const payloads = await Promise.all(
			spawnItems.map(async (item, index) => {
				await semaphore.acquire();
				try {
					const itemOnUpdate: AgentToolUpdateCallback<TaskToolDetails> | undefined = onUpdate
						? update => {
								const progress = update.details?.progress?.[0];
								if (progress) {
									latestProgress.set(index, { ...progress, index });
									emitCombined();
								}
							}
						: undefined;
					return await this.#executeSync(toolCallId, spawnParamsFor(params, item), signal, itemOnUpdate);
				} finally {
					semaphore.release();
				}
			})
		);

		const results: SingleResult[] = [];
		const contentParts: string[] = [];
		const outputPaths: string[] = [];
		let projectAgentsDir: string | null = null;
		for (let index = 0; index < spawnItems.length; index++) {
			const payload = payloads[index];
			if (!payload) {
				contentParts.push(`Task ${spawnItems[index].id?.trim() || `#${index + 1}`}: cancelled before start.`);
				continue;
			}
			projectAgentsDir = projectAgentsDir ?? payload.details?.projectAgentsDir ?? null;
			const text = payload.content.find((part: any) => part.type === "text")?.text;
			if (text) contentParts.push(text);
			for (const result of payload.details?.results ?? []) {
				results.push({ ...result, index });
				if (result.outputPath) outputPaths.push(result.outputPath);
			}
		}

		return {
			content: [{ type: "text", text: contentParts.join("\\n\\n") }],
			details: {
				projectAgentsDir,
				results,
				totalDurationMs: Date.now() - startTime,
				outputPaths: outputPaths.length > 0 ? outputPaths : undefined,
			},
		};
	}

"""

# Remove old #isBatchEnabled if it is outside
idx = re.sub(r'\t#isBatchEnabled\(\): boolean \{\n\t\treturn this\.session\.settings\.get\("task\.batch"\);\n\t\}\n', '', idx)
idx = re.sub(r'#isBatchEnabled\(\): boolean \{\n\t\treturn this\.session\.settings\.get\("task\.batch"\);\n\t\}\n', '', idx)

# Add #isBatchEnabled and #executeSyncFanout into TaskTool class right before #executeSync
idx = idx.replace("	async #executeSync(", methods + "	async #executeSync(")

# Also add validateSpawnParams, validateShapeParams, resolveSpawnItems, spawnParamsFor OUTSIDE the class
helpers = """
function validateShapeParams(batchEnabled: boolean, params: TaskParams): string | undefined {
	if ((params as Record<string, unknown>).schema !== undefined) {
		return "The task tool does not accept `schema`. Rely on the selected agent definition's `output` schema or the inherited session schema; workflows needing ad-hoc structured output use eval `agent(prompt, schema)`.";
	}
	if (!batchEnabled) {
		const disallowed = (["tasks", "context"] as const).filter(field => params[field] !== undefined);
		if (disallowed.length > 0) {
			return `task.batch is disabled, so the task tool does not accept ${disallowed.map(f => `\\`${f}\\``).join(" or ")}. Spawn one agent per call with \\`assignment\\`, or enable the task.batch setting.`;
		}
	}
	return undefined;
}

function validateSpawnParams(params: TaskParams, batchEnabled: boolean): string | undefined {
	const agent = typeof params.agent === "string" ? params.agent.trim() : "";
	if (!agent) {
		return "Missing `agent`. Provide an agent type to spawn.";
	}
	const hasAssignment = typeof params.assignment === "string" && params.assignment.trim() !== "";
	const tasks = params.tasks;
	if (batchEnabled && tasks !== undefined) {
		if (!Array.isArray(tasks) || tasks.length === 0) {
			return "Missing `tasks`. Provide at least one task item ({ id?, description?, assignment }).";
		}
		if (hasAssignment) {
			return "Top-level `assignment` is not part of the batch shape. Put the work in `tasks[]` items.";
		}
		for (let i = 0; i < tasks.length; i++) {
			const item = tasks[i];
			if (!item || typeof item.assignment !== "string" || item.assignment.trim() === "") {
				return `Task ${i + 1}${item?.id ? ` (\\`${item.id}\\`)` : ""} is missing \\`assignment\\`. Every task needs complete, self-contained instructions.`;
			}
		}
		const seen = new Map<string, string>();
		for (const item of tasks) {
			const id = item.id?.trim();
			if (!id) continue;
			const key = id.toLowerCase();
			const existing = seen.get(key);
			if (existing !== undefined) {
				return `Duplicate task id ${existing === id ? `\\`${id}\\`` : `\\`${existing}\\` / \\`${id}\\``}. Provided ids must be unique within a call (case-insensitive).`;
			}
			seen.set(key, id);
		}
		if (typeof params.context !== "string" || params.context.trim() === "") {
			return "Missing `context`. Provide the shared background for this batch — goal, constraints, and any contract the tasks share.";
		}
		return undefined;
	}
	if (!hasAssignment) {
		return batchEnabled
			? "Missing `tasks`. Provide a `tasks` array (one subagent per item) with a shared `context`."
			: "Missing `assignment`. Provide complete, self-contained instructions for the agent.";
	}
	return undefined;
}

function resolveSpawnItems(params: TaskParams): TaskItem[] {
	if (Array.isArray(params.tasks) && params.tasks.length > 0) {
		return params.tasks;
	}
	return [{ id: params.id, description: params.description, assignment: params.assignment }];
}

function spawnParamsFor(params: TaskParams, item: TaskItem): TaskParams {
	const spawn: TaskParams = { agent: params.agent };
	if (item.id !== undefined) spawn.id = item.id;
	if (item.description !== undefined) spawn.description = item.description;
	if (item.assignment !== undefined) spawn.assignment = item.assignment;
	if (params.context !== undefined) spawn.context = params.context;
	if (params.isolated !== undefined) spawn.isolated = params.isolated;
	if (item.isolated !== undefined) spawn.isolated = item.isolated;
	return spawn;
}
"""

if "function validateShapeParams(" not in idx:
    idx = idx.replace("function createTaskModeError(text: string): AgentToolResult<TaskToolDetails> {", helpers + "\nfunction createTaskModeError(text: string): AgentToolResult<TaskToolDetails> {")


# Ensure _toolCallId is replaced with toolCallId in manager.register
idx = idx.replace("await this.#executeSync(_toolCallId,", "await this.#executeSync(toolCallId,")
idx = idx.replace("return this.#executeSync(_toolCallId,", "return this.#executeSync(toolCallId,")

with open("/home/aryee/aery/ai_agent/aery/packages/coding-agent/src/task/index.ts", "w") as f:
    f.write(idx)

