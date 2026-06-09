import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@aryee337/aery";

const execAsync = promisify(exec);

export default function dockerExtension(aery: ExtensionAPI) {
	aery.registerTool({
		name: "docker_bash",
		label: "Docker Bash",
		description:
			"Run a bash command safely inside an isolated Docker container with the current directory mounted. Use this for running untrusted code or compiling binaries without affecting the host machine.",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "The bash command to execute inside the container." },
				image: { type: "string", description: "The Docker image to use (default: ubuntu:latest)." },
			},
			required: ["command"],
		},
		async execute(_id, args: any) {
			const command = (args as any).command;
			const image = (args as any).image || "ubuntu:latest";

			// Mount the current working directory to /workspace and run the command
			const dockerCmd = `docker run --rm -v "$(pwd):/workspace" -w /workspace ${image} bash -c ${JSON.stringify(command)}`;

			try {
				const { stdout, stderr } = await execAsync(dockerCmd);
				const output = [stdout, stderr].filter(Boolean).join("\n");
				return { content: [{ type: "text", text: output || "Command completed successfully with no output." }] };
			} catch (error: any) {
				const errorOutput = [error.stdout, error.stderr, error.message].filter(Boolean).join("\n");
				return { content: [{ type: "text", text: `Docker Execution Failed:\n${errorOutput}` }], isError: true };
			}
		},
	});
}
