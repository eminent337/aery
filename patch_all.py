import re

# 1. session-observer-registry.ts
f1 = "packages/coding-agent/src/modes/session-observer-registry.ts"
content = open(f1).read()

# I will just write a python script to replace the contents accurately.
content1 = content.replace('aborted: "aborted",\n};', '''aborted: "aborted",
};

const MAX_RETAINED_TRANSCRIPT_REFERENCES = 1000;

function hasSameOwner(
	payload: Pick<SubagentLifecyclePayload | SubagentProgressPayload, "sessionFile">,
	snapshot: Pick<ObservableSession, "sessionFile">,
): boolean {
	if (payload.sessionFile !== undefined && snapshot.sessionFile !== undefined) {
		return payload.sessionFile === snapshot.sessionFile;
	}
	return true;
}

function addPruned(set: Set<string>, value: string, maxSize: number): void {
	set.delete(value);
	set.add(value);
	while (set.size > maxSize) {
		const oldest = set.keys().next();
		if (oldest.done) break;
		set.delete(oldest.value);
	}
}''')

content1 = content1.replace('this.#sessions.clear();\n\t\tthis.#listeners.clear();', '''this.#sessions.clear();
		this.#staleSubagentIds.clear();
		this.#listeners.clear();''')

content1 = content1.replace('''				const existing = this.#sessions.get(payload.id);
				if (existing) {
					existing.status = status;''', '''				const existing = this.#sessions.get(payload.id);
				if (existing && !hasSameOwner(payload, existing)) return;
				if (!existing && payload.status !== "started") return;
				if (payload.status === "started") {
					this.#staleSubagentIds.delete(payload.id);
				}

				if (existing) {
					existing.status = status;''')

content1 = content1.replace('''				const payload = data as SubagentProgressPayload;
				const progress = payload.progress;
				const id = progress.id;
				const existing = this.#sessions.get(id);

				if (existing) {
					existing.lastUpdate = Date.now();
					existing.progress = progress;
					if (progress.description) existing.description = progress.description;
					if (payload.sessionFile) existing.sessionFile = payload.sessionFile;
				} else {
					this.#sessions.set(id, {
						id,
						kind: "subagent",
						label: progress.description ?? `Subagent #${payload.index}`,
						agent: payload.agent,
						description: progress.description,
						status: "active",
						sessionFile: payload.sessionFile,
						lastUpdate: Date.now(),
						progress,
					});
				}
				this.#notifyListeners();''', '''				const payload = data as SubagentProgressPayload;
				const progress = payload.progress;
				const id = progress.id;
				if (this.#staleSubagentIds.has(id)) return;

				const existing = this.#sessions.get(id);
				if (!existing) return;
				if (!hasSameOwner(payload, existing)) return;

				existing.lastUpdate = Date.now();
				existing.progress = progress;
				if (progress.description) existing.description = progress.description;
				if (payload.sessionFile) existing.sessionFile = payload.sessionFile;
				this.#notifyListeners();''')

open(f1, "w").write(content1)

# 2. status-line.ts
f2 = "packages/coding-agent/src/modes/components/status-line.ts"
content2 = open(f2).read()

content2 = content2.replace('''	#cachedBranchRepoId: string | null | undefined = undefined;
	#gitWatcher: fs.FSWatcher | null = null;''', '''	#cachedBranchRepoId: string | null | undefined = undefined;
	#cachedBranchCwd: string | undefined = undefined;
	#gitWatcher: fs.FSWatcher | null = null;''')

content2 = content2.replace('''	#invalidateGitCaches(): void {
		this.#cachedBranch = undefined;
		this.#cachedBranchRepoId = undefined;
		this.#cachedPrContext = undefined;
	}
	#getCurrentBranch(): string | null {
		const head = git.head.resolveSync(getProjectDir());
		const gitHeadPath = head?.headPath ?? null;
		if (this.#cachedBranch !== undefined && this.#cachedBranchRepoId === gitHeadPath) {
			return this.#cachedBranch;
		}

		this.#cachedBranchRepoId = gitHeadPath;
		if (!head) {''', '''	#invalidateGitCaches(): void {
		this.#cachedBranch = undefined;
		this.#cachedBranchRepoId = undefined;
		this.#cachedBranchCwd = undefined;
		this.#cachedPrContext = undefined;
	}
	#getCurrentBranch(): string | null {
		const cwd = getProjectDir();
		if (this.#cachedBranch !== undefined && this.#cachedBranchCwd === cwd) {
			return this.#cachedBranch;
		}

		const head = git.head.resolveSync(cwd);
		const gitHeadPath = head?.headPath ?? null;
		this.#cachedBranchCwd = cwd;
		this.#cachedBranchRepoId = gitHeadPath;
		if (!head) {''')

