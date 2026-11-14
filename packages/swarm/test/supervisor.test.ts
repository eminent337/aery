import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwarmSupervisor } from "../src/supervisor/swarm-supervisor";

describe("SwarmSupervisor", () => {
	let testDir: string;
	let supervisor: SwarmSupervisor;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "swarm-super-"));
		supervisor = new SwarmSupervisor({
			swarmId: "test-super",
			storageDir: testDir,
		});
	});

	afterEach(() => {
		supervisor.destroy();
		rmSync(testDir, { recursive: true, force: true });
	});

	it("initializes coordinator and tools", () => {
		const members = supervisor.getMembers();
		expect(members).toHaveLength(1);
		expect(members[0].name).toBe("coordinator");

		const tools = supervisor.getToolsFor("coordinator");
		expect(tools.map((t) => t.name)).toContain("swarm");
		expect(tools.map((t) => t.name)).toContain("post_message");
	});
});
