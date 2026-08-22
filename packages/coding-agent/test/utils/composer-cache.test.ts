import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { env } from "node:process";

let originalHome: string | undefined;
const TEST_HOME = "/tmp/aery-test-home";

describe("composer-cache", () => {
	beforeEach(async () => {
		originalHome = env.HOME;
		env.HOME = TEST_HOME;
		await mkdir(TEST_HOME, { recursive: true });
	});

	afterEach(async () => {
		env.HOME = originalHome;
		await rm(TEST_HOME, { recursive: true, force: true });
	});

	it("load_cache_returns_empty_array_when_file_missing", async () => {
		const { loadComposerCache } = require("../../src/utils/composer-cache");
		const entries = await loadComposerCache();
		expect(entries).toEqual([]);
	});

	it("save_and_load_round_trip", async () => {
		const { saveComposerCache, loadComposerCache } = require("../../src/utils/composer-cache");
		const testEntries = [{ prompt: "test prompt", timestamp: Date.now(), sessionId: "test-123" }];
		await saveComposerCache(testEntries);
		const loaded = await loadComposerCache();
		expect(loaded).toHaveLength(1);
		expect(loaded[0].prompt).toBe("test prompt");
	});

	it("record_prompt_prepends_to_cache", async () => {
		const { recordPrompt, loadComposerCache } = require("../../src/utils/composer-cache");
		await recordPrompt("first prompt");
		await recordPrompt("second prompt");
		const entries = await loadComposerCache();
		expect(entries).toHaveLength(2);
		expect(entries[0].prompt).toBe("second prompt"); // Most recent first
		expect(entries[1].prompt).toBe("first prompt");
	});

	it("get_recent_prompts_returns_most_recent", async () => {
		const { recordPrompt, getRecentPrompts } = require("../../src/utils/composer-cache");
		for (let i = 0; i < 10; i++) {
			await recordPrompt(`prompt ${i}`);
		}
		const recent = await getRecentPrompts(3);
		expect(recent).toHaveLength(3);
		expect(recent[0].prompt).toBe("prompt 9");
		expect(recent[2].prompt).toBe("prompt 7");
	});

	it("record_prompt_trims_long_prompts", async () => {
		const { recordPrompt, loadComposerCache } = require("../../src/utils/composer-cache");
		const longPrompt = "a".repeat(500);
		await recordPrompt(longPrompt);
		const entries = await loadComposerCache();
		expect(entries[0].prompt.length).toBeLessThanOrEqual(200);
	});
});
