/**
 * Models List CLI (`aery models`).
 *
 * Implements Google Antigravity-style models listing command.
 */

import { Command } from "@aryee337/aery-utils/cli";
import { listModels } from "../cli/list-models";
import { ModelRegistry } from "../config/model-registry";
import { discoverAuthStorage } from "../sdk";

export default class ModelsCommand extends Command {
	static description = "List available models across configured providers";
	static strict = false;

	async run(): Promise<void> {
		const { argv } = await this.parse(ModelsCommand);
		const pattern = argv[0] as string | undefined;

		const authStorage = await discoverAuthStorage();
		const registry = new ModelRegistry(authStorage);
		await listModels(registry, pattern);
	}
}
