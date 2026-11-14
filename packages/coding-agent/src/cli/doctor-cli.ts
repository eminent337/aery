import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { APP_NAME, getAgentDir, getProjectDir, MIN_BUN_VERSION, VERSION } from "@aryee337/aery-utils";
import chalk from "chalk";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAuthStorage } from "../sdk";

export type DoctorStatus = "ok" | "warn" | "fail" | "idle" | "note";

export interface DoctorCheckItem {
	category: string;
	name: string;
	status: DoctorStatus;
	message: string;
	details?: string;
}

export interface DoctorReport {
	version: string;
	platform: string;
	timestamp: string;
	checks: DoctorCheckItem[];
	summary: {
		ok: number;
		warn: number;
		fail: number;
		idle: number;
		note: number;
	};
}

export interface DoctorCliOptions {
	summary?: boolean;
	json?: boolean;
	all?: boolean;
}

export async function runDiagnostics(): Promise<DoctorReport> {
	const checks: DoctorCheckItem[] = [];

	// 1. Environment: System & Platform
	checks.push({
		category: "Environment",
		name: "system",
		status: "ok",
		message: `${process.platform}-${process.arch} (${Intl.DateTimeFormat().resolvedOptions().locale ?? "en-US"})`,
	});

	// 2. Runtime: Bun Version Check
	const bunVer = Bun.version;
	const isBunSupported = Bun.semver.order(bunVer, MIN_BUN_VERSION) >= 0;
	checks.push({
		category: "Environment",
		name: "runtime",
		status: isBunSupported ? "ok" : "fail",
		message: `Bun v${bunVer} (min required v${MIN_BUN_VERSION})`,
	});

	// 3. Search: Ripgrep availability
	let rgVersion = "not found";
	let rgStatus: DoctorStatus = "warn";
	try {
		const out = execSync("rg --version", { stdio: ["ignore", "pipe", "ignore"], encoding: "utf-8" });
		const firstLine = out.split("\n")[0] ?? "";
		rgVersion = firstLine.trim();
		rgStatus = "ok";
	} catch {}
	checks.push({
		category: "Environment",
		name: "search",
		status: rgStatus,
		message: rgVersion,
	});

	// 4. Git binary and repo status
	let gitStatus: DoctorStatus = "ok";
	let gitMessage = "git installed";
	try {
		const out = execSync("git --version", { stdio: ["ignore", "pipe", "ignore"], encoding: "utf-8" });
		gitMessage = out.trim();
		try {
			execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });
			gitMessage += " (inside working tree)";
		} catch {
			gitMessage += " (outside git repository)";
		}
	} catch {
		gitStatus = "fail";
		gitMessage = "git binary not found in PATH";
	}
	checks.push({
		category: "Environment",
		name: "git",
		status: gitStatus,
		message: gitMessage,
	});

	// 5. Terminal Detection
	const term = process.env.TERM ?? "unknown";
	const termProgram = process.env.TERM_PROGRAM ?? process.env.COLORTERM ?? "standard";
	checks.push({
		category: "Environment",
		name: "terminal",
		status: "ok",
		message: `${term} (${termProgram})`,
	});

	// 6. Storage & Directory Health
	const agentDir = getAgentDir();
	let storageStatus: DoctorStatus = "ok";
	let storageMessage = `directory ${agentDir} healthy`;
	try {
		await fs.mkdir(agentDir, { recursive: true });
		const testFile = path.join(agentDir, `.doctor-write-test-${Date.now()}`);
		await fs.writeFile(testFile, "ok", "utf-8");
		await fs.unlink(testFile);
	} catch (error) {
		storageStatus = "fail";
		storageMessage = `write failed in ${agentDir}: ${error instanceof Error ? error.message : String(error)}`;
	}
	checks.push({
		category: "Configuration",
		name: "storage",
		status: storageStatus,
		message: storageMessage,
	});

	// 7. Settings Configuration Integrity
	let settingsStatus: DoctorStatus = "ok";
	let settingsMessage = "settings loaded";
	try {
		const settings = await Settings.init({ cwd: getProjectDir(), agentDir });
		const keys = Object.keys(settings.get("modelRoles") ?? {});
		settingsMessage = `loaded with ${keys.length} model role(s) configured`;
	} catch (error) {
		settingsStatus = "warn";
		settingsMessage = `settings load error: ${error instanceof Error ? error.message : String(error)}`;
	}
	checks.push({
		category: "Configuration",
		name: "config",
		status: settingsStatus,
		message: settingsMessage,
	});

	// 8. Auth Storage & Credentials
	let authStatus: DoctorStatus = "ok";
	let authMessage = "auth configured";
	try {
		const authStorage = await discoverAuthStorage(agentDir);
		const modelRegistry = new ModelRegistry(authStorage);
		const providers = modelRegistry.getDiscoverableProviders();
		const withKeys = providers.filter(p => authStorage.has(p.id) || authStorage.has(p.name));
		if (withKeys.length === 0) {
			authStatus = "warn";
			authMessage = "no API keys detected in auth storage or environment";
		} else {
			authMessage = `${withKeys.length} provider(s) authenticated (${withKeys.map(p => p.name).join(", ")})`;
		}
	} catch (error) {
		authStatus = "warn";
		authMessage = `auth discovery error: ${error instanceof Error ? error.message : String(error)}`;
	}
	checks.push({
		category: "Configuration",
		name: "auth",
		status: authStatus,
		message: authMessage,
	});

	// 9. MCP Servers Configuration
	const mcpPath = path.join(agentDir, "mcp.json");
	const mcpStatus: DoctorStatus = "ok";
	let mcpMessage = "no external MCP servers configured";
	try {
		const mcpContent = await fs.readFile(mcpPath, "utf-8");
		const mcpJson = JSON.parse(mcpContent);
		const count = Object.keys(mcpJson.mcpServers ?? {}).length;
		mcpMessage = `${count} MCP server(s) configured`;
	} catch {}
	checks.push({
		category: "Configuration",
		name: "mcp",
		status: mcpStatus,
		message: mcpMessage,
	});

	// 10. Network & Proxy Environment
	const httpProxy = process.env.HTTP_PROXY ?? process.env.http_proxy;
	const httpsProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
	const proxyMsg = httpProxy || httpsProxy ? `proxy active (${httpsProxy ?? httpProxy})` : "no proxy env vars";
	checks.push({
		category: "Connectivity",
		name: "network",
		status: "ok",
		message: proxyMsg,
	});

	// Summarize counts
	const summary = {
		ok: checks.filter(c => c.status === "ok").length,
		warn: checks.filter(c => c.status === "warn").length,
		fail: checks.filter(c => c.status === "fail").length,
		idle: checks.filter(c => c.status === "idle").length,
		note: checks.filter(c => c.status === "note").length,
	};

	return {
		version: VERSION,
		platform: `${process.platform}-${process.arch}`,
		timestamp: new Date().toISOString(),
		checks,
		summary,
	};
}

