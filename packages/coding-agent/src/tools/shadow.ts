import type { AgentTool, AgentToolResult } from "@aryee337/aery-core";
import fs from "fs";
import os from "os";
import path from "path";
import * as z from "zod/v4";
import type { ToolSession } from ".";

function getInboxDir(team: string): string {
	return path.join(os.homedir(), ".aery", "teams", "inboxes", team);
}

const shadowWatchSchema = z.object({
	dir: z.string().describe("The directory to watch for file changes"),
	team: z.string().describe("The Swarm Grid team name"),
	agent_id: z.string().describe("Your agent ID to receive mailbox notifications"),
});

export class ShadowWatchTool implements AgentTool<typeof shadowWatchSchema, any> {
	readonly name = "shadow_watch";
	readonly approval = "write" as const;
	readonly label = "Shadow Watch";
	readonly summary = "Proactive background file watching";
	readonly description = "Watch a directory for file changes and send notifications to your Swarm Mailbox.";
	readonly parameters = shadowWatchSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): ShadowWatchTool | null {
		return new ShadowWatchTool(session);
	}

	async execute(_toolCallId: string, params: z.infer<typeof shadowWatchSchema>): Promise<AgentToolResult<any>> {
		const targetDir = path.resolve(this.session.cwd, params.dir);

		const inboxDir = getInboxDir(params.team);
		const mailboxFile = path.join(inboxDir, `${params.agent_id}.json`);

		try {
			await fs.promises.mkdir(inboxDir, { recursive: true });
		} catch {}

		let timeout: NodeJS.Timeout | null = null;

		try {
			fs.watch(targetDir, { recursive: true }, (eventType, filename) => {
				if (!filename) return;

				if (timeout) clearTimeout(timeout);

				timeout = setTimeout(async () => {
					try {
						let messages: any[] = [];
						try {
							const content = await fs.promises.readFile(mailboxFile, "utf-8");
							messages = JSON.parse(content);
						} catch {
							messages = [];
						}

						messages.push({
							from: "shadow_watch",
							message: `File changed: ${filename} (${eventType})`,
							timestamp: Date.now(),
						});

						await fs.promises.writeFile(mailboxFile, JSON.stringify(messages, null, 2), "utf-8");
					} catch (e) {
						// Silently ignore if mailbox fails to update
					}
				}, 500); // 500ms debounce
			});
		} catch (error: any) {
			return {
				content: [{ type: "text", text: `Failed to start watching ${targetDir}: ${error.message}` }],
				details: { error: error.message },
			};
		}

		return {
			content: [
				{
					type: "text",
					text: `Started watching ${targetDir} for changes. Notifications will be sent to team ${params.team}, agent ${params.agent_id}.`,
				},
			],
			details: { targetDir, team: params.team, agent_id: params.agent_id },
		};
	}
}
