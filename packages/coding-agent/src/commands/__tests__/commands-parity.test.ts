import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseChangelog } from "../../utils/changelog";
import { handleMcpCli } from "../mcp";
import { handleRemoteControlCli } from "../remote-control";

describe("CLI Commands Parity with Google Antigravity (mcp, remote-control, changelog)", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `aery-cli-parity-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
		fs.mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		try {
			fs.rmSync(testDir, { recursive: true, force: true });
		} catch {}
	});

	it("manages MCP servers via aery mcp (add, list, disable, enable, remove)", async () => {
		const mcpJsonPath = path.join(testDir, "mcp.json");

		// Add
		await handleMcpCli(["add", "github-mcp", "npx", "-y", "@modelcontextprotocol/server-github"], testDir);
		expect(fs.existsSync(mcpJsonPath)).toBe(true);

		const added = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
		expect(added.mcpServers["github-mcp"]).toBeDefined();
		expect(added.mcpServers["github-mcp"].command).toBe("npx");
		expect(added.mcpServers["github-mcp"].enabled).toBe(true);

		// Disable
		await handleMcpCli(["disable", "github-mcp"], testDir);
		const disabled = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
		expect(disabled.mcpServers["github-mcp"].enabled).toBe(false);

		// Enable
		await handleMcpCli(["enable", "github-mcp"], testDir);
		const enabled = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
		expect(enabled.mcpServers["github-mcp"].enabled).toBe(true);

		// Remove
		await handleMcpCli(["remove", "github-mcp"], testDir);
		const removed = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
		expect(removed.mcpServers["github-mcp"]).toBeUndefined();
	});

	it("manages remote-control background daemon state via aery remote-control", async () => {
		// Start
		await handleRemoteControlCli(["start", "--name", "test-workstation"]);
		const stateFile = path.join(os.homedir(), ".aery", "remote_control_state.json");
		expect(fs.existsSync(stateFile)).toBe(true);

		const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
		expect(state.running).toBe(true);
		expect(state.name).toBe("test-workstation");

		// Stop
		await handleRemoteControlCli(["stop"]);
		const stopped = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
		expect(stopped.running).toBe(false);
	});

	it("parses changelog entries cleanly via parseChangelog", async () => {
		const mockChangelog = path.join(testDir, "CHANGELOG.md");
		fs.writeFileSync(
			mockChangelog,
			`# Changelog\n\n## [1.2.0] - 2026-10-27\n- Added Worktree Battle Mode\n- Added PolicyGuardian\n\n## [1.1.0] - 2026-10-20\n- Initial release`,
		);

		const entries = await parseChangelog(mockChangelog);
		expect(entries.length).toBe(2);
		expect(entries[0].major).toBe(1);
		expect(entries[0].minor).toBe(2);
		expect(entries[0].content).toContain("Added Worktree Battle Mode");
	});

	it("runs models list command via ModelRegistry without throwing", async () => {
		const { discoverAuthStorage } = await import("../../sdk");
		const { ModelRegistry } = await import("../../config/model-registry");
		const { listModels } = await import("../../cli/list-models");
		const authStorage = await discoverAuthStorage();
		const registry = new ModelRegistry(authStorage);
		expect(registry).toBeDefined();
		// Should execute cleanly without throwing
		await listModels(registry, "non-existent-filter-xyz");
	});
});
