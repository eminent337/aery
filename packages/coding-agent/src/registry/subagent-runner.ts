/**
 * SubagentRunner: Background runner for subagents matching Google Antigravity (agy).
 *
 * Spawns subagents asynchronously, tracks them in AgentRegistry, and bridges
 * turn/tool events for live progress and status streaming.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry, MAIN_AGENT_ID } from "./agent-registry";
import { getSubagentDefinition } from "./builtin-subagents";
import { runSubagentQaReviews, type SubagentQaReviewRequest, type SubagentQaReviewResult } from "./subagent-qa";

export { runSubagentQaReviews, type SubagentQaReviewRequest, type SubagentQaReviewResult };

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
	workspace?: "inherit" | "branch" | "share" | "microvm";
	Workspace?: "inherit" | "branch" | "share" | "microvm";
	customTools?: string[];
	cwd?: string;
	mock?: boolean;
	sessionCreator?: (options: any) => Promise<{ session: any }>;
	acpClient?: import("../acp/client").AcpClient;
}

export interface SubagentLaunchResult {
	conversationId: string;
	logAbsoluteUri: string;
	workspaceUris: string[];
	resolvedModel: string;
}

export const SUBAGENT_MODEL_TIERS: Record<string, string> = {
	flash: "gemini-2.5-flash",
	flash_lite: "gemini-2.5-flash-lite",
	pro: "gemini-2.5-pro",
};

export const ANTHROPIC_SUBAGENT_MODEL_TIERS: Record<string, string> = {
	flash: "claude-3-5-haiku",
	flash_lite: "claude-3-5-haiku",
	pro: "claude-3-7-sonnet",
};

export const OPENAI_SUBAGENT_MODEL_TIERS: Record<string, string> = {
	flash: "gpt-4o-mini",
	flash_lite: "gpt-4o-mini",
	pro: "gpt-4o",
};

export const DEEPSEEK_SUBAGENT_MODEL_TIERS: Record<string, string> = {
	flash: "deepseek/deepseek-chat",
	flash_lite: "deepseek/deepseek-chat",
	pro: "deepseek/deepseek-reasoner",
};

export const LOCAL_SUBAGENT_MODEL_TIERS: Record<string, string> = {
	local: "ollama/qwen2.5-coder",
	flash: "ollama/qwen2.5-coder",
	flash_lite: "ollama/qwen2.5-coder",
	pro: "ollama/deepseek-r1:8b",
};

export const DEFAULT_SUBAGENT_MODEL = "gemini-2.5-flash";

export interface ResolveSubagentModelOptions {
	settings?: { getModelRoles?: () => Record<string, string> };
	isProviderAuthenticated?: (provider: string) => boolean;
}

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
 * Resolve a requested model tier ("flash", "flash_lite", "pro", "local", "inherit") to a concrete model identifier.
 * Incorporates user settings role mappings and authentication verification with parent fallback.
 */
