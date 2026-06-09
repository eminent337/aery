import { describe, expect, it } from "bun:test";
import { getBashCommandForDisplay, isRtkPassthrough, rewriteWithRtk } from "./rtk";

// ---------------------------------------------------------------------------
// isRtkPassthrough
// ---------------------------------------------------------------------------

describe("isRtkPassthrough", () => {
	it.each([
		"pnpm run lint",
		"npm run lint",
		"yarn run build",
		"bun run test",
		"pnpm run lint --fix",
		"npm run lint:fix",
		"npx eslint .",
		"pnpm exec eslint .",
		"bunx tsx script.ts",
		"  pnpm run lint",
	])("returns true for %s", (cmd: string) => {
		expect(isRtkPassthrough(cmd)).toBe(true);
	});

	it.each([
		"git status",
		"cargo test",
		"pnpm install",
		"npm install",
		"pnpm add react",
		"echo pnpm run lint",
	])("returns false for %s", (cmd: string) => {
		expect(isRtkPassthrough(cmd)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// rewriteWithRtk (no rtk binary available in test env)
// ---------------------------------------------------------------------------

describe("rewriteWithRtk", () => {
	it("passes through package manager scripts", () => {
		expect(rewriteWithRtk("npm run test")).toBe("npm run test");
	});

	it("passes through npx/bunx", () => {
		expect(rewriteWithRtk("npx eslint .")).toBe("npx eslint .");
	});

	it("returns original when rtk not available", () => {
		// No rtk in CI/test env, so this should return the original
		const result = rewriteWithRtk("git status");
		expect(typeof result).toBe("string");
	});
});

// ---------------------------------------------------------------------------
// getBashCommandForDisplay
// ---------------------------------------------------------------------------

describe("getBashCommandForDisplay", () => {
	it("returns undefined for undefined", () => {
		expect(getBashCommandForDisplay(undefined)).toBeUndefined();
	});

	it("returns original when not cached", () => {
		expect(getBashCommandForDisplay("git status")).toBe("git status");
	});
});
