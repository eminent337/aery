/**
 * SubagentRunner — Background runner for subagents matching Google Antigravity (agy).
 *
 * Spawns subagents asynchronously, tracks them in AgentRegistry, and bridges
 * turn/tool events for live progress and status streaming.
 */

import * as path from "node:path";
import { AgentRegistry } from "./agent-registry";
import { getSubagentDefinition } from "./builtin-subagents";

export interface SubagentLaunchOptions {
	typeName?: string;
	TypeName?: string;
	role?: string;
	Role?: string;
	prompt?: string;
	Prompt?: string;
	model?: string;
	Model?: string;
	parentModel?: string;
	parentId?: string;
	workspace?: "inherit" | "branch" | "share";
	Workspace?: "inherit" | "branch" | "share";
	customTools?: string[];
	cwd?: string;
	mock?: boolean;
	sessionCreator?: (options: any) => Promise<{ session: any }>;
}

export interface SubagentLaunchResult {
	conversationId: string;
	logAbsoluteUri: string;
	workspaceUris: string[];
}

export const SUBAGENT_MODEL_TIERS: Record<string, string> = {
	flash: "gemini-2.5-flash",
	flash_lite: "gemini-2.5-flash-lite",
	pro: "gemini-2.5-pro",
};

export const DEFAULT_SUBAGENT_MODEL = "gemini-2.5-flash";

/**
 * Generate a stable, human-readable conversation ID for a subagent.
 * Starts with 'sub-' and includes a normalized role slug.
 */
export function generateConversationId(role: string): string {
	const slug =
		role
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "agent";
	const timestamp = Date.now().toString(36);
	const randomSuffix = Math.random().toString(36).substring(2, 7);
	return `sub-${slug}-${timestamp}-${randomSuffix}`;
}

/**
 * Resolve the toolset granted to a subagent type.
 * Always ensures 'send_message' is included so the child can communicate with the parent.
 */
export function resolveSubagentTools(typeName: string, customTools?: string[]): string[] {
	let tools: string[];
	if (customTools && customTools.length > 0) {
		tools = [...customTools];
	} else {
		const def = getSubagentDefinition(typeName);
		if (def && def.tools) {
			tools = [...def.tools];
		} else {
			// Fallback read-only tools
			tools = ["read_file", "search_web", "find_by_name", "grep_search", "list_dir", "send_message"];
		}
	}

	// Always ensure send_message is included so child agents can talk to parent
	if (!tools.includes("send_message")) {
		tools.push("send_message");
	}

	return tools;
}

/**
 * Resolve a requested model tier ("flash", "flash_lite", "pro", "inherit") to a concrete model identifier.
 */
export function resolveSubagentModel(model?: string, parentModel?: string): string {
	const normalized = model?.trim();
	if (!normalized || normalized === "inherit") {
		return parentModel || DEFAULT_SUBAGENT_MODEL;
	}
	if (normalized in SUBAGENT_MODEL_TIERS) {
		return SUBAGENT_MODEL_TIERS[normalized];
	}
	return normalized;
}

function normalizeLaunchOptions(options: SubagentLaunchOptions) {
	const typeName = options.typeName || options.TypeName || "self";
	const role = options.role || options.Role || "Subagent";
	const prompt = options.prompt || options.Prompt || "";
	const model = options.model || options.Model || "inherit";
	const workspace = options.workspace || options.Workspace || "inherit";
	const cwd = options.cwd || process.cwd();
	const parentId = options.parentId;
	const parentModel = options.parentModel;
	const customTools = options.customTools;
	const mock = options.mock;
	return {
		typeName,
		role,
		prompt,
		model,
		workspace,
		cwd,
		parentId,
		parentModel,
		customTools,
		mock,
	};
}

export interface MockSubagentSession {
	listeners: Set<(event: any) => void>;
	model?: string;
	tools?: string[];
	conversationId?: string;
	sessionManager?: { getSessionFile: () => string };
	subscribe(cb: (event: any) => void): () => void;
	emitEvent(event: any): void;
	sendCustomMessage(msg: any): Promise<void>;
	dispose(): Promise<void>;
	abort(): Promise<void>;
	waitForIdle(): Promise<void>;
	prompt(text: string): Promise<void>;
}

export function createMockSubagentSession(logPath?: string): MockSubagentSession {
	const listeners = new Set<(event: any) => void>();
	return {
		listeners,
		sessionManager: logPath ? { getSessionFile: () => logPath } : undefined,
		subscribe(cb: (event: any) => void) {
			listeners.add(cb);
			return () => {
				listeners.delete(cb);
			};
		},
		emitEvent(event: any) {
			for (const listener of Array.from(listeners)) {
				try {
					listener(event);
				} catch {
					// listener errors must not break dispatch
				}
			}
		},
		async sendCustomMessage(_msg: any) {},
		async dispose() {},
		async abort() {},
		async waitForIdle() {},
		async prompt(_text: string) {},
	};
}

function wireAgentEndEvent(registry: AgentRegistry, conversationId: string, session: any): void {
	if (typeof session?.subscribe === "function") {
		session.subscribe((event: any) => {
			if (event?.type === "agent_end") {
				registry.setStatus(conversationId, "idle");
				registry.setProgress(conversationId, {
					currentTool: undefined,
					currentToolArgs: undefined,
				});
			}
		});
	}
}

