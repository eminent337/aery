import { describe, expect, it } from "vitest";
import {
	detectExternalAgents,
	findBinaryInPath,
} from "../src/extensibility/external-agents/discovery";

describe("External Agent Discovery", () => {
	it("detects system binaries present in PATH", async () => {
		// 'sh' is guaranteed to exist on Linux
		const shPath = await findBinaryInPath("sh");
		expect(shPath).not.toBeNull();
		expect(shPath).toContain("sh");
	});

	it("returns null for non-existent binary", async () => {
		const fakePath = await findBinaryInPath("non_existent_binary_xyz_12345");
		expect(fakePath).toBeNull();
	});

	it("discovers installed host agents", async () => {
		const results = await detectExternalAgents();
		expect(Array.isArray(results.installed)).toBe(true);
		expect(Array.isArray(results.uninstalled)).toBe(true);

		// agy, codex, and opencode are known to be installed on the host
		const ids = results.installed.map(a => a.id);
		expect(ids).toContain("agy");
		expect(ids).toContain("codex");
		expect(ids).toContain("opencode");

		const agyAgent = results.installed.find(a => a.id === "agy");
		expect(agyAgent?.installed).toBe(true);
		expect(agyAgent?.binaryPath).toBeDefined();
	});
});
