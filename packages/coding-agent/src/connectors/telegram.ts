import type { AgentEvent } from "@aryee337/aery-core";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { Chat } from "chat";
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
	sessionFile?: string;
}

export async function startTelegramConnector(options: ConnectTelegramOptions, log: (msg: string) => void) {
	const mode = options.mode || "polling";
	const telegram = createTelegramAdapter({
		mode,
		botToken: options.botToken,
	});

	// Silent logger that routes operational logs cleanly without corrupting TUI output
	const customLogger = {
		debug: (_msg: string, _meta?: any) => {},
		info: (msg: string, _meta?: any) => {
			if (!msg.includes("initialized") && !msg.includes("webhook")) {
				log(`[Telegram] ${msg}`);
			}
		},
		warn: (msg: string, _meta?: any) => {
			log(`[Telegram] Warning: ${msg}`);
		},
		error: (msg: string, _meta?: any) => {
			log(`[Telegram] Error: ${msg}`);
		},
	};

	const state = new SqliteStateAdapter();

	const bot = new Chat({
		userName: "aery",
		adapters: { telegram },
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
					`telegram-${threadId.replace(/[^a-zA-Z0-9]/g, "-")}`,
				),
				args: args.length > 0 ? args : undefined,
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
					if (event.message?.role === "assistant") {
						currentMessageText = "";
						isStreaming = true;
						try {
							currentTelegramMsg = await thread.post("...");
						} catch (_e) {
							// Ignore post errors
						}
					}
				} else if (event.type === "message_update") {
					if (event.message?.role === "assistant") {
						// 1. Check direct text delta on assistantMessageEvent
						const ame = (event as any).assistantMessageEvent;
						if (ame?.type === "text_delta" && typeof ame.delta === "string") {
							currentMessageText += ame.delta;
						} else if (event.message.content && Array.isArray(event.message.content)) {
							// 2. Or extract from content array
							const textContent = event.message.content
								.filter((c: any) => c.type === "text" && c.text)
								.map((c: any) => c.text)
								.join("");
							if (textContent) {
								currentMessageText = textContent;
							}
						}

						// Debounce edit calls to avoid Telegram rate limits
						if (currentTelegramMsg && currentMessageText && !updateTimeout) {
							updateTimeout = setTimeout(async () => {
								updateTimeout = null;
								if (currentTelegramMsg && currentMessageText) {
									try {
										await currentTelegramMsg.edit(currentMessageText);
									} catch (_e) {
										// Ignore edit errors
									}
								}
							}, 800);
						}
					}
				} else if (event.type === "message_end") {
					if (event.message?.role === "assistant") {
						if (updateTimeout) {
							clearTimeout(updateTimeout);
							updateTimeout = null;
						}
						// Final text extraction from message_end payload if available
						if (event.message.content && Array.isArray(event.message.content)) {
							const textContent = event.message.content
								.filter((c: any) => c.type === "text" && c.text)
								.map((c: any) => c.text)
								.join("");
							if (textContent) {
								currentMessageText = textContent;
							}
						}

						let finalText = currentMessageText;
						// If model failed or returned an error (e.g. 500 upstream server error, rate limit, token limit)
						if (!finalText && (event.message as any).errorMessage) {
							const err = (event.message as any).errorMessage;
							const status = (event.message as any).errorStatus;
							finalText = `⚠️ *Model Error*${status ? ` (${status})` : ""}:\n${err}\n\n_Tip: Try switching to another model using \`/model\`._`;
						} else if (!finalText) {
							finalText = "(No response generated by model)";
						}

						if (currentTelegramMsg) {
							try {
								await currentTelegramMsg.edit(finalText);
							} catch (_e) {
								try {
									await thread.post(finalText);
								} catch (_err) {}
							}
							currentTelegramMsg = null;
						} else {
							try {
								await thread.post(finalText);
							} catch (_err) {}
						}
						isStreaming = false;
					}
				}
			});
		}

		// Handle Telegram Slash Commands
		const trimmedText = text.trim();
		if (trimmedText.startsWith("/model")) {
			const parts = trimmedText.split(/\s+/);
			if (parts.length === 1) {
				// Show current model and list of top available models
				try {
					const state = await client.getState();
					const available = await client.getAvailableModels();
					const modelList = available
						.slice(0, 10)
						.map(m => `• \`${m.provider}/${m.id}\``)
						.join("\n");
					await thread.post(
						`🤖 *Current Model:* \`${state.model?.provider}/${state.model?.id}\`\n\n*Available Models:*\n${modelList}\n\n_To switch: \`/model <provider>/<model_id>\`_`,
					);
				} catch (err) {
					await thread.post(`Error fetching models: ${err}`);
				}
				return;
			}
			const target = parts[1];
			const [provider, ...idParts] = target.includes("/") ? target.split("/") : ["", target];
			const modelId = idParts.join("/");
			try {
				if (provider && modelId) {
					await client.setModel(provider, modelId);
					await thread.post(`✅ *Switched Model to:* \`${provider}/${modelId}\``);
				} else {
					await thread.post(`⚠️ *Usage:* \`/model <provider>/<model-id>\` (e.g. \`/model google-gemini-cli/gemini-2.5-flash\`)`);
				}
			} catch (err) {
				await thread.post(`❌ *Failed to switch model:* ${err}`);
			}
			return;
		}

		if (trimmedText === "/new" || trimmedText === "/clear") {
			try {
				await client.newSession();
				await thread.post(`✨ *New Session Started!* Context cleared.`);
			} catch (err) {
				await thread.post(`Error starting new session: ${err}`);
			}
			return;
		}

		if (trimmedText.startsWith("/resume") || trimmedText === "/sessions") {
			const parts = trimmedText.split(/\s+/);
			const sessionDir = path.join(os.homedir(), ".aery", "sessions");
			if (parts.length === 1 || trimmedText === "/sessions") {
				try {
					const { SessionManager } = await import("../session/session-manager.js");
					const all = await SessionManager.listAll();
					const recent = all.slice(0, 8);
					if (recent.length === 0) {
						await thread.post(`📂 *No prior sessions found.*`);
						return;
					}
					const list = recent
						.map(s => `• \`${s.id.slice(0, 8)}\` — *${s.title || "Untitled"}* (${new Date(s.modified).toLocaleTimeString()})`)
						.join("\n");
					await thread.post(
						`📂 *Recent Sessions:*\n${list}\n\n_To resume: \`/resume <session-id-or-path>\`_`,
					);
				} catch (err) {
					await thread.post(`Error listing sessions: ${err}`);
				}
				return;
			}

			const targetId = parts[1].trim();
			try {
				const { SessionManager } = await import("../session/session-manager.js");
				const all = await SessionManager.listAll();
				const match = all.find(s => s.id === targetId || s.id.startsWith(targetId) || s.path === targetId);
				if (!match) {
					await thread.post(`❌ *Session not found:* \`${targetId}\`\nUse \`/resume\` or \`/sessions\` to view available sessions.`);
					return;
				}
				const result = await client.switchSession(match.path);
				if (result.cancelled) {
					await thread.post(`⚠️ *Switch cancelled by extension.*`);
				} else {
					await thread.post(`🔄 *Resumed session:* \`${match.id.slice(0, 8)}\` — *${match.title || "Untitled"}*`);
				}
			} catch (err) {
				await thread.post(`❌ *Error switching session:* ${err}`);
			}
			return;
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