open(f2, "w").write(content2)

# 3. builtin-registry.ts
f3 = "packages/coding-agent/src/slash-commands/builtin-registry.ts"
content3 = open(f3).read()

content3 = content3.replace('''/** Builtin command metadata used for slash-command autocomplete and help text. */''', '''export const BUILTIN_SLASH_COMMAND_RESERVED_NAMES: Set<string> = new Set(BUILTIN_SLASH_COMMAND_LOOKUP.keys());

/** Builtin command metadata used for slash-command autocomplete and help text. */''')

open(f3, "w").write(content3)

# 4. get-commands-handler.ts
f4 = "packages/coding-agent/src/extensibility/extensions/get-commands-handler.ts"
content4 = open(f4).read()

content4 = content4.replace('''import type { SkillsSettings } from "../../config/settings";
import type { CustomCommandSource, LoadedCustomCommand } from "../custom-commands";''', '''import type { SkillsSettings } from "../../config/settings";
import { BUILTIN_SLASH_COMMAND_RESERVED_NAMES } from "../../slash-commands/builtin-registry";
import type { CustomCommandSource, LoadedCustomCommand } from "../custom-commands";''')

content4 = content4.replace('''	const runner = session.extensionRunner;
	if (runner) {
		for (const cmd of runner.getRegisteredCommands()) {''', '''	const runner = session.extensionRunner;
	if (runner) {
		for (const cmd of runner.getRegisteredCommands(BUILTIN_SLASH_COMMAND_RESERVED_NAMES)) {''')

open(f4, "w").write(content4)

# 5. interactive-mode.ts
f5 = "packages/coding-agent/src/modes/interactive-mode.ts"
content5 = open(f5).read()

content5 = content5.replace('''import { BUILTIN_SLASH_COMMANDS, loadSlashCommands } from "../extensibility/slash-commands";
import type { Goal, GoalModeState } from "../goals/state";''', '''import { BUILTIN_SLASH_COMMANDS, loadSlashCommands } from "../extensibility/slash-commands";
import { BUILTIN_SLASH_COMMAND_RESERVED_NAMES } from "../slash-commands/builtin-registry";
import type { Goal, GoalModeState } from "../goals/state";''')

content5 = content5.replace('''		this.hideThinkingBlock = settings.get("hideThinkingBlock");

		const builtinCommandNames = new Set(BUILTIN_SLASH_COMMANDS.map(c => c.name));
		const hookCommands: SlashCommand[] = (
			this.session.extensionRunner?.getRegisteredCommands(builtinCommandNames) ?? []
		).map(cmd => ({''', '''		this.hideThinkingBlock = settings.get("hideThinkingBlock");

		const hookCommands: SlashCommand[] = (
			this.session.extensionRunner?.getRegisteredCommands(BUILTIN_SLASH_COMMAND_RESERVED_NAMES) ?? []
		).map(cmd => ({''')

open(f5, "w").write(content5)

# 6. executor.ts
f6 = "packages/coding-agent/src/eval/py/executor.ts"
content6 = open(f6).read()

content6 = content6.replace('''import * as path from "node:path";''', '''import * as fs from "node:fs";
import * as path from "node:path";''')

content6 = content6.replace('''} from "./kernel";
import { ensurePyToolBridge, registerPyToolBridge } from "./tool-bridge";''', '''} from "./kernel";
import { resolvePythonRuntime } from "./runtime";
import { ensurePyToolBridge, registerPyToolBridge } from "./tool-bridge";''')

content6 = content6.replace('''export interface PythonExecutorOptions {
	/** Working directory for command execution */
	cwd?: string;''', '''export interface PythonExecutorOptions {
	interpreter?: string;
	/** Working directory for command execution */
	cwd?: string;''')

