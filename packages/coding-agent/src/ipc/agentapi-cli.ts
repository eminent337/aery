/**
 * CLI Handler for `aery agentapi` — Inter-Agent API Bridge.
 *
 * Provides a command-line interface for subagents and external processes to
 * inspect session metadata, trigger conversations, and pass messages.
 */

import { AgentBusClient, getDefaultSocketPath } from "./agent-bus";

export interface AgentApiCliOptions {
	socketPath?: string;
	agentId?: string;
}

export async function handleAgentApiCommand(argv: string[], options: AgentApiCliOptions = {}): Promise<void> {
	const command = argv[0];
	const socketPath = options.socketPath ?? getDefaultSocketPath();
	const agentId = options.agentId ?? `cli-${process.pid}`;

	if (!command || command === "--help" || command === "help") {
		console.log(`Usage: aery agentapi <command> [args]

Available Commands:
  get-conversation-metadata <conversation_id>
  new-conversation [--model=<model>] [--title=<title>] <prompt>
  send-message [--title=<title>] <recipient_id> <content>
`);
		return;
	}

	const client = new AgentBusClient(socketPath, agentId);

	try {
		await client.connect();
	} catch (err: any) {
		console.error(`Error: Could not connect to Aery IPC socket at ${socketPath}: ${err.message}`);
		process.exit(1);
	}

	try {
		switch (command) {
			case "get-conversation-metadata": {
				const conversationId = argv[1];
				if (!conversationId) {
					console.error("Error: conversation_id is required");
					process.exit(1);
				}
				const resp = await client.request("get_metadata", { conversationId });
				if (resp.success) {
					console.log(JSON.stringify(resp.payload, null, 2));
				} else {
					console.error(`Error: ${resp.error}`);
					process.exit(1);
				}
				break;
			}

			case "send-message": {
				let recipientId = argv[1];
				let content = argv.slice(2).join(" ");
				let title: string | undefined;

				// Parse optional --title
				if (argv[1]?.startsWith("--title=")) {
					title = argv[1].slice("--title=".length);
					recipientId = argv[2];
					content = argv.slice(3).join(" ");
				}

				if (!recipientId || !content) {
					console.error("Usage: aery agentapi send-message [--title=<title>] <recipient_id> <content>");
					process.exit(1);
				}

				const resp = await client.request("send_message", {
					recipientId,
					content,
					title,
				});

				if (resp.success) {
					console.log(`Message delivered to ${recipientId}`);
				} else {
					console.error(`Error: ${resp.error}`);
					process.exit(1);
				}
				break;
			}

			case "new-conversation": {
				let prompt = "";
				let model: string | undefined;
				let title: string | undefined;

				for (let i = 1; i < argv.length; i++) {
					const arg = argv[i];
					if (arg.startsWith("--model=")) {
						model = arg.slice("--model=".length);
					} else if (arg.startsWith("--title=")) {
						title = arg.slice("--title=".length);
					} else {
						prompt = argv.slice(i).join(" ");
						break;
					}
				}

				if (!prompt) {
					console.error("Usage: aery agentapi new-conversation [--model=<model>] [--title=<title>] <prompt>");
					process.exit(1);
				}

				const resp = await client.request("new_conversation", {
					prompt,
					model,
					title,
				});

				if (resp.success) {
					console.log(JSON.stringify(resp.payload, null, 2));
				} else {
					console.error(`Error: ${resp.error}`);
					process.exit(1);
				}
				break;
			}

			default:
				console.error(`Unknown agentapi command: ${command}`);
				process.exit(1);
		}
	} finally {
		await client.close();
	}
}
