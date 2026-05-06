import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import {
	CORE_EXTENSION_PATHS,
	diagnoseCoreExtensions,
	formatCoreExtensionAttentionMessage,
	type CoreExtensionEnsureResult,
	runMigrations,
	wireCoreExtensions,
} from "../src/migrations.js";

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

	it("reports missing settings entries for installed core extension files", () => {
		const { agentDir, repoPath } = createAgentDirWithCoreExtensions();
		const settingsPath = path.join(agentDir, "settings.json");
		fs.writeFileSync(settingsPath, JSON.stringify({ extensions: [] }, null, 2), "utf-8");

		const diagnostic = diagnoseCoreExtensions(repoPath, settingsPath);

		expect(diagnostic.missingSettingsEntries).toEqual(
			CORE_EXTENSION_PATHS.map((extensionPath) => path.join(repoPath, "core", `${extensionPath}.ts`)),
		);
		expect(diagnostic.missingFiles).toEqual([]);
	});

	it("wires missing entries without duplicating existing core extensions", () => {
		const { agentDir, repoPath } = createAgentDirWithCoreExtensions();
		const settingsPath = path.join(agentDir, "settings.json");
		const existingPath = path.join(repoPath, "core", "marketplace.ts");
		fs.writeFileSync(settingsPath, JSON.stringify({ extensions: [existingPath] }, null, 2), "utf-8");

		const result = wireCoreExtensions(repoPath, settingsPath);
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as { extensions?: string[] };

		expect(result.added).not.toContain(existingPath);
		expect(settings.extensions?.filter((extensionPath) => extensionPath === existingPath)).toHaveLength(1);
		expect(new Set(settings.extensions)).toEqual(
			new Set(CORE_EXTENSION_PATHS.map((extensionPath) => path.join(repoPath, "core", `${extensionPath}.ts`))),
		);
	});

	it("formats offline core extension repair guidance", () => {
		const result: CoreExtensionEnsureResult = {
			repoExists: false,
			missingFiles: ["/tmp/aery-extensions/core/help.ts"],
			missingSettingsEntries: [],
			added: [],
			status: "offline",
			repoPath: "/tmp/aery-extensions",
			settingsPath: "/tmp/settings.json",
			error: "network unavailable",
		};

		expect(formatCoreExtensionAttentionMessage(result)).toBe(
			"Extensions not installed (no network). Run aery again with network access, or run: aery update --extensions",
		);
	});

	it("formats missing core extension file repair guidance", () => {
		const result: CoreExtensionEnsureResult = {
			repoExists: true,
			missingFiles: ["/tmp/aery-extensions/core/help.ts", "/tmp/aery-extensions/core/hooks.ts"],
			missingSettingsEntries: [],
			added: [],
			status: "ok",
			repoPath: "/tmp/aery-extensions",
			settingsPath: "/tmp/settings.json",
		};

		expect(formatCoreExtensionAttentionMessage(result)).toBe(
			"Core extensions need attention: 2 core extension file(s) are missing. Run: aery update --extensions",
		);
	});

	it("formats missing core extension settings repair guidance", () => {
		const result: CoreExtensionEnsureResult = {
			repoExists: true,
			missingFiles: [],
			missingSettingsEntries: ["/tmp/aery-extensions/core/help.ts"],
			added: [],
			status: "ok",
			repoPath: "/tmp/aery-extensions",
			settingsPath: "/tmp/settings.json",
		};

		expect(formatCoreExtensionAttentionMessage(result)).toBe(
			"Core extensions need attention: 1 core extension setting(s) are missing. Run: aery update --extensions",
		);
	});

	it("returns undefined when core extensions do not need attention", () => {
		const result: CoreExtensionEnsureResult = {
			repoExists: true,
			missingFiles: [],
			missingSettingsEntries: [],
			added: [],
			status: "ok",
			repoPath: "/tmp/aery-extensions",
			settingsPath: "/tmp/settings.json",
		};

		expect(formatCoreExtensionAttentionMessage(result)).toBeUndefined();
	});
});
