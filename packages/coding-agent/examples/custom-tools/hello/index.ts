import type { CustomToolFactory } from "@aryee337/aery";

const factory: CustomToolFactory = aery => ({
	name: "hello",
	label: "Hello",
	description: "A simple greeting tool",
	parameters: aery.zod.object({
		name: aery.zod.string().describe("Name to greet"),
	}),

	async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
		const { name } = params;
		return {
			content: [{ type: "text", text: `Hello, ${name}!` }],
			details: { greeted: name },
		};
	},
});

export default factory;