export class SubagentRunner {
	constructor(
		private readonly registry: AgentRegistry = AgentRegistry.global(),
		private readonly sessionCreator?: (options: any) => Promise<{ session: any }>,
	) {}

	/**
	 * Launch a mock subagent session for testing without live LLM calls.
	 */
	async launchMock(options: SubagentLaunchOptions): Promise<SubagentLaunchResult> {
		const opts = normalizeLaunchOptions(options);
		const conversationId = generateConversationId(opts.role);
		const resolvedModel = resolveSubagentModel(opts.model, opts.parentModel);
		const resolvedTools = resolveSubagentTools(opts.typeName, opts.customTools);

		const logPath = path.resolve(opts.cwd, ".system_generated", "logs", `${conversationId}.jsonl`);
		const logAbsoluteUri = `file://${logPath}`;
		const workspaceUris = [opts.cwd];

		const session = createMockSubagentSession(logPath);
		session.model = resolvedModel;
		session.tools = resolvedTools;
		session.conversationId = conversationId;

		this.registry.register({
			id: conversationId,
			displayName: `${opts.role} [${opts.typeName}]`,
			kind: "sub",
			parentId: opts.parentId,
			session: session as any,
			sessionFile: logPath,
			status: "running",
		});

		// AgentRegistry.attachSession handles turn_start, turn_end, tool_execution_start/end.
		// wireAgentEndEvent only listens for terminal agent_end without duplicate subscriptions.
		wireAgentEndEvent(this.registry, conversationId, session);

		return {
			conversationId,
			logAbsoluteUri,
			workspaceUris,
		};
	}

	/**
	 * Launch a subagent session. In runtime environments with live LLM credentials,
	 * creates an AgentSession.
	 */
	async launch(options: SubagentLaunchOptions): Promise<SubagentLaunchResult> {
		const opts = normalizeLaunchOptions(options);
		const conversationId = generateConversationId(opts.role);
		const resolvedModel = resolveSubagentModel(opts.model, opts.parentModel);
		const resolvedTools = resolveSubagentTools(opts.typeName, opts.customTools);

		const logPath = path.resolve(opts.cwd, ".system_generated", "logs", `${conversationId}.jsonl`);
		const logAbsoluteUri = `file://${logPath}`;
		const workspaceUris = [opts.cwd];

		const sessionCreator = options.sessionCreator ?? this.sessionCreator;
		if (sessionCreator) {
			const def = getSubagentDefinition(opts.typeName);
			const systemPrompt = def?.systemPrompt;
			const { session } = await sessionCreator({
				cwd: opts.cwd,
				agentId: conversationId,
				agentDisplayName: `${opts.role} [${opts.typeName}]`,
				agentRegistry: this.registry,
				taskDepth: 1,
				parentTaskPrefix: opts.parentId,
				modelPattern: resolvedModel,
				toolNames: resolvedTools.includes("*") ? undefined : resolvedTools,
				systemPrompt: systemPrompt ? [systemPrompt] : undefined,
				hasUI: false,
			});

			const sessionFile =
				typeof (session as any)?.sessionManager?.getSessionFile === "function"
					? ((session as any).sessionManager.getSessionFile() ?? null)
					: logPath;

			this.registry.register({
				id: conversationId,
				displayName: `${opts.role} [${opts.typeName}]`,
				kind: "sub",
				parentId: opts.parentId,
				session,
				sessionFile,
				status: "running",
			});

			wireAgentEndEvent(this.registry, conversationId, session);

			if (opts.prompt && typeof session?.prompt === "function") {
				void session.prompt(opts.prompt).catch(() => {});
			}

			return {
				conversationId,
				logAbsoluteUri,
				workspaceUris,
			};
		}

		try {
			const { createAgentSession } = await import("../sdk");
			const def = getSubagentDefinition(opts.typeName);
			const systemPrompt = def?.systemPrompt;

			// Pre-register so that early session initialization and IRC peer rosters observe this subagent
			this.registry.register({
				id: conversationId,
				displayName: `${opts.role} [${opts.typeName}]`,
				kind: "sub",
				parentId: opts.parentId,
				session: null,
				sessionFile: null,
				status: "running",
			});

			const { session } = await createAgentSession({
				cwd: opts.cwd,
				agentId: conversationId,
				agentDisplayName: `${opts.role} [${opts.typeName}]`,
				agentRegistry: this.registry,
				taskDepth: 1,
				parentTaskPrefix: opts.parentId,
				modelPattern: resolvedModel,
				toolNames: resolvedTools.includes("*") ? undefined : resolvedTools,
				systemPrompt: systemPrompt ? [systemPrompt] : undefined,
				hasUI: false,
			});

			const sessionFile =
				typeof (session as any)?.sessionManager?.getSessionFile === "function"
					? ((session as any).sessionManager.getSessionFile() ?? null)
					: null;

			this.registry.attachSession(conversationId, session, sessionFile);
			wireAgentEndEvent(this.registry, conversationId, session);

			if (opts.prompt && typeof session?.prompt === "function") {
				void session.prompt(opts.prompt).catch(() => {});
			}

			return {
				conversationId,
				logAbsoluteUri,
				workspaceUris,
			};
		} catch (error) {
			if (opts.mock || process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test") {
				return await this.launchMock(options);
			}
			throw new Error(
				`Failed to launch subagent "${conversationId}": ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
	}
}
