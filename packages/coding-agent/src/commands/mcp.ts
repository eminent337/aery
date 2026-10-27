/**
 * MCP Server Management CLI (`aery mcp`).
 *
 * Implements Google Antigravity-style CLI management for Model Context Protocol servers:
 * - aery mcp list [--json]
 * - aery mcp add <name> <command> [args...]
 * - aery mcp remove <name>
 * - aery mcp enable <name>
 * - aery mcp disable <name>
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "@aryee337/aery-utils/cli";

interface McpServerEntry {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	enabled?: boolean;
}

interface McpConfigFile {
	mcpServers?: Record<string, McpServerEntry>;
}

function resolveMcpConfigPath(cwd = process.cwd(), isGlobal = false): string {
	if (isGlobal) {
		return path.join(os.homedir(), ".aery", "mcp.json");
	}

	const projectPath = path.join(cwd, ".aery", "mcp.json");
	if (fs.existsSync(projectPath)) return projectPath;

	const projectRootMcp = path.join(cwd, "mcp.json");
	if (fs.existsSync(projectRootMcp)) return projectRootMcp;

	if (fs.existsSync(path.join(cwd, ".aery"))) {
		return projectPath;
	}

	if (cwd !== os.homedir()) {
		return projectRootMcp;
	}

	return path.join(os.homedir(), ".aery", "mcp.json");
}

function loadMcpConfig(configPath: string): McpConfigFile {
	if (!fs.existsSync(configPath)) {
		return { mcpServers: {} };
	}
	try {
		const raw = fs.readFileSync(configPath, "utf-8");
		return JSON.parse(raw);
	} catch {
		return { mcpServers: {} };
	}
}

function saveMcpConfig(configPath: string, config: McpConfigFile): void {
	const dir = path.dirname(configPath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

export async function handleMcpCli(argv: string[], cwd = process.cwd()): Promise<void> {
	const isGlobal = argv.includes("--global") || argv.includes("-g");
	const filteredArgv = argv.filter(a => a !== "--global" && a !== "-g");
	const sub = filteredArgv[0] || "list";
	const configPath = resolveMcpConfigPath(cwd, isGlobal);
	const config = loadMcpConfig(configPath);
	if (!config.mcpServers) config.mcpServers = {};

	if (sub === "list") {
		const asJson = filteredArgv.includes("--json");
		if (asJson) {
			console.log(JSON.stringify(config.mcpServers, null, 2));
			return;
		}

		const entries = Object.entries(config.mcpServers);
		if (entries.length === 0) {
			console.log(`No MCP servers configured in ${configPath}`);
			return;
		}

		console.log(`Configured MCP Servers (${configPath}):`);
		console.log("----------------------------------------------------------------------");
		console.log(`${"SERVER NAME".padEnd(20)} ${"STATUS".padEnd(12)} COMMAND`);
		console.log("----------------------------------------------------------------------");
		for (const [name, entry] of entries) {
			const status = entry.enabled !== false ? "enabled" : "disabled";
			const cmd = `${entry.command} ${(entry.args || []).join(" ")}`;
			console.log(`${name.padEnd(20)} ${status.padEnd(12)} ${cmd}`);
		}
		return;
	}

	if (sub === "add") {
		const name = filteredArgv[1];
		const command = filteredArgv[2];
		const args = filteredArgv.slice(3);

		if (!name || !command) {
			console.error("Usage: aery mcp add <name> <command> [args...]");
			process.exit(1);
		}

		config.mcpServers[name] = {
			command,
			args: args.length > 0 ? args : undefined,
			enabled: true,
		};

		saveMcpConfig(configPath, config);
		console.log(`✅ Added MCP server '${name}' -> ${command} ${args.join(" ")} (${configPath})`);
		return;
	}

	if (sub === "remove" || sub === "rm") {
		const name = filteredArgv[1];
		if (!name) {
			console.error("Usage: aery mcp remove <name>");
			process.exit(1);
		}

		if (!config.mcpServers[name]) {
			console.error(`MCP server '${name}' not found.`);
			process.exit(1);
		}

		delete config.mcpServers[name];
		saveMcpConfig(configPath, config);
		console.log(`✅ Removed MCP server '${name}'.`);
		return;
	}

	if (sub === "enable") {
		const name = filteredArgv[1];
		if (!name || !config.mcpServers[name]) {
			console.error(`Usage: aery mcp enable <name> (server '${name}' not found)`);
			process.exit(1);
		}

		config.mcpServers[name].enabled = true;
		saveMcpConfig(configPath, config);
		console.log(`✅ Enabled MCP server '${name}'.`);
		return;
	}

	if (sub === "disable") {
		const name = filteredArgv[1];
		if (!name || !config.mcpServers[name]) {
			console.error(`Usage: aery mcp disable <name> (server '${name}' not found)`);
			process.exit(1);
		}

		config.mcpServers[name].enabled = false;
		saveMcpConfig(configPath, config);
		console.log(`✅ Disabled MCP server '${name}'.`);
		return;
	}

	console.log(
		"Usage: aery mcp [list [--json] | add <name> <cmd> [args...] | remove <name> | enable <name> | disable <name>]",
	);
}

export default class McpCommand extends Command {
	static description = "Manage Model Context Protocol (MCP) server configurations";
	static strict = false;

	async run(): Promise<void> {
		const { argv } = await this.parse(McpCommand);
		await handleMcpCli(argv as string[]);
	}
}
