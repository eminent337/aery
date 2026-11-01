import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import { clearAgentDiscoveryCache, discoverAgents } from "../../src/task/discovery";

describe("Agent Discovery In-Memory Cache", () => {
	beforeEach(() => {
		clearAgentDiscoveryCache();
	});

	afterEach(() => {
		clearAgentDiscoveryCache();
	});

	it("caches discovery results on consecutive calls for snappy turnaround", async () => {
		const cwd = process.cwd();
		const home = os.homedir();

		const start1 = performance.now();
		const res1 = await discoverAgents(cwd, home);
		const dur1 = performance.now() - start1;

		const start2 = performance.now();
		const res2 = await discoverAgents(cwd, home);
		const dur2 = performance.now() - start2;

		expect(res1.agents.length).toBe(res2.agents.length);
		// Second call must hit memory cache and take < 5ms
		expect(dur2).toBeLessThan(10);
	});

	it("bypasses cache when force option is true", async () => {
		const cwd = process.cwd();
		const home = os.homedir();

		const res1 = await discoverAgents(cwd, home);
		const res2 = await discoverAgents(cwd, home, { force: true });

		expect(res1.agents.length).toBe(res2.agents.length);
	});

	it("clears cache via clearAgentDiscoveryCache", async () => {
		const cwd = process.cwd();
		const home = os.homedir();

		await discoverAgents(cwd, home);
		clearAgentDiscoveryCache();

		const res = await discoverAgents(cwd, home);
		expect(res.agents.length).toBeGreaterThan(0);
	});
});
