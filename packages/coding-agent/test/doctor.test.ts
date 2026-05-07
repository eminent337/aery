import { describe, expect, test } from "vitest";
import { collectDoctorReport, formatCoreExtensionsReport, formatDoctorReport } from "../src/cli/doctor.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";

describe("doctor", () => {
	test("formats version, provider auth, and extension health without secrets", async () => {
		const authStorage = AuthStorage.inMemory({
			anthropic: { type: "api_key", key: "secret-anthropic-key" },
			"cloudflare-workers-ai": { type: "api_key", key: "secret-cloudflare-key" },
		});
		const modelRegistry = ModelRegistry.inMemory(authStorage);

		const report = await collectDoctorReport({
			version: "0.1.96",
			authStorage,
			modelRegistry,
			latestVersion: async () => "0.1.97",
			coreExtensions: {
				repoExists: true,
				missingFiles: [],
				missingSettingsEntries: ["/tmp/aery-extensions/core/aery-doctor.ts"],
			},
		});
		const output = formatDoctorReport(report);

		expect(output).toContain("Aery Doctor");
		expect(output).toContain("local: 0.1.96");
		expect(output).toContain("latest: 0.1.97");
		expect(output).toContain("update available");
		expect(output).toContain("anthropic: configured via stored");
		expect(output).toContain("cloudflare-workers-ai: missing Cloudflare account ID");
		expect(output).toContain("core extensions: attention needed");
		expect(output).toContain("missing settings entries: 1");
		expect(output).not.toContain("secret-anthropic-key");
		expect(output).not.toContain("secret-cloudflare-key");
	});

	test("formats core extension health for interactive diagnostics", () => {
		expect(
			formatCoreExtensionsReport({
				repoExists: true,
				missingFiles: [],
				missingSettingsEntries: [],
			}),
		).toContain("core extensions: ok");

		const output = formatCoreExtensionsReport({
			repoExists: true,
			missingFiles: ["/tmp/aery-extensions/core/missing.ts"],
			missingSettingsEntries: ["/tmp/aery-extensions/core/aery-doctor.ts"],
		});

		expect(output).toContain("core extensions: attention needed");
		expect(output).toContain("missing files: 1");
		expect(output).toContain("missing settings entries: 1");
		expect(output).toContain("repair: run aery update --extensions");
	});
});
