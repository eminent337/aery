/**
 * State Manager for Connect Platform Hub.
 * Supports multiple bot tokens, individual bot reload/disconnect, and secure passcodes.
 */

import { settings } from "../../../config/settings.js";
import type { BotInstance, PlatformConfig, PlatformId } from "./types.js";

// Active bot handles map stored by composite key `${platformId}:${token}`
const activeBotInstances = new Map<string, any>();
const botErrors = new Map<string, string>();

function parseTokenList(raw: string | undefined): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) return parsed.filter(t => typeof t === "string" && t.trim().length > 0);
	} catch {}
	return raw
		.split(",")
		.map(t => t.trim())
		.filter(Boolean);
}

function getBotKey(platformId: PlatformId, token: string): string {
	return `${platformId}:${token.trim()}`;
}

export function getBotDisplayName(token: string): string {
	const trimmed = token.trim();
	if (trimmed.includes(":")) {
		// Telegram style <id>:<secret>
		const id = trimmed.split(":")[0];
		return `Bot (${id})`;
	}
	if (trimmed.length > 12) {
		return `Bot (${trimmed.slice(0, 6)}...${trimmed.slice(-4)})`;
	}
	return `Bot (${trimmed})`;
}

export class ConnectStateManager {
	constructor(
		private readonly cwd: string,
		private readonly sessionFile?: string,
	) {}

	getBotTokens(platformId: PlatformId): string[] {
		const settingKey = `connectors.${platformId}.botTokens` as any;
		const fallbackKey = `connectors.${platformId}.botToken` as any;

		const listRaw = settings.get(settingKey) as string | undefined;
		const tokens = parseTokenList(listRaw);

		const single = settings.get(fallbackKey) as string | undefined;
		if (single && single.trim().length > 0 && !tokens.includes(single.trim())) {
			tokens.unshift(single.trim());
		}

		return tokens;
	}

	saveBotTokens(platformId: PlatformId, tokens: string[]): void {
		const settingKey = `connectors.${platformId}.botTokens` as any;
		settings.set(settingKey, JSON.stringify(tokens) as any);
		if (tokens.length > 0) {
			settings.set(`connectors.${platformId}.botToken` as any, tokens[0] as any);
		} else {
			settings.set(`connectors.${platformId}.botToken` as any, undefined as any);
		}
	}

	addBotToken(platformId: PlatformId, token: string): void {
		const trimmed = token.trim();
		if (!trimmed) return;
		const current = this.getBotTokens(platformId);
		if (!current.includes(trimmed)) {
			current.push(trimmed);
			this.saveBotTokens(platformId, current);
		}
	}

	removeBotToken(platformId: PlatformId, token: string): void {
		const trimmed = token.trim();
		void this.disconnectBot(platformId, trimmed);
		const current = this.getBotTokens(platformId).filter(t => t !== trimmed);
		this.saveBotTokens(platformId, current);
	}

	async loadPlatforms(): Promise<PlatformConfig[]> {
		const slackTokens = this.getBotTokens("slack");
		const telegramTokens = this.getBotTokens("telegram");
		const slackAppToken = settings.get("connectors.slack.appToken" as any) as string | undefined;

		const buildBotInstances = (platformId: PlatformId, tokens: string[]): BotInstance[] => {
			return tokens.map(token => {
				const key = getBotKey(platformId, token);
				const isConnected = activeBotInstances.has(key);
				const error = botErrors.get(key);
				return {
					id: token,
					token,
					name: getBotDisplayName(token),
					status: isConnected ? "connected" : error ? "error" : "disconnected",
					errorMessage: error,
				};
			});
		};

		const slackBots = buildBotInstances("slack", slackTokens);
		const telegramBots = buildBotInstances("telegram", telegramTokens);

		const slackActiveCount = slackBots.filter(b => b.status === "connected").length;
		const telegramActiveCount = telegramBots.filter(b => b.status === "connected").length;

		return [
			{
				id: "slack",
				name: "Slack",
				description: "Connect to Slack channels & threads via Socket Mode",
				icon: "💬",
				mode: "Socket Mode",
				status: slackActiveCount > 0 ? "connected" : "disconnected",
				botTokens: slackTokens,
				appToken: slackAppToken ?? "",
				bots: slackBots,
			},
			{
				id: "telegram",
				name: "Telegram",
				description: "Connect to Telegram direct messages & groups via Long Polling",
				icon: "✈️",
				mode: "Long Polling",
				status: telegramActiveCount > 0 ? "connected" : "disconnected",
				botTokens: telegramTokens,
				bots: telegramBots,
			},
		];
	}

