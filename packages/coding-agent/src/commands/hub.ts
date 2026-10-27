/**
 * Web Hub CLI Command (`aery hub`).
 *
 * Launches the native Bun Web Hub on localhost:8765.
 */

import { Command } from "@aryee337/aery-utils/cli";
import { WebHubServer } from "../hub/web-hub-server";

export async function handleHubCli(argv: string[]): Promise<void> {
	let port = 8765;
	const portIdx = argv.indexOf("--port");
	if (portIdx !== -1 && argv[portIdx + 1]) {
		port = parseInt(argv[portIdx + 1], 10);
	}

	let host = "127.0.0.1";
	const hostIdx = argv.indexOf("--host");
	if (hostIdx !== -1 && argv[hostIdx + 1]) {
		host = argv[hostIdx + 1];
	}

	const server = new WebHubServer({ port, host, cwd: process.cwd() });
	const { url } = await server.start();

	console.log(`\n🦅 Aery Web Hub is live at: ${url}`);
	console.log(`- Dashboard: ${url}/`);
	console.log(`- REST API:  ${url}/api/status`);
	console.log(`- Realtime:  ${url.replace("http", "ws")}/ws\n`);
	console.log("Press Ctrl+C to stop the Web Hub.\n");

	if (argv.includes("--open")) {
		try {
			Bun.spawn(["xdg-open", url], { stdio: "ignore" });
		} catch {}
	}

	// Keep process alive if invoked as standalone command
	await new Promise(() => {});
}

export default class HubCommand extends Command {
	static description = "Launch the interactive browser-based Web Hub dashboard";
	static strict = false;

	async run(): Promise<void> {
		const { argv } = await this.parse();
		await handleHubCli(argv as string[]);
	}
}
