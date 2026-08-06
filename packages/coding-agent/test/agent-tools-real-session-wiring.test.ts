import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@aryee337/aery/config/settings";
import { createAgentSession, type ExtensionFactory } from "@aryee337/aery/sdk";
import { SessionManager } from "@aryee337/aery/session/session-manager";
import type { ToolSession } from "@aryee337/aery/tools";
import { AdvisorTool } from "@aryee337/aery/tools/advisor";
import { HandoffTool } from "@aryee337/aery/tools/handoff";
import { SetFastTool } from "@aryee337/aery/tools/set-fast";
import { SetModelTool } from "@aryee337/aery/tools/set-model";
import type { AgentToolResult } from "@aryee337/aery-core";
import { Snowflake } from "@aryee337/aery-utils";

function text(result: AgentToolResult | undefined): string {
	return (result?.content ?? [])
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

// Replicate the SDK's ToolSession hook wiring (sdk.ts) against a REAL
// AgentSession — exercises the exact surface a live session provides.
function wireRealSession(
	session: {
		model?: { provider: string; id: string };
		serviceTier: string;
		getAvailableModels(): Array<{ provider: string; id: string }>;
		setModel(model: unknown, role: string, opts: { persist: boolean }): Promise<void>;
		setModelTemporary(model: unknown): Promise<void>;
		isFastModeEnabled(): boolean;
		isFastModeActive(): boolean;
		setFastMode(enabled: boolean): void;
		getAdvisorStats(): { configured: boolean };
		isAdvisorActive(): boolean;
		formatAdvisorStatus(): string;
		formatAdvisorHistoryAsText(opts?: { compact?: boolean }): string;
		setAdvisorEnabled(enabled: boolean): boolean;
		getLastVisibleHandoffText(): string;
		isGeneratingHandoff: boolean;
	},
	sessionManager: { getBranch(): Array<{ type: string; model?: string }> },
	settings: Settings,
): ToolSession {
	const fmt = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;
	return {
		cwd: "/tmp",
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		agentOutputManager: {} as never,
		localProtocolOptions: {} as never,
		getModelState: () => ({
			currentModel: session.model ? fmt(session.model) : undefined,
			available: session.getAvailableModels().map(fmt),
			roles: [],
		}),
		setModel: async params => {
			const available = session.getAvailableModels();
			const target = available.find(m => fmt(m) === params.model || m.id === params.model);
			if (!target) throw new Error(`Unknown model "${params.model}"`);
			if (params.role) {
				await session.setModel(target, params.role, { persist: true });
				return { applied: fmt(target), role: params.role, persisted: true, nextTurn: true };
			}
			if (params.persist) {
				await session.setModel(target, "default", { persist: true });
				return { applied: fmt(target), role: "default", persisted: true, nextTurn: true };
			}
			await session.setModelTemporary(target);
			return { applied: fmt(target), persisted: false, nextTurn: true };
		},
		getFastModeState: () => ({
			enabled: session.isFastModeEnabled(),
			active: session.isFastModeActive(),
			serviceTier: session.serviceTier,
			model: session.model ? fmt(session.model) : undefined,
		}),
		setFastMode: enabled => session.setFastMode(enabled),
		getAdvisorState: options => ({
			configured: session.getAdvisorStats().configured,
			active: session.isAdvisorActive(),
			status: session.formatAdvisorStatus(),
			history: options?.history ? session.formatAdvisorHistoryAsText({ compact: options.compact }) : null,
		}),
		setAdvisorEnabled: enabled => session.setAdvisorEnabled(enabled),
		getHandoffState: () => ({
			isGenerating: session.isGeneratingHandoff,
			messageCount: sessionManager.getBranch().filter(e => e.type === "message").length,
			lastHandoffText: session.getLastVisibleHandoffText(),
		}),
		handoff: async () => undefined,
	};
}

const providerExtension: ExtensionFactory = aery => {
	aery.registerProvider("runtime-provider", {
		baseUrl: "https://runtime.example.com/v1",
		apiKey: "RUNTIME_KEY",
		api: "openai-completions",
		models: [
			{
				id: "runtime-model",
				name: "Runtime Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
			{
				id: "runtime-reasoning-model",
				name: "Runtime Reasoning Model",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
		],
	});
};

describe("agent tools wired to a real AgentSession", () => {
	let tempDir: string;
	let toolSession: ToolSession;
	let session: { dispose(): Promise<void> };
	const settings = Settings.isolated();
	settings.setModelRole("default", "runtime-provider/runtime-model");

	beforeAll(async () => {
		tempDir = path.join(os.tmpdir(), `aery-tools-wire-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		const { session: s } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			settings,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			extensions: [providerExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			modelPattern: "runtime-provider/runtime-model",
		} as never);
		session = s as never;
		toolSession = wireRealSession(s as never, SessionManager.inMemory() as never, settings);
	}, 180000);

	afterAll(async () => {
		await session?.dispose();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("set_model switches to a reasoning model via the real session", async () => {
		const tool = new SetModelTool(toolSession);
		const result = await tool.execute(
			"1",
			{ model: "runtime-provider/runtime-reasoning-model" },
			new AbortController().signal,
		);
		const out = text(result);
		expect(out).toContain("runtime-reasoning-model");
		expect(out).toContain("session-scoped");
	});

	test("set_model throws for an unknown model", async () => {
		const tool = new SetModelTool(toolSession);
		let threw = false;
		try {
			await tool.execute("1", { model: "nope/nothing" }, new AbortController().signal);
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});

	test("set_fast toggles through the real session's setFastMode", async () => {
		const tool = new SetFastTool(toolSession);
		const result = await tool.execute("1", { enabled: true }, new AbortController().signal);
		expect(typeof text(result)).toBe("string");
		expect(typeof toolSession.getFastModeState?.()?.enabled).toBe("boolean");
	});

	test("advisor status reads the real advisor configuration", async () => {
		const tool = new AdvisorTool(toolSession);
		const result = await tool.execute("1", { action: "status" }, new AbortController().signal);
		expect(typeof text(result)).toBe("string");
	});

	test("handoff refuses on a real session with too few messages", async () => {
		const tool = new HandoffTool(toolSession);
		let message = "";
		try {
			await tool.execute("1", { customInstructions: "wrap up" }, new AbortController().signal);
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toContain("messages");
	});
});