export async function runDoctorCommand(options: DoctorCliOptions = {}): Promise<void> {
	const report = await runDiagnostics();

	if (options.json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		return;
	}

	process.stdout.write(`${chalk.bold(`${APP_NAME} Doctor v${report.version}`)} · ${report.platform}\n\n`);

	const categories = [...new Set(report.checks.map(c => c.category))];

	for (const cat of categories) {
		process.stdout.write(`${chalk.bold(cat)}\n`);
		const catChecks = report.checks.filter(c => c.category === cat);
		for (const check of catChecks) {
			let symbol = chalk.green("✓");
			if (check.status === "warn") symbol = chalk.yellow("!");
			else if (check.status === "fail") symbol = chalk.red("✗");
			else if (check.status === "idle") symbol = chalk.dim("○");
			else if (check.status === "note") symbol = chalk.blue("↑");

			const nameCol = check.name.padEnd(14);
			process.stdout.write(`  ${symbol} ${nameCol} ${check.message}\n`);
		}
		process.stdout.write("\n");
	}

	process.stdout.write("─────────────────────────────────────────────────────────────\n");
	const s = report.summary;
	const parts: string[] = [];
	if (s.ok > 0) parts.push(chalk.green(`${s.ok} ok`));
	if (s.idle > 0) parts.push(chalk.dim(`${s.idle} idle`));
	if (s.note > 0) parts.push(chalk.blue(`${s.note} note`));
	if (s.warn > 0) parts.push(chalk.yellow(`${s.warn} warn`));
	if (s.fail > 0) parts.push(chalk.red(`${s.fail} fail`));

	const overallStatus = s.fail > 0 ? chalk.red("fail") : s.warn > 0 ? chalk.yellow("warn") : chalk.green("ok");
	process.stdout.write(`${parts.join(" · ")} ${overallStatus}\n`);
}
