import type { AgentEvent } from "@aryee337/aery-core";
import { createSlackAdapter } from "@chat-adapter/slack";
import { Chat, type StateAdapter } from "chat";
import * as os from "os";
import * as path from "path";
import { RpcClient } from "../modes/rpc/rpc-client";

const threadClients = new Map<string, RpcClient>();

export interface ConnectSlackOptions {
	botToken: string;
	appToken?: string;
	signingSecret?: string;
	mode?: "socket" | "webhook";
	port?: number;
	cwd?: string;
}

export async function startSlackConnector(options: ConnectSlackOptions, log: (msg: string) => void) {
	const mode = options.mode || "socket";
	const slack = createSlackAdapter({
		mode,
		botToken: options.botToken,
		appToken: options.appToken,
		signingSecret: options.signingSecret,
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
		adapters: { slack },
		state: new MemoryStateAdapter() as unknown as StateAdapter,
	}).registerSingleton();

	bot.onNewMention(async (thread, msg) => {
		const threadId = thread.id;
		let client = threadClients.get(threadId);

		if (!client) {
			client = new RpcClient({
				cwd: options.cwd || process.cwd(),
				sessionDir: path.join(os.homedir(), ".aery", "sessions", `slack-${threadId.replace(/[^a-zA-Z0-9]/g, "-")}`),
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
						} catch (e) {
							log(`Failed to post message: ${e}`);
						}
					}
				} else if (event.type === "message_update") {
					if (isStreaming && currentSlackMsg && event.assistantMessageEvent?.type === "text_delta") {
						currentMessageText += event.assistantMessageEvent.delta;
						if (!updateTimeout) {
							updateTimeout = setTimeout(async () => {
								updateTimeout = null;
								try {
									await currentSlackMsg.edit(currentMessageText || "...");
								} catch (e) {
									// Ignore edit errors
								}
							}, 500);
						}
					}
				} else if (event.type === "message_end") {
					if (isStreaming && currentSlackMsg) {
						isStreaming = false;
						if (updateTimeout) clearTimeout(updateTimeout);
						try {
							await currentSlackMsg.edit(currentMessageText || "...");
						} catch (e) {
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
	return bot;
}
