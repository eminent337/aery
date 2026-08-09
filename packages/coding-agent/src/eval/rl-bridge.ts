/**
 * Host-side handler for the eval `rlm()` async subagent helper.
 *
 * Unlike `agent()` which blocks until completion, `rlm()` spawns a subagent
 * asynchronously and returns immediately with a handle. The caller can then
 * check status, send messages, or wait for completion via `rlm.list_subagents()`.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { prompt, Snowflake } from "@aryee337/aery-utils";
import * as z from "zod/v4";
import { resolveAgentModelPatterns } from "../config/model-resolver";
import type { LocalProtocolOptions } from "../internal-urls";
import { MCPManager } from "../mcp/manager";
import subagentUserPromptTemplate from "../prompts/system/subagent-user-prompt.md" with { type: "text" };
import * as taskDiscovery from "../task/discovery";
import * as taskExecutor from "../task/executor";
import { filterSkillsJIT, getFileExtensions } from "../task/jit-skills";
import { AgentOutputManager } from "../task/output-manager";
import type { AgentDefinition, AgentProgress } from "../task/types";
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";
import { withBridgeHeartbeat } from "./heartbeat";
import type { JsStatusEvent } from "./js/shared/types";
// Import review tools for side effects (registers subagent tool handlers).
import "../tools/review";

/** Synthetic bridge name reserved for the `rlm()` helper across both runtimes. */
export const EVAL_RLM_BRIDGE_NAME = "__rlm__";

/** Synthetic bridge name for `rlm.list_subagents()`. */
export const EVAL_RLM_LIST_BRIDGE_NAME = "__rlm_list__";

/** Hard recursion limit for eval-driven subagents. */
export const EVAL_RLM_MAX_DEPTH = 3;

const DEFAULT_RLM_AGENT_TYPE = "task";
const DEFAULT_RLM_LABEL = "EvalRlmAgent";

const rlmArgsSchema = z.object({
	prompt: z.string().min(1, "prompt must be a non-empty string"),
	agentType: z.string().min(1).optional(),
	model: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
	context: z.string().optional(),
	label: z.string().optional(),
	schema: z.unknown().optional(),
});

interface EvalRlmArgs {
	prompt: string;
	agentType?: string;
	model?: string | string[];
	context?: string;
	label?: string;
	schema?: unknown;
}

export interface EvalRlmBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

/** Handle returned immediately when rlm() spawns a subagent. */
export interface EvalRlmHandle {
	id: string;
	name: string;
	sessionId: string;
	model?: string | string[];
}

/** Result returned by rlm.list_subagents(). */
export interface EvalRlmListResult {
	subagents: EvalRlmHandle[];
}

function parseRlmArgs(args: unknown): EvalRlmArgs {
	const parsed = rlmArgsSchema.safeParse(args);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
		throw new ToolError(`rlm() received invalid arguments: ${where}${issue?.message ?? "bad input"}`);
	}
	return parsed.data;
}

function assertRlmDepthAllowed(session: ToolSession): void {
	const taskDepth = session.taskDepth ?? 0;
	if (taskDepth >= EVAL_RLM_MAX_DEPTH) {
		throw new ToolError(
			`rlm() cannot spawn another agent at task depth ${taskDepth}; maximum depth is ${EVAL_RLM_MAX_DEPTH}.`,
		);
	}
}

function assertRlmSpawnAllowed(session: ToolSession, agentName: string): void {
	const parentSpawns = session.getSessionSpawns() ?? "*";
	if (parentSpawns === "*") return;
	if (parentSpawns === "") {
		throw new ToolError(`Cannot spawn '${agentName}' via rlm(). Allowed: none (spawns disabled for this agent)`);
	}
	const allowedSpawns = parentSpawns.split(",").map(spawn => spawn.trim());
	if (!allowedSpawns.includes(agentName)) {
		throw new ToolError(`Cannot spawn '${agentName}' via rlm(). Allowed: ${parentSpawns}`);
	}
}

function assertRlmNotPlanMode(session: ToolSession): void {
	if (session.getPlanModeState?.()?.enabled) {
		throw new ToolError("rlm() is unavailable in plan mode.");
	}
}

function trimToUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function outputIdBase(label: string | undefined, agentName: string): string {
	const source = trimToUndefined(label) ?? agentName ?? DEFAULT_RLM_LABEL;
	const sanitized = source.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 48);
	return sanitized || DEFAULT_RLM_LABEL;
}

function getOutputManager(session: ToolSession): AgentOutputManager {
	if (session.agentOutputManager) return session.agentOutputManager;
	const manager = new AgentOutputManager(session.getArtifactsDir ?? (() => null));
	session.agentOutputManager = manager;
	return manager;
}

async function getArtifacts(session: ToolSession): Promise<{
	sessionFile: string | null;
	artifactsDir: string;
	contextFile?: string;
}> {
	const sessionFile = session.getSessionFile();
	const sessionArtifactsDir = sessionFile ? sessionFile.slice(0, -6) : null;
	const artifactsDir = sessionArtifactsDir ?? path.join(os.tmpdir(), `aery-eval-rlm-${Snowflake.next()}`);
	await fs.mkdir(artifactsDir, { recursive: true });

	const shouldWriteConversationContext = session.settings.get("irc.enabled") !== true;
	const compactContext = shouldWriteConversationContext ? session.getCompactContext?.() : undefined;
	if (!compactContext) return { sessionFile, artifactsDir };

	const contextFile = path.join(artifactsDir, "context.md");
	await Bun.write(contextFile, compactContext);
	return { sessionFile, artifactsDir, contextFile };
}

function emitProgressStatus(emitStatus: ((event: JsStatusEvent) => void) | undefined, progress: AgentProgress): void {
	if (!emitStatus) return;
	const preview = (progress.assignment ?? progress.task ?? "").split("\n")[0]?.slice(0, 120);
	emitStatus({
		op: "agent",
		id: progress.id,
		agent: progress.agent,
		status: progress.status,
		lastIntent: progress.lastIntent,
		currentTool: progress.currentTool,
		currentToolArgs: progress.currentToolArgs,
		taskPreview: preview || undefined,
		toolCount: progress.toolCount,
		tokens: progress.tokens,
		contextTokens: progress.contextTokens,
		contextWindow: progress.contextWindow,
		cost: progress.cost,
		durationMs: progress.durationMs,
		model: progress.resolvedModel,
	});
}

/**
 * Spawn an async subagent on behalf of an eval cell's `rlm()` call.
 * Returns immediately with a handle; the subagent runs in the background.
 */