content6 = content6.replace('''function normalizeSessionCwd(cwd: string): string {
	return path.resolve(cwd);
}

function buildSessionKey(sessionId: string, cwd: string): string {
	return `${sessionId}\\0${normalizeSessionCwd(cwd)}`;
}''', '''function normalizeSessionCwd(cwd: string): string {
	return path.resolve(cwd);
}

function normalizeExplicitInterpreter(cwd: string, interpreter: string | undefined): string {
	if (interpreter === undefined) return "";
	const resolved = resolvePythonRuntime(interpreter, cwd, {}).pythonPath;
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

function buildSessionKey(sessionId: string, cwd: string, interpreter: string | undefined): string {
	const normalizedCwd = normalizeSessionCwd(cwd);
	return `${sessionId}\\0${normalizedCwd}\\0${normalizeExplicitInterpreter(normalizedCwd, interpreter)}`;
}''')

content6 = content6.replace('''async function executeOnSession(code: string, cwd: string, options: PythonExecutorOptions): Promise<PythonResult> {
	const sessionId = options.sessionId ?? `session:${cwd}`;
	const sessionKey = buildSessionKey(sessionId, cwd);''', '''async function executeOnSession(code: string, cwd: string, options: PythonExecutorOptions): Promise<PythonResult> {
	const sessionId = options.sessionId ?? `session:${cwd}`;
	const sessionKey = buildSessionKey(sessionId, cwd, options.interpreter);''')

open(f6, "w").write(content6)

# 7. acp-agent.ts
f7 = "packages/coding-agent/src/modes/acp/acp-agent.ts"
content7 = open(f7).read()

content7 = content7.replace('''	promise: Promise<void>;
	release: (() => void) | undefined;
};

type PromptTurnState = {''', '''	promise: Promise<void>;
	release: (() => void) | undefined;
};
type PromptLifecycleError = Error & { readonly code: "ACP_SESSION_CLOSED" };

type PromptTurnState = {''')

content7 = content7.replace('''	// in `#disposeSessionRecord`. Lives independent of any prompt turn.
	lifetimeUnsubscribe: (() => void) | undefined;
};''', '''	// in `#disposeSessionRecord`. Lives independent of any prompt turn.
	lifetimeUnsubscribe: (() => void) | undefined;
	closedError: PromptLifecycleError | undefined;
	promptEventHandlers: Set<Promise<void>>;
	extensionUserMessageTasks: Set<Promise<void>>;
};''')

content7 = content7.replace('''			if (previousTurn) {
				// Wait for any prompt that's still settling or whose cancel cleanup is
				// still in flight. We deliberately swallow the prompt rejection (the
				// owning caller already received it) but let cleanup rejections
				// propagate — a timed-out cancel must fail this queued prompt instead
				// of letting it run on a session that is about to be closed.
				await previousTurn.promise.catch(() => undefined);
				await previousTurn.cleanup;
			}

			const converted = this.#convertPromptBlocks(params.prompt);''', '''			if (previousTurn) {
				// Wait for any prompt that's still settling or whose cancel cleanup is
				// still in flight. We deliberately swallow the prompt rejection (the
				// owning caller already received it) but let cleanup rejections
				// propagate — a timed-out cancel must fail this queued prompt instead
				// of letting it run on a session that is about to be closed.
				await previousTurn.promise.catch(() => undefined);
				await previousTurn.cleanup;
			}
			this.#throwIfRecordClosed(record);

			const converted = this.#convertPromptBlocks(params.prompt);''')

content7 = content7.replace('''			record.promptTurn.unsubscribe = record.session.subscribe(event => {
				void this.#handlePromptEvent(record, event);
			});''', '''			record.promptTurn.unsubscribe = record.session.subscribe(event => {
				this.#trackPromptEvent(record, event);
			});''')

content7 = content7.replace('''			release: releaseQueue,
		};
		await previousQueue.promise;
		try {
			return await run();''', '''			release: releaseQueue,
		};
		await previousQueue.promise;
		this.#throwIfRecordClosed(record);
		try {
			return await run();''')

