/**
 * Hello Tool - Minimal custom tool example
 *
 * Demonstrates using ExtensionAPI's logger, injected `aery.zod`, and aery module access.
 */
import type { ExtensionAPI } from "@aryee337/aery";

export default function (aery: ExtensionAPI) {
	const { z } = aery.zod;

	aery.registerTool({
		name: "hello",
		label: "Hello",
		description: "A simple greeting tool",
		parameters: z.object({
			name: z.string().describe("Name to greet"),
		}),

		async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
			const { name } = params;

			// Use logger for debugging
			aery.logger.debug("Hello tool executed", { name });

			return {
				content: [{ type: "text", text: `Hello, ${name}!` }],
				details: { greeted: name },
			};
		},
	});
}