export function resolveSubagentModel(
	model?: string,
	parentModel?: string,
	options?: ResolveSubagentModelOptions,
): string {
	const trimmed = model?.trim();
	if (!trimmed) {
		return parentModel || DEFAULT_SUBAGENT_MODEL;
	}

	const normalized = trimmed.toLowerCase().replace(/-/g, "_");
	if (normalized === "inherit") {
		return parentModel || DEFAULT_SUBAGENT_MODEL;
	}

	// 1. Check user settings configured model roles (e.g. smol, task, slow, vision)
	const configuredRoles = options?.settings?.getModelRoles?.() ?? {};
	if (trimmed in configuredRoles && configuredRoles[trimmed]) {
		return configuredRoles[trimmed];
	}
	if (normalized in configuredRoles && configuredRoles[normalized]) {
		return configuredRoles[normalized];
	}

	// 2. Check for local tier
	if (normalized === "local") {
		return LOCAL_SUBAGENT_MODEL_TIERS.local;
	}

	let candidate = trimmed;
	const parentLower = parentModel?.toLowerCase() ?? "";

	// 3. Provider-specific speed tiers based on parent model
	if (parentLower.includes("deepseek")) {
		if (normalized in DEEPSEEK_SUBAGENT_MODEL_TIERS) {
			candidate = DEEPSEEK_SUBAGENT_MODEL_TIERS[normalized];
		}
	} else if (parentLower.includes("claude") || parentLower.includes("anthropic")) {
		if (normalized in ANTHROPIC_SUBAGENT_MODEL_TIERS) {
			candidate = ANTHROPIC_SUBAGENT_MODEL_TIERS[normalized];
		}
	} else if (parentLower.includes("gpt") || parentLower.includes("openai")) {
		if (normalized in OPENAI_SUBAGENT_MODEL_TIERS) {
			candidate = OPENAI_SUBAGENT_MODEL_TIERS[normalized];
		}
	} else if (parentLower.includes("ollama") || parentLower.includes("local")) {
		if (normalized in LOCAL_SUBAGENT_MODEL_TIERS) {
			candidate = LOCAL_SUBAGENT_MODEL_TIERS[normalized];
		}
	} else if (normalized in SUBAGENT_MODEL_TIERS) {
		candidate = SUBAGENT_MODEL_TIERS[normalized];
	}

	// 4. Auth-aware check with safe parent fallback
	if (options?.isProviderAuthenticated && candidate.includes("/")) {
		const [provider] = candidate.split("/");
		const isKeyless = provider === "ollama" || provider === "llama.cpp" || provider === "lm-studio";
		if (!isKeyless && !options.isProviderAuthenticated(provider)) {
			return parentModel || DEFAULT_SUBAGENT_MODEL;
		}
	}

	return candidate;
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
	getLastAssistantText?(): string | undefined;
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
		getLastAssistantText() {
			return "Mock subagent execution complete";
		},
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

		let effectiveCwd = opts.cwd;
		if (opts.workspace === "branch" || opts.workspace === "share" || opts.workspace === "microvm") {
			effectiveCwd = path.resolve(opts.cwd, ".system_generated", "workspaces", conversationId);
		}

		const logPath = path.resolve(opts.cwd, ".system_generated", "logs", `${conversationId}.jsonl`);
		const logAbsoluteUri = `file://${logPath}`;
		const workspaceUris = [effectiveCwd];

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
			status: opts.prompt?.trim() ? "running" : "idle",
		});

		// AgentRegistry.attachSession handles turn_start, turn_end, tool_execution_start/end.
		// wireAgentEndEvent only listens for terminal agent_end without duplicate subscriptions.
		wireAgentEndEvent(this.registry, conversationId, session);

		if (opts.prompt && typeof session?.prompt === "function") {
			this.runBackgroundExecution(conversationId, session, opts);
		}

		return {
			conversationId,
			logAbsoluteUri,
			workspaceUris,
			resolvedModel,
		};
	}

	/**
	 * Run subagent prompt in background and trigger reactive wakeup upon completion or failure.
	 */
	runBackgroundExecution(conversationId: string, session: any, opts: { prompt?: string; parentId?: string }): void {
		void (async () => {
			if (session) {
				(session as any).__sentParentMessage = false;
			}
			try {
				if (opts.prompt && typeof session?.prompt === "function") {
					await session.prompt(opts.prompt);
				}
				if (typeof session?.waitForIdle === "function") {
					await session.waitForIdle();
				}

				// Check if subagent already notified the parent during this turn
				const alreadyNotified = (session as any)?.__sentParentMessage === true;

				if (!alreadyNotified) {
					const parentId = opts.parentId || MAIN_AGENT_ID;
					const parentRef = this.registry.get(parentId);
					const parentSession = parentRef?.session as any;

					let finalOutput =
						typeof session?.getLastAssistantText === "function"
							? session.getLastAssistantText()
							: ((session as any)?.lastAssistantText ?? "Task completed.");

					// Parallel Two-Stage QA Review check if code diff is present
					try {
						const diff =
							typeof (session as any)?.getDiff === "function"
								? await (session as any).getDiff()
								: (session as any)?.diff;
						if (diff && typeof diff === "string" && diff.trim().length > 0) {
							const qaResult = await runSubagentQaReviews({
								subagentId: conversationId,
								role: opts.role ?? "Subagent",
								prompt: opts.prompt ?? "",
								diff,
							});
							const badge = qaResult.approved ? "APPROVED" : "ISSUES_FLAGGED";
							let qaNotice = `\n\n[Two-Stage QA Review: ${badge}]`;
							const issues = [...qaResult.specReview.issues, ...qaResult.qualityReview.issues];
							if (issues.length > 0) {
								qaNotice += `\nIssues detected:\n- ${issues.join("\n- ")}`;
							}
							finalOutput = `${finalOutput || ""}${qaNotice}`;
						}
					} catch {
						// QA review is non-blocking
					}

					if (parentSession && typeof parentSession.sendCustomMessage === "function") {
						try {
							const timestamp = new Date().toISOString();
							const completionNotice = `<SYSTEM_MESSAGE>\n[Message] timestamp=${timestamp} sender=${conversationId} priority=MESSAGE_PRIORITY_HIGH content=Subagent completed execution:\n\n${finalOutput || "Task completed."}\n</SYSTEM_MESSAGE>`;
							await parentSession.sendCustomMessage(
								{
									customType: "agent_message",
									content: completionNotice,
									display: true,
									details: { from: conversationId, priority: "MESSAGE_PRIORITY_HIGH", status: "completed" },
									attribution: "agent",
								},
								{ triggerTurn: true, deliverAs: "followUp" },
							);
						} catch {
							// Parent session might have aborted or closed; ignore delivery failure
						}
					}
				}
			} catch (error) {
				const isAborted =
					this.registry.get(conversationId)?.status === "aborted" ||
					(error as any)?.name === "AbortError" ||
					String((error as any)?.message ?? "")
						.toLowerCase()
						.includes("abort");

				if (!isAborted) {
					const parentId = opts.parentId || MAIN_AGENT_ID;
					const parentRef = this.registry.get(parentId);
					const parentSession = parentRef?.session as any;

					if (parentSession && typeof parentSession.sendCustomMessage === "function") {
						try {
							const timestamp = new Date().toISOString();
							const failureNotice = `<SYSTEM_MESSAGE>\n[Message] timestamp=${timestamp} sender=${conversationId} priority=MESSAGE_PRIORITY_HIGH content=Subagent terminated with error: ${error instanceof Error ? error.message : String(error)}\n</SYSTEM_MESSAGE>`;
							await parentSession.sendCustomMessage(
								{
									customType: "agent_message",
									content: failureNotice,
									display: true,
									details: { from: conversationId, priority: "MESSAGE_PRIORITY_HIGH", status: "error" },
									attribution: "agent",
								},
								{ triggerTurn: true, deliverAs: "followUp" },
							);
						} catch {
							// Parent session might have aborted or closed; ignore delivery failure
						}
					}
				}
			} finally {
				const currentStatus = this.registry.get(conversationId)?.status;
				if (currentStatus !== "aborted") {
					this.registry.setStatus(conversationId, "idle");
				}
				this.registry.setProgress(conversationId, {
					currentTool: undefined,
					currentToolArgs: undefined,
				});
			}
		})();
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

		let effectiveCwd = opts.cwd;
		let isolationHandle: import("../task/worktree").IsolationHandle | undefined;
		let createdScratchDir: string | undefined;

		if (opts.workspace === "branch" || opts.workspace === "share" || opts.workspace === "microvm") {
			try {
				const { ensureIsolation } = await import("../task/worktree");
				isolationHandle = await ensureIsolation(opts.cwd, conversationId);
				effectiveCwd = isolationHandle.mergedDir;
			} catch {
				// Fallback to isolated scratch workspace directory
				try {
					const fallbackDir = path.resolve(opts.cwd, ".system_generated", "workspaces", conversationId);
					await fs.mkdir(fallbackDir, { recursive: true });
					effectiveCwd = fallbackDir;
					createdScratchDir = fallbackDir;
				} catch {
					const tmpDir = path.resolve(os.tmpdir(), "aery-workspaces", conversationId);
					await fs.mkdir(tmpDir, { recursive: true });
					effectiveCwd = tmpDir;
					createdScratchDir = tmpDir;
				}
			}
		}

		const logPath = path.resolve(opts.cwd, ".system_generated", "logs", `${conversationId}.jsonl`);
		const logAbsoluteUri = `file://${logPath}`;
		const workspaceUris = [effectiveCwd];

		if (opts.typeName === "opencode") {
			this.registry.register({
				id: conversationId,
				displayName: `${opts.role} [${opts.typeName}]`,
				kind: "sub",
				parentId: opts.parentId,
				session: null,
				sessionFile: null,
				status: opts.prompt?.trim() ? "running" : "idle",
			});

			try {
				const { OpencodeSubagentSession } = await import("../acp");
				const session = new OpencodeSubagentSession({
					conversationId,
					cwd: effectiveCwd,
					logPath,
					client: options.acpClient,
				});

				if (isolationHandle || createdScratchDir) {
					const origDispose = session.dispose.bind(session);
					session.dispose = async () => {
						try {
							await origDispose();
						} finally {
							if (isolationHandle) {
								const handleToClean = isolationHandle;
								isolationHandle = undefined;
								try {
									const { cleanupIsolation } = await import("../task/worktree");
									await cleanupIsolation(handleToClean);
								} catch {}
							}
							if (createdScratchDir) {
								const dirToClean = createdScratchDir;
								createdScratchDir = undefined;
								try {
									await fs.rm(dirToClean, { recursive: true, force: true });
								} catch {}
							}
						}
					};
				}

				this.registry.attachSession(conversationId, session as any, logPath);
				wireAgentEndEvent(this.registry, conversationId, session);

				if (opts.prompt) {
					this.runBackgroundExecution(conversationId, session, opts);
				}

				return {
					conversationId,
					logAbsoluteUri,
					workspaceUris,
					resolvedModel: "opencode-acp",
				};
			} catch (error) {
				if (isolationHandle) {
					try {
						const { cleanupIsolation } = await import("../task/worktree");
						await cleanupIsolation(isolationHandle);
					} catch {}
				}
				if (createdScratchDir) {
					try {
						await fs.rm(createdScratchDir, { recursive: true, force: true });
					} catch {}
				}
				this.registry.unregister(conversationId);
				throw error;
			}
		}

		const customCreator = options.sessionCreator ?? this.sessionCreator;

		try {
			const createSession =
				customCreator ??
				(async (creatorOpts: any) => {
					const { createAgentSession } = await import("../sdk");
					return createAgentSession(creatorOpts);
				});

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
				status: opts.prompt?.trim() ? "running" : "idle",
			});

			const { session } = await createSession({
				cwd: effectiveCwd,
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

			if ((isolationHandle || createdScratchDir) && typeof (session as any)?.dispose === "function") {
				const origDispose = (session as any).dispose.bind(session);
				(session as any).dispose = async () => {
					try {
						await origDispose();
					} finally {
						if (isolationHandle) {
							const handleToClean = isolationHandle;
							isolationHandle = undefined;
							try {
								const { cleanupIsolation } = await import("../task/worktree");
								await cleanupIsolation(handleToClean);
							} catch {}
						}
						if (createdScratchDir) {
							const dirToClean = createdScratchDir;
							createdScratchDir = undefined;
							try {
								await fs.rm(dirToClean, { recursive: true, force: true });
							} catch {}
						}
					}
				};
			}

			const sessionFile =
				typeof (session as any)?.sessionManager?.getSessionFile === "function"
					? ((session as any).sessionManager.getSessionFile() ?? null)
					: logPath;

			this.registry.attachSession(conversationId, session, sessionFile);
			wireAgentEndEvent(this.registry, conversationId, session);

			if (opts.prompt && typeof session?.prompt === "function") {
				this.runBackgroundExecution(conversationId, session, opts);
			}

			return {
				conversationId,
				logAbsoluteUri,
				workspaceUris,
				resolvedModel,
			};
		} catch (error) {
			if (isolationHandle) {
				try {
					const { cleanupIsolation } = await import("../task/worktree");
					await cleanupIsolation(isolationHandle);
				} catch {}
			}
			if (createdScratchDir) {
				try {
					await fs.rm(createdScratchDir, { recursive: true, force: true });
				} catch {}
			}
			this.registry.unregister(conversationId);
			if (opts.mock || (!customCreator && (process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test"))) {
				return await this.launchMock(options);
			}
			throw new Error(
				`Failed to launch subagent "${conversationId}": ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
	}
}
