import type { AgentEvent } from "@aryee337/aery-core";
import { createSlackAdapter } from "@chat-adapter/slack";
import { Chat, type StateAdapter } from "chat";
import * as os from "os";
import * as path from "path";
import { RpcClient } from "../modes/rpc/rpc-client";

import { SqliteStateAdapter } from "./sqlite-state-adapter.js";

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

	const bot = new Chat({
		userName: "aery",
		adapters: { slack },
		state: new SqliteStateAdapter(),
	}).registerSingleton();

	bot.onNewMention(async (thread, msg) => {
		const threadId = thread.id;
		let client = threadClients.get(threadId);

		if (!client) {
			const cliPath = path.resolve(import.meta.dir, "../cli.ts");
			client = new RpcClient({
				cliPath,
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
								} catch (_e) {
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

	if (mode === "socket" && !options.appToken) {
		const err = "Slack socket mode requires an appToken (xapp-...) with connections:write scope in addition to botToken (xoxb-...).";
		log(`Error: ${err}`);
		throw new Error(err);
	}

	try {
		await bot.initialize();
		log(`Slack connector started in ${mode} mode`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log(`Failed to initialize Slack connector: ${msg}`);
		throw err;
	}
	return bot;
}
