import type { AeryExtension, ExtensionAPI, SwarmAwareExtensionAPI } from "@aryee337/aery-sdk";

const extension: AeryExtension = (baseApi: ExtensionAPI) => {
	const api = baseApi as unknown as SwarmAwareExtensionAPI;
	if (api.declareSwarmRole) {
		api.declareSwarmRole({ role: "interactive-shell", capabilities: ["pty"] });
	}

	baseApi.registerTool({
		name: "shell_open",
		description: "Open an interactive shell PTY embedded in the TUI",
		parameters: { command: { type: "string", description: "Initial command", required: false } },
		execute: async (params: Record<string, unknown>) => {
			const command = params.command as string | undefined;
			return { content: `Opened interactive shell${command ? ` with command: ${command}` : ""}` };
		},
	});

	baseApi.registerTool({
		name: "shell_send",
		description: "Send input to the interactive shell",
		parameters: { input: { type: "string", description: "Input string", required: true } },
		execute: async (params: Record<string, unknown>) => {
			const input = params.input as string;
			return { content: `Sent input to shell: ${input}` };
		},
	});

	baseApi.registerTool({
		name: "shell_close",
		description: "Close the interactive shell",
		parameters: { force: { type: "boolean", description: "Force close", required: false } },
		execute: async (params: Record<string, unknown>) => {
			const force = params.force as boolean | undefined;
			return { content: `Closed interactive shell${force ? " forcefully" : ""}` };
		},
	});
};

export default extension;
