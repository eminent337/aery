import type { AgentEvent } from "@aryee337/aery-core";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { Chat, type StateAdapter } from "chat";
import * as os from "os";
import * as path from "path";
import { RpcClient } from "../modes/rpc/rpc-client";

const threadClients = new Map<string, RpcClient>();

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

	class MemoryStateAdapter {
		private store = new Map<string, any>();
		async get(threadId: string) {
			return this.store.get(threadId) ?? null;
		}
		async set(threadId: string, state: any) {
			this.store.set(threadId, state);
		}
		async delete(threadId: string) {
			this.store.delete(threadId);
		}
	}

	const bot = new Chat({
		userName: "aery",
		adapters: { telegram },
		state: new MemoryStateAdapter() as unknown as StateAdapter,
	}).registerSingleton();

	bot.onNewMention(async (thread, msg) => {
		const threadId = thread.id;
		let client = threadClients.get(threadId);

		if (!client) {
			client = new RpcClient({
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
						} catch (e) {
							log(`Failed to post message: ${e}`);
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
								} catch (e) {
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
						} catch (e) {
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
	return bot;
}