content7 = content7.replace('''	async #runPromptOrCommand(record: ManagedSessionRecord, text: string, images: AgentImageContent[]): Promise<void> {''', '''	#throwIfRecordClosed(record: ManagedSessionRecord): void {
		if (record.closedError) {
			throw record.closedError;
		}
	}

	#createPromptLifecycleError(message: string): PromptLifecycleError {
		return Object.assign(new Error(message), { code: "ACP_SESSION_CLOSED" as const });
	}

	#trackPromptEvent(record: ManagedSessionRecord, event: AgentSessionEvent): void {
		const handling = this.#handlePromptEvent(record, event).catch((error: unknown) => {
			logger.warn("ACP prompt event handler failed", { error });
		});
		record.promptEventHandlers.add(handling);
		void handling.finally(() => {
			record.promptEventHandlers.delete(handling);
		});
	}

	async #waitForPromptEventHandlers(record: ManagedSessionRecord): Promise<void> {
		while (record.promptEventHandlers.size > 0) {
			await Promise.allSettled(Array.from(record.promptEventHandlers));
		}
	}

	#trackExtensionUserMessage(record: ManagedSessionRecord, task: Promise<void>): void {
		const tracked = task.catch((error: unknown) => {
			logger.warn("ACP extension sendUserMessage failed", { error });
		});
		record.extensionUserMessageTasks.add(tracked);
		void tracked.finally(() => {
			record.extensionUserMessageTasks.delete(tracked);
		});
	}

	async #waitForExtensionUserMessages(
		record: ManagedSessionRecord,
		baseline: ReadonlySet<Promise<void>>,
	): Promise<void> {
		while (true) {
			const pending = Array.from(record.extensionUserMessageTasks).filter(task => !baseline.has(task));
			if (pending.length === 0) {
				return;
			}
			await Promise.allSettled(pending);
		}
	}

	async #runPromptOrCommand(record: ManagedSessionRecord, text: string, images: AgentImageContent[]): Promise<void> {''')

content7 = content7.replace('''		await record.session.prompt(text, { images });
	}''', '''		const extensionPromptBaseline = new Set(record.extensionUserMessageTasks);
		await record.session.prompt(text, { images });
		// An ACP extension command can still call sendUserMessage(), which starts
		// an async nested prompt through the extension runtime. Keep the ACP turn
		// subscribed until those scheduled prompts and their event handlers drain;
		await this.#waitForExtensionUserMessages(record, extensionPromptBaseline);
		await this.#waitForPromptEventHandlers(record);
	}''')

content7 = content7.replace('''			liveMessageProgress: undefined,
			toolArgsById: new Map(),
			extensionsConfigured: false,
			lifetimeUnsubscribe: undefined,''', '''			liveMessageProgress: undefined,
			toolArgsById: new Map(),
			extensionsConfigured: false,
			closedError: undefined,
			promptEventHandlers: new Set(),
			extensionUserMessageTasks: new Set(),
			lifetimeUnsubscribe: undefined,''')

content7 = content7.replace('''				sendUserMessage: (content, options) => {
					record.session.sendUserMessage(content, options).catch((error: unknown) => {
						logger.warn("ACP extension sendUserMessage failed", { error });
					});
				},''', '''				sendUserMessage: (content, options) => {
					this.#trackExtensionUserMessage(record, record.session.sendUserMessage(content, options));
				},''')

content7 = content7.replace('''	async #closeManagedSession(sessionId: string, record: ManagedSessionRecord): Promise<void> {
		this.#sessions.delete(sessionId);''', '''	async #closeManagedSession(sessionId: string, record: ManagedSessionRecord): Promise<void> {
		record.closedError ??= this.#createPromptLifecycleError("ACP session closed before queued prompt could run");
		this.#sessions.delete(sessionId);''')

content7 = content7.replace('''			await Promise.all(
				records.map(async ([sessionId, record]) => {
					try {
						await this.#cancelPromptForClose(record);''', '''			await Promise.all(
				records.map(async ([sessionId, record]) => {
					try {
						record.closedError ??= this.#createPromptLifecycleError(
							"ACP agent disposed before queued prompt could run",
						);
						await this.#cancelPromptForClose(record);''')

open(f7, "w").write(content7)