export async function runEvalRlm(args: unknown, options: EvalRlmBridgeOptions): Promise<EvalRlmHandle> {
	const parsed = parseRlmArgs(args);
	const agentName = parsed.agentType ?? DEFAULT_RLM_AGENT_TYPE;

	assertRlmNotPlanMode(options.session);
	assertRlmDepthAllowed(options.session);
	assertRlmSpawnAllowed(options.session, agentName);

	const { agents } = await taskDiscovery.discoverAgents(options.session.cwd);
	const agent = taskDiscovery.getAgent(agents, agentName);
	if (!agent) {
		const available = agents.map(candidate => candidate.name).join(", ") || "none";
		throw new ToolError(`Unknown agent "${agentName}". Available: ${available}`);
	}

	const effectiveAgent = agent;
	const parentActiveModelPattern = options.session.getActiveModelString?.();
	const agentModelOverrides = options.session.settings.get("task.agentModelOverrides");
	const modelOverride = resolveAgentModelPatterns({
		settingsOverride: parsed.model ?? agentModelOverrides[agentName],
		agentModel: effectiveAgent.model,
		settings: options.session.settings,
		activeModelPattern: parentActiveModelPattern,
		fallbackModelPattern: options.session.getModelString?.(),
	});
	const fileExtensions = await getFileExtensions(options.session.cwd);
	const availableSkills = filterSkillsJIT([...(options.session.skills ?? [])], fileExtensions);
	const resolvedAutoloadSkills =
		effectiveAgent.autoloadSkills?.length && availableSkills.length > 0
			? effectiveAgent.autoloadSkills
					.map(name => availableSkills.find(skill => skill.name === name))
					.filter((skill): skill is NonNullable<typeof skill> => skill !== undefined)
			: [];
	const contextFiles = options.session.contextFiles?.filter(
		file => path.basename(file.path).toLowerCase() !== "agents.md",
	);
	const localProtocolOptions: LocalProtocolOptions = options.session.localProtocolOptions ?? {
		getArtifactsDir: options.session.getArtifactsDir ?? (() => null),
		getSessionId: options.session.getSessionId ?? (() => null),
	};
	const parentArtifactManager = options.session.getArtifactManager?.() ?? undefined;
	const parentEvalSessionId = options.session.getEvalSessionId?.() ?? undefined;
	const mcpManager = options.session.mcpManager ?? MCPManager.instance();
	const { sessionFile, artifactsDir, contextFile } = await getArtifacts(options.session);
	const outputManager = getOutputManager(options.session);
	const id = await outputManager.allocate(outputIdBase(parsed.label, agentName));
	const assignment = parsed.prompt.trim();
	const context = trimToUndefined(parsed.context);

	// Generate a unique name for this subagent instance
	const subagentName = `${outputIdBase(parsed.label, agentName)}-${Snowflake.next()}`;

	// Build the handle to return immediately
	const handle: EvalRlmHandle = {
		id,
		name: subagentName,
		sessionId: options.session.getSessionId?.() ?? "unknown",
		model: modelOverride,
	};

	// Spawn the subagent asynchronously (don't await)
	const { onProgress, ...restOptions } = {
		cwd: options.session.cwd,
		agent: effectiveAgent,
		task: prompt.render(subagentUserPromptTemplate, { assignment: assignment.trim(), independentMode: false }),
		assignment,
		context,
		description: trimToUndefined(parsed.label),
		index: 0,
		id,
		taskDepth: options.session.taskDepth ?? 0,
		modelOverride,
		parentActiveModelPattern,
		thinkingLevel: effectiveAgent.thinkingLevel,
		outputSchema: parsed.schema,
		sessionFile,
		persistArtifacts: Boolean(sessionFile),
		artifactsDir,
		contextFile,
		enableLsp: (options.session.enableLsp ?? true) && options.session.settings.get("task.enableLsp"),
		signal: options.signal,
		eventBus: options.session.eventBus,
		onProgress: (progress: AgentProgress) => emitProgressStatus(options.emitStatus, progress),
		authStorage: options.session.authStorage,
		modelRegistry: options.session.modelRegistry,
		settings: options.session.settings,
		mcpManager,
		contextFiles,
		skills: availableSkills,
		autoloadSkills: resolvedAutoloadSkills,
		workspaceTree: options.session.workspaceTree,
		promptTemplates: options.session.promptTemplates,
		localProtocolOptions,
		parentArtifactManager,
		parentHindsightSessionState: options.session.getHindsightSessionState?.(),
		parentMnemopiSessionState: options.session.getMnemopiSessionState?.(),
		parentTelemetry: options.session.getTelemetry?.(),
		parentEvalSessionId,
	};

	// Fire and forget - subagent runs in background
	const _spawnPromise = withBridgeHeartbeat(options.emitStatus, () =>
		taskExecutor.runSubprocess(restOptions),
	);

	// Clean up on completion
	_spawnPromise.then(
		result => {
			if (result.exitCode !== 0 || result.error) {
				const failureMessage =
					result.error ?? result.stderr ?? result.abortReason ?? `rlm() subagent '${agentName}' failed.`;
				options.emitStatus?.({ op: "rlm", id, name: subagentName, status: "failed", error: failureMessage });
			}
			options.emitStatus?.({ op: "rlm", id, name: subagentName, status: "completed" });
		},
		error => {
			options.emitStatus?.({ op: "rlm", id, name: subagentName, status: "errored", error: String(error) });
		},
	);

	return handle;
}

/**
 * List active subagents spawned via rlm() for the current session.
 */
export function runEvalRlmList(_args: unknown, options: EvalRlmBridgeOptions): EvalRlmListResult {
	// Note: In a full implementation, this would query a registry of active subagents.
	// For now, we return an empty list since we don't have a global registry.
	// This can be enhanced with a session-scoped subagent tracker.
	return { subagents: [] };
}
