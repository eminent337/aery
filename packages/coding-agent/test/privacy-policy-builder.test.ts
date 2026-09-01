import { describe, expect, it } from "bun:test";
import { resolvePrivacyMode, resolvePrivacyTier, setPrivacyPolicy } from "@aryee337/aery-ai";
import { buildPrivacyPolicy } from "../src/session/privacy-policy-builder";

const ZEN_FREE = "muse-spark-1.2-contributor-free";
const NON_ZEN_FREE = "openai/gpt-oss-20b:free";
const PAID = "gpt-4o-mini";

describe("buildPrivacyPolicy", () => {
	it("enabled=false is a true kill switch: everything passes, nothing scanned", () => {
		const policy = buildPrivacyPolicy(false, "block", [], []);
		setPrivacyPolicy(policy);
		// Free models — even with secrets — pass untouched.
		expect(resolvePrivacyMode(ZEN_FREE)).toBe("off");
		expect(resolvePrivacyMode(NON_ZEN_FREE)).toBe("off");
		expect(resolvePrivacyMode(PAID)).toBe("off");
	});

	it("enabled=true + block blocks free models only", () => {
		setPrivacyPolicy(buildPrivacyPolicy(true, "block", [], []));
		expect(resolvePrivacyMode(ZEN_FREE)).toBe("block");
		expect(resolvePrivacyMode(NON_ZEN_FREE)).toBe("block");
		expect(resolvePrivacyMode(PAID)).toBe("off");
	});

	it("enabled=true + warn downgrades to warn", () => {
		setPrivacyPolicy(buildPrivacyPolicy(true, "warn", [], []));
		expect(resolvePrivacyMode(ZEN_FREE)).toBe("warn");
		expect(resolvePrivacyMode(NON_ZEN_FREE)).toBe("warn");
		expect(resolvePrivacyMode(PAID)).toBe("off");
	});

	it("enabled=true + off disables scanning without touching other settings", () => {
		setPrivacyPolicy(buildPrivacyPolicy(true, "off", [], []));
		expect(resolvePrivacyMode(ZEN_FREE)).toBe("off");
		expect(resolvePrivacyMode(PAID)).toBe("off");
	});

	it("extras extend the data-collecting set; allowlist overrides it", () => {
		setPrivacyPolicy(buildPrivacyPolicy(true, "block", ["my-provider/my-model"], [ZEN_FREE, "MY-CUSTOM/MODEL"]));
		expect(resolvePrivacyTier("my-provider/my-model")).toBe("data-collecting");
		expect(resolvePrivacyMode("my-provider/my-model")).toBe("block");
		// Allowlist wins over built-in free-tier classification (case-insensitive).
		expect(resolvePrivacyMode(ZEN_FREE)).toBe("off");
		expect(resolvePrivacyMode("my-custom/model")).toBe("off");
	});

	it("allowlist does not affect paid models (they were never scanned)", () => {
		setPrivacyPolicy(buildPrivacyPolicy(true, "block", [], [PAID]));
		expect(resolvePrivacyMode(PAID)).toBe("off");
	});
});
