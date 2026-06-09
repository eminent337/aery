/**
 * API Demo Extension
 *
 * Demonstrates using ExtensionAPI's logger, injected `aery.zod`, and aery module access.
 * These features are now exposed directly on the ExtensionAPI, matching
 * the CustomToolAPI interface.
 */
import type { ExtensionAPI } from "@aryee337/aery";

export default function (aery: ExtensionAPI) {
	const { z } = aery.zod;

	// Access the logger for debugging
	aery.logger.debug("API demo extension loaded");

	aery.registerTool({
		name: "api_demo",
		label: "API Demo",
		description: "Demonstrates ExtensionAPI capabilities: logger, zod, and aery module access",
		parameters: z.object({
			message: z.string().describe("Test message"),
			logLevel: z.enum(["error", "warn", "debug"]).default("debug").describe("Log level to use"),
		}),

		async execute(_toolCallId, params, _onUpdate, ctx, _signal) {
			const { message, logLevel } = params;

			// Use logger at specified level
			aery.logger[logLevel]("API demo tool executed", { message, logLevel });

			// Access aery module utilities
			const { logger: piLogger } = aery.aery;
			piLogger.debug("Accessed aery module from extension", { sessionFile: ctx.sessionManager.getSessionFile() });

			// Get session information
			const sessionInfo = `Session: ${ctx.sessionManager.getSessionFile()}`;
			const modelInfo = ctx.model ? `Model: ${ctx.model.id}` : "Model: none";

			return {
				content: [
					{
						type: "text",
						text: [
							`API Demo Tool executed successfully!`,
							``,
							`Message: ${message}`,
							`Log Level: ${logLevel}`,
							``,
							`Features demonstrated:`,
							`1. ✓ Logger access via aery.logger`,
							`2. ✓ Zod access via aery.zod`,
							`3. ✓ Aery module access via aery.aery`,
							``,
							`Context:`,
							`- ${sessionInfo}`,
							`- ${modelInfo}`,
							`- CWD: ${ctx.cwd}`,
						].join("\n"),
					},
				],
				details: {
					message,
					logLevel,
					sessionFile: ctx.sessionManager.getSessionFile(),
					modelId: ctx.model?.id,
				},
			};
		},
	});

	// Demonstrate event handling with logger
	aery.on("session_start", async () => {
		aery.logger.debug("Session started", { extension: "api-demo" });
	});

	aery.on("agent_start", async () => {
		aery.logger.debug("Agent started", { extension: "api-demo" });
	});
}
