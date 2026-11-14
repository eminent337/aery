import { describe, expect, it } from "bun:test";
import { builtinSlashCommands } from "../builtin-registry";

describe("/swarm slash command", () => {
	it("registers /swarm command in registry", () => {
		const swarmCmd = builtinSlashCommands.find((c) => c.name === "swarm");
		expect(swarmCmd).toBeDefined();
		expect(swarmCmd?.description).toContain("Swarm");
	});
});
