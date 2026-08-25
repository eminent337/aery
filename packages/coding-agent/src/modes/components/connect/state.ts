import { settings } from "../../../config/settings";
import type { PlatformConfig, PlatformId } from "./types";

// Active bot handles map stored in memory
const activeBots = new Map<PlatformId, any>();
const platformErrors = new Map<PlatformId, string>();

export class ConnectStateManager {
	constructor(private readonly cwd: string) {}

	async loadPlatforms(): Promise<PlatformConfig[]> {
		const slackBotToken = settings.get("connectors.slack.botToken" as any) as string | undefined;
		const slackAppToken = settings.get("connectors.slack.appToken" as any) as string | undefined;
		const telegramBotToken = settings.get("connectors.telegram.botToken" as any) as string | undefined;

		const slackActive = activeBots.has("slack");
		const telegramActive = activeBots.has("telegram");

		return [
			{
				id: "slack",
				name: "Slack",
				description: "Connect to Slack channels & threads via Socket Mode",
				icon: "💬",
				mode: "Socket Mode",
				status: slackActive ? "connected" : platformErrors.has("slack") ? "error" : "disconnected",
				errorMessage: platformErrors.get("slack"),
				botToken: slackBotToken ?? "",
				appToken: slackAppToken ?? "",
			},
			{
				id: "telegram",
				name: "Telegram",
				description: "Connect to Telegram direct messages & groups via Long Polling",
				icon: "✈️",
				mode: "Long Polling",
				status: telegramActive ? "connected" : platformErrors.has("telegram") ? "error" : "disconnected",
				errorMessage: platformErrors.get("telegram"),
				botToken: telegramBotToken ?? "",
			},
		];
	}

	saveCredentials(platformId: PlatformId, credentials: { botToken?: string; appToken?: string }): void {
		if (platformId === "slack") {
			if (credentials.botToken !== undefined) {
				settings.set("connectors.slack.botToken" as any, credentials.botToken as any);
			}
			if (credentials.appToken !== undefined) {
				settings.set("connectors.slack.appToken" as any, credentials.appToken as any);
			}
		} else if (platformId === "telegram") {
			if (credentials.botToken !== undefined) {
				settings.set("connectors.telegram.botToken" as any, credentials.botToken as any);
			}
		}
	}

	getPasscode(): string {
		return (settings.get("connectors.passcode" as any) as string | undefined) ?? "";
	}

	setPasscode(passcode?: string): void {
		settings.set("connectors.passcode" as any, passcode as any);
	}

	async connectPlatform(
		platformId: PlatformId,
		credentials: { botToken: string; appToken?: string },
		log: (msg: string) => void,
	): Promise<{ ok: boolean; message: string }> {
		platformErrors.delete(platformId);

		try {
			if (platformId === "slack") {
				const { startSlackConnector } = await import("../../../connectors/slack.js");
				const bot = await startSlackConnector(
					{
						botToken: credentials.botToken,
						appToken: credentials.appToken,
						cwd: this.cwd,
					},
					log,
				);
				activeBots.set("slack", bot);
				this.saveCredentials("slack", credentials);
				return { ok: true, message: "Slack connector connected successfully." };
			}

			if (platformId === "telegram") {
				const { startTelegramConnector } = await import("../../../connectors/telegram.js");
				const bot = await startTelegramConnector(
					{
						botToken: credentials.botToken,
						cwd: this.cwd,
					},
					log,
				);
				activeBots.set("telegram", bot);
				this.saveCredentials("telegram", credentials);
				return { ok: true, message: "Telegram connector connected successfully." };
			}

			return { ok: false, message: `Unknown platform: ${platformId}` };
		} catch (err: any) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			platformErrors.set(platformId, errorMsg);
			return { ok: false, message: `Failed to connect ${platformId}: ${errorMsg}` };
		}
	}

	async disconnectPlatform(platformId: PlatformId): Promise<{ ok: boolean; message: string }> {
		const bot = activeBots.get(platformId);
		if (bot) {
			try {
				if (typeof bot.shutdown === "function") {
					await bot.shutdown();
				}
			} catch (_e) {}
			activeBots.delete(platformId);
		}

		platformErrors.delete(platformId);
		return { ok: true, message: `${platformId} disconnected and cleared.` };
	}

	clearCredentials(platformId: PlatformId, field?: "botToken" | "appToken" | "all"): void {
		if (!field || field === "all") {
			void this.disconnectPlatform(platformId);
			if (platformId === "slack") {
				settings.set("connectors.slack.botToken" as any, undefined as any);
				settings.set("connectors.slack.appToken" as any, undefined as any);
			} else if (platformId === "telegram") {
				settings.set("connectors.telegram.botToken" as any, undefined as any);
			}
			return;
		}

		if (platformId === "slack") {
			if (field === "botToken") {
				settings.set("connectors.slack.botToken" as any, undefined as any);
			} else if (field === "appToken") {
				settings.set("connectors.slack.appToken" as any, undefined as any);
			}
		} else if (platformId === "telegram") {
			if (field === "botToken") {
				settings.set("connectors.telegram.botToken" as any, undefined as any);
			}
		}
	}
}
