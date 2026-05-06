import { describe, expect, test } from "vitest";
import {
	formatNoApiKeyFoundMessage,
	getProviderLoginHelp,
	getProviderSetupRequirements,
} from "../src/core/auth-guidance.js";

describe("auth guidance", () => {
	test("keeps generic provider login help concise", () => {
		const help = getProviderLoginHelp();

		expect(help).toContain("Use /login");
		expect(help).toContain("providers.md");
		expect(help).toContain("models.md");
	});

	test("describes Cloudflare Workers AI account id requirement", () => {
		const requirements = getProviderSetupRequirements("cloudflare-workers-ai");

		expect(requirements).toContain("Cloudflare API token");
		expect(requirements).toContain("Cloudflare account ID");
		expect(requirements).toContain("CLOUDFLARE_ACCOUNT_ID");
	});

	test("adds Cloudflare-specific setup requirements to missing key guidance", () => {
		const message = formatNoApiKeyFoundMessage("cloudflare-workers-ai");

		expect(message).toContain("Cloudflare API token");
		expect(message).toContain("Cloudflare account ID");
	});
});
