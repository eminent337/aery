import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { runMigrations } from "../src/migrations.js";

const CORE_EXTENSION_PATHS = [
	"damage-control",
	"provider-profiles",
	"model-failover",
	"web-search",
	"web-fetch",
	"commands",
	"hooks",
	"circuit-breaker",
	"auto-router",
	"memory-include",
	"aery-header",
	"aery-footer",
	"multi-agent",
	"agent-chain",
	"agent-teams",
	"help",
	"default-agents",
	"aery-doctor",
	"aery-team",
	"subagent/index",
	"marketplace",
	"init-prompt",
];

describe("core extensions migration", () => {
	const tempDirs: string[] = [];
	const previousAgentDir = process.env[ENV_AGENT_DIR];

	afterEach(() => {
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function createAgentDirWithCoreExtensions(): { agentDir: string; repoPath: string } {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "aery-core-extensions-test-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;

		const repoPath = path.join(agentDir, "git", "github.com", "eminent337", "aery-extensions");
		for (const extensionPath of CORE_EXTENSION_PATHS) {
			const filePath = path.join(repoPath, "core", `${extensionPath}.ts`);
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export default function extension() {}\n", "utf-8");
		}

		return { agentDir, repoPath };
	}

	it("creates settings.json and wires all core extensions when the core repo already exists", () => {
		const { agentDir, repoPath } = createAgentDirWithCoreExtensions();

		runMigrations(agentDir);

		const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf-8")) as {
			extensions?: string[];
		};
		expect(settings.extensions).toEqual(
			CORE_EXTENSION_PATHS.map((extensionPath) => path.join(repoPath, "core", `${extensionPath}.ts`)),
		);
	});
});