	getPasscode(): string {
		return (settings.get("connectors.passcode" as any) as string | undefined) ?? "";
	}

	setPasscode(passcode?: string): void {
		settings.set("connectors.passcode" as any, passcode as any);
	}

	async connectBot(
		platformId: PlatformId,
		token: string,
		log: (msg: string) => void,
	): Promise<{ ok: boolean; message: string }> {
		const trimmed = token.trim();
		const key = getBotKey(platformId, trimmed);
		botErrors.delete(key);

		try {
			if (platformId === "slack") {
				const slackAppToken = settings.get("connectors.slack.appToken" as any) as string | undefined;
				const { startSlackConnector } = await import("../../../connectors/slack.js");
				const bot = await startSlackConnector(
					{
						botToken: trimmed,
						appToken: slackAppToken,
						cwd: this.cwd,
						sessionFile: this.sessionFile,
					},
					log,
				);
				activeBotInstances.set(key, bot);
				this.addBotToken("slack", trimmed);
				return { ok: true, message: `Slack bot ${getBotDisplayName(trimmed)} connected successfully.` };
			}

			if (platformId === "telegram") {
				const { startTelegramConnector } = await import("../../../connectors/telegram.js");
				const bot = await startTelegramConnector(
					{
						botToken: trimmed,
						cwd: this.cwd,
						sessionFile: this.sessionFile,
					},
					log,
				);
				activeBotInstances.set(key, bot);
				this.addBotToken("telegram", trimmed);
				return { ok: true, message: `Telegram bot ${getBotDisplayName(trimmed)} connected successfully.` };
			}

			return { ok: false, message: `Unknown platform: ${platformId}` };
		} catch (err: any) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			botErrors.set(key, errorMsg);
			return { ok: false, message: `Failed to connect ${getBotDisplayName(trimmed)}: ${errorMsg}` };
		}
	}

	async connectAll(platformId: PlatformId, log: (msg: string) => void): Promise<{ ok: boolean; message: string }> {
		const tokens = this.getBotTokens(platformId);
		if (tokens.length === 0) {
			return { ok: false, message: `No bot tokens configured for ${platformId}.` };
		}
		let successCount = 0;
		for (const token of tokens) {
			const res = await this.connectBot(platformId, token, log);
			if (res.ok) successCount++;
		}
		return {
			ok: successCount > 0,
			message: `Connected ${successCount} of ${tokens.length} ${platformId} bots.`,
		};
	}

	async disconnectBot(platformId: PlatformId, token: string): Promise<{ ok: boolean; message: string }> {
		const trimmed = token.trim();
		const key = getBotKey(platformId, trimmed);
		const bot = activeBotInstances.get(key);
		if (bot) {
			try {
				if (typeof bot.shutdown === "function") {
					await bot.shutdown();
				}
			} catch (_e) {}
			activeBotInstances.delete(key);
		}
		botErrors.delete(key);
		return { ok: true, message: `${getBotDisplayName(trimmed)} disconnected.` };
	}

	async disconnectAll(platformId: PlatformId): Promise<{ ok: boolean; message: string }> {
		const tokens = this.getBotTokens(platformId);
		for (const token of tokens) {
			await this.disconnectBot(platformId, token);
		}
		return { ok: true, message: `All ${platformId} bots disconnected.` };
	}

	async reloadBot(
		platformId: PlatformId,
		token: string,
		log: (msg: string) => void,
	): Promise<{ ok: boolean; message: string }> {
		await this.disconnectBot(platformId, token);
		return await this.connectBot(platformId, token, log);
	}
}
