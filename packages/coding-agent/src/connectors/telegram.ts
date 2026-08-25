import type { AgentEvent } from "@aryee337/aery-core";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { Chat, type StateAdapter } from "chat";
import * as os from "os";
import * as path from "path";
import { RpcClient } from "../modes/rpc/rpc-client";

import { settings } from "../config/settings.js";
import { SqliteStateAdapter } from "./sqlite-state-adapter.js";

const threadClients = new Map<string, RpcClient>();
const threadLastActive = new Map<string, number>();
const threadUnlocked = new Map<string, boolean>();

export interface ConnectTelegramOptions {
	botToken: string;
	mode?: "polling" | "webhook";
	port?: number;
	cwd?: string;
}

export async function startTelegramConnector(options: ConnectTelegramOptions, log: (msg: string) => void) {
	const mode = options.mode || "polling";
	const telegram = createTelegramAdapter({
		mode,
		botToken: options.botToken,
	});

	const bot = new Chat({
		userName: "aery",
		adapters: { telegram },
		state: new SqliteStateAdapter(),
	}).registerSingleton();

	bot.onNewMention(async (thread, msg) => {
		const threadId = thread.id;
		const text = msg.text?.trim() ?? "";

		// Security: Passcode & Inactivity Auto-Lock
		const requiredPasscode = settings.get("connectors.passcode" as any) as string | undefined;
		const timeoutMinutes = (settings.get("connectors.idleTimeoutMinutes" as any) as number | undefined) ?? 10;
		const timeoutMs = timeoutMinutes * 60 * 1000;

		if (requiredPasscode && requiredPasscode.trim().length > 0) {
			const lastActive = threadLastActive.get(threadId) ?? 0;
			const isUnlocked = threadUnlocked.get(threadId) ?? false;
			const isExpired = Date.now() - lastActive > timeoutMs;

			if (!isUnlocked || isExpired) {
				// Check if user is submitting the unlock passcode
				if (text === requiredPasscode.trim() || text === `/unlock ${requiredPasscode.trim()}`) {
					threadUnlocked.set(threadId, true);
					threadLastActive.set(threadId, Date.now());

					// Try to delete the user's message containing the password for privacy
					try {
						if (typeof (thread as any).deleteMessage === "function" && (msg as any).id) {
							await (thread as any).deleteMessage((msg as any).id);
						}
					} catch (_e) {}

					await thread.post(
						`🔓 *Session Unlocked!*\nAuthenticated for the next ${timeoutMinutes} minutes. How can I help you?`,
					);
					return;
				}

				// If wrong or unauthenticated, challenge for passcode
				threadUnlocked.set(threadId, false);
				await thread.post(
					`🔒 *Session Locked*\nPlease send your passcode to unlock and continue chatting with Aery:`,
				);
				return;
			}
		}

		// Update activity timestamp for authenticated message
		threadLastActive.set(threadId, Date.now());

		let client = threadClients.get(threadId);

		if (!client) {
			const cliPath = path.resolve(import.meta.dir, "../cli.ts");
			client = new RpcClient({
				cliPath,
				cwd: options.cwd || process.cwd(),
				sessionDir: path.join(
					os.homedir(),
					".aery",
					"sessions",
					`telegram-${threadId.replace(/[^a-zA-Z0-9]/g, "-")}`,
				),
			});

			try {
				await client.start();
				threadClients.set(threadId, client);
				log(`Started new RPC session for Telegram thread ${threadId}`);
			} catch (err) {
				log(`Failed to start RPC session for ${threadId}: ${err}`);
				await thread.post(`Error starting agent session: ${err}`);
				return;
			}

			let currentMessageText = "";
			let currentTelegramMsg: any = null;
			let isStreaming = false;
			let updateTimeout: any = null;

			client.onEvent(async (event: AgentEvent) => {
				if (event.type === "message_start") {
					if (event.message.role === "assistant") {
						currentMessageText = "";
						isStreaming = true;
						try {
							currentTelegramMsg = await thread.post("...");
						} catch (_e) {
							log(`Failed to post message: ${_e}`);
						}
					}
				} else if (event.type === "message_update") {
					if (isStreaming && currentTelegramMsg && event.assistantMessageEvent?.type === "text_delta") {
						currentMessageText += event.assistantMessageEvent.delta;
						if (!updateTimeout) {
							updateTimeout = setTimeout(async () => {
								updateTimeout = null;
								try {
									await currentTelegramMsg.edit(currentMessageText || "...");
								} catch (_e) {
									// Ignore edit errors
								}
							}, 500); // Telegram has stricter rate limits so batch updates
						}
					}
				} else if (event.type === "message_end") {
					if (isStreaming && currentTelegramMsg) {
						isStreaming = false;
						if (updateTimeout) clearTimeout(updateTimeout);
						try {
							await currentTelegramMsg.edit(currentMessageText || "...");
						} catch (_e) {
							// Ignore edit errors
						}
						currentTelegramMsg = null;
					}
				}
			});
		}

		try {
			await client.prompt(msg.text);
		} catch (err) {
			log(`Error processing prompt: ${err}`);
			await thread.post(`Error processing request: ${err}`);
		}
	});

	await bot.initialize();
	log(`Telegram connector started in ${mode} mode`);

	(bot as any).shutdown = async () => {
		try {
			if (typeof (telegram as any).stopPolling === "function") {
				await (telegram as any).stopPolling();
			}
		} catch (_e) {}
		try {
			if (typeof (bot as any).destroy === "function") {
				await (bot as any).destroy();
			}
		} catch (_e) {}
	};

	return bot;
}
