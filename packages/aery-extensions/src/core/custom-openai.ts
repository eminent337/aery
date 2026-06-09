import * as path from "node:path";
import type { ExtensionAPI } from "@aryee337/aery";
import { saveCustomOpenAICompatibleProvider } from "@aryee337/aery/config/custom-openai-compatible";
import { getAgentDir } from "@aryee337/aery-utils";

export default function customOpenAIExtension(api: ExtensionAPI) {
	api.setLabel("Custom OpenAI Provider");

	api.registerCommand("provider", {
		description: "Add a custom OpenAI-compatible provider (e.g., /provider add <baseUrl> <modelId> <apiKey>)",
		handler: async (args, ctx) => {
			const subCommand = args[0];

			if (subCommand === "add") {
				const baseUrl = args[1];
				const modelId = args[2];
				const apiKey = args[3];

				if (!baseUrl || !modelId || !apiKey) {
					ctx.ui.setStatus("provider", "Usage: /provider add <baseUrl> <modelId> <apiKey>");
					return;
				}

				try {
					ctx.ui.setStatus("provider", `Configuring ${baseUrl}...`);
					const saved = saveCustomOpenAICompatibleProvider({
						modelsPath: path.join(getAgentDir(), "models.yml"),
						baseUrl,
						modelId,
					});

					// Save API key
					(ctx.sessionManager as any)?.session?.modelRegistry?.authStorage?.set(saved.providerId, {
						type: "api_key",
						key: apiKey,
					});
					(ctx.sessionManager as any)?.session?.modelRegistry?.refresh();

					const model = (ctx.sessionManager as any)?.session?.modelRegistry?.find(saved.providerId, saved.modelId);
					let selectedModel = false;
					if (model) {
						try {
							await (ctx.sessionManager as any)?.session?.setModel(model);
							selectedModel = true;
						} catch (error: unknown) {
							const msg = `Saved ${saved.providerId}/${saved.modelId}, but selecting it failed.`;
							ctx.ui.setStatus("provider", msg);
						}
					}

					if (selectedModel) {
						ctx.ui.setStatus("provider", `Configured & selected ${saved.providerId}/${saved.modelId}`);
					} else {
						ctx.ui.setStatus(
							"provider",
							`Configured ${saved.providerId}/${saved.modelId}. Use /model to select it.`,
						);
					}
				} catch (error: unknown) {
					const errorMsg = error instanceof Error ? error.message : String(error);
					ctx.ui.setStatus("provider", `Failed to configure: ${errorMsg}`);
				}
			} else {
				ctx.ui.setStatus("provider", "Usage: /provider add <baseUrl> <modelId> <apiKey>");
			}
		},
	});
}
