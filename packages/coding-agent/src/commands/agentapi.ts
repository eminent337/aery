/**
 * Inter-Agent API bridge (`aery agentapi`).
 */
import { Command } from "@aryee337/aery-utils/cli";
import { handleAgentApiCommand } from "../ipc/agentapi-cli";

export default class AgentApi extends Command {
	static description = "Inter-agent IPC API bridge for session metadata and messaging";

	static strict = false;

	async run(): Promise<void> {
		const { argv } = await this.parse(AgentApi);
		await handleAgentApiCommand(argv as string[]);
	}
}
