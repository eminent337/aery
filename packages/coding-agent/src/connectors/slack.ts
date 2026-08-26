import type { AgentEvent } from "@aryee337/aery-core";
import { createSlackAdapter } from "@chat-adapter/slack";
import { Chat } from "chat";
import * as os from "os";
import * as path from "path";
import { RpcClient } from "../modes/rpc/rpc-client";

import { settings } from "../config/settings.js";
import { SqliteStateAdapter } from "./sqlite-state-adapter.js";

const threadClients = new Map<string, RpcClient>();
const threadLastActive = new Map<string, number>();
const threadUnlocked = new Map<string, boolean>();

export interface ConnectSlackOptions {
	botToken: string;
	appToken?: string;
	signingSecret?: string;
	mode?: "socket" | "webhook";
	port?: number;
	cwd?: string;
	sessionFile?: string;
}

export async function startSlackConnector(options: ConnectSlackOptions, log: (msg: string) => void) {
	const mode = options.mode || "socket";
	const slack = createSlackAdapter({
		mode,
		botToken: options.botToken,
		appToken: options.appToken,
		signingSecret: options.signingSecret,
	});

	// Silent logger that routes operational logs cleanly without corrupting TUI output
	const customLogger = {
		debug: (_msg: string, _meta?: any) => {},
		info: (msg: string, _meta?: any) => {
			if (!msg.includes("initialized") && !msg.includes("webhook")) {
				log(`[Slack] ${msg}`);
			}
		},
		warn: (msg: string, _meta?: any) => {
			log(`[Slack] Warning: ${msg}`);
		},
		error: (msg: string, _meta?: any) => {
			log(`[Slack] Error: ${msg}`);
		},
	};

	const state = new SqliteStateAdapter();

	const bot = new Chat({
		userName: "aery",
		adapters: { slack },
		state,
		logger: customLogger as any,
		onLockConflict: "force",
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
				if (text === requiredPasscode.trim() || text === `/unlock ${requiredPasscode.trim()}`) {
					threadUnlocked.set(threadId, true);
					threadLastActive.set(threadId, Date.now());

					await thread.post(
						`🔓 *Session Unlocked!*\nAuthenticated for the next ${timeoutMinutes} minutes. How can I help you?`,
					);
					return;
				}

				threadUnlocked.set(threadId, false);
				await thread.post(
					`🔒 *Session Locked*\nPlease reply with your passcode to unlock and continue chatting with Aery:`,
				);
				return;
			}
		}

		threadLastActive.set(threadId, Date.now());

		let client = threadClients.get(threadId);

		if (!client) {
			const cliPath = path.resolve(import.meta.dir, "../cli.ts");
			const args: string[] = [];
			if (options.sessionFile) {
				args.push("--resume", options.sessionFile);
			}
			client = new RpcClient({
				cliPath,
				cwd: options.cwd || process.cwd(),
				sessionDir: path.join(
					os.homedir(),
					".aery",
					"sessions",
					`slack-${threadId.replace(/[^a-zA-Z0-9]/g, "-")}`,
				),
				args: args.length > 0 ? args : undefined,
			});

			try {
				await client.start();
				threadClients.set(threadId, client);
				log(`Started new RPC session for Slack thread ${threadId}`);
			} catch (err) {
				log(`Failed to start RPC session for ${threadId}: ${err}`);
				await thread.post(`Error starting agent session: ${err}`);
				return;
			}

			let currentMessageText = "";
			let currentSlackMsg: any = null;
			let isStreaming = false;
			let updateTimeout: any = null;

			client.onEvent(async (event: AgentEvent) => {
				if (event.type === "message_start") {
					if (event.message.role === "assistant") {
						currentMessageText = "";
						isStreaming = true;
						try {
							currentSlackMsg = await thread.post("...");
						} catch (_e) {
							// Ignore post errors
						}
					}
				} else if (event.type === "message_update") {
					if (isStreaming && currentSlackMsg && event.message.role === "assistant") {
						if (event.message.content) {
							const textContent = event.message.content
								.filter((c: any) => c.type === "text")
								.map((c: any) => c.text)
								.join("");

							currentMessageText = textContent;

							if (!updateTimeout) {
								updateTimeout = setTimeout(async () => {
									updateTimeout = null;
									if (currentSlackMsg && currentMessageText) {
										try {
											await currentSlackMsg.edit(currentMessageText);
										} catch (_e) {
											// Ignore edit errors
										}
									}
								}, 800);
							}
						}
					}
				} else if (event.type === "message_end") {
					if (isStreaming && currentSlackMsg) {
						isStreaming = false;
						if (updateTimeout) {
							clearTimeout(updateTimeout);
							updateTimeout = null;
						}
						try {
							await currentSlackMsg.edit(currentMessageText || "...");
						} catch (_e) {
							// Ignore edit errors
						}
						currentSlackMsg = null;
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
	log(`Slack connector started in ${mode} mode`);

	(bot as any).shutdown = async () => {
		try {
			if (typeof (bot as any).destroy === "function") {
				await (bot as any).destroy();
			}
		} catch (_e) {}
	};

	return bot;
}
