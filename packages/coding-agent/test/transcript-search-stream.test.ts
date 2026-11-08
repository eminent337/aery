import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	findLastCompactBoundaryOffset,
	openTranscriptNoFollow,
	streamSearchTranscript,
	type TranscriptSearchResult,
} from "../src/session/transcript-search-stream";

describe("transcript-search-stream", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aery-stream-search-test-"));
	});

	afterEach(async () => {
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {}
	});

	describe("openTranscriptNoFollow", () => {
		it("opens regular transcript files safely", async () => {
			const targetPath = path.join(tempDir, "regular.jsonl");
			await fs.writeFile(targetPath, '{"type":"USER_INPUT","content":"hello"}\n', "utf-8");

			const handle = await openTranscriptNoFollow(targetPath);
			expect(handle).toBeDefined();

			const stat = await handle.stat();
			expect(stat.isFile()).toBe(true);
			await handle.close();
		});

		it("throws code ELOOP if path is a symlink", async () => {
			const realPath = path.join(tempDir, "real.jsonl");
			const symlinkPath = path.join(tempDir, "link.jsonl");
			await fs.writeFile(realPath, '{"type":"USER_INPUT","content":"hello"}\n', "utf-8");
			await fs.symlink(realPath, symlinkPath);

			let thrownError: unknown = null;
			try {
				await openTranscriptNoFollow(symlinkPath);
			} catch (err) {
				thrownError = err;
			}

			expect(thrownError).not.toBeNull();
			expect((thrownError as { code?: string }).code).toBe("ELOOP");
		});

		it("throws code ELOOP if path is a directory", async () => {
			const dirPath = path.join(tempDir, "subfolder");
			await fs.mkdir(dirPath);

			let thrownError: unknown = null;
			try {
				await openTranscriptNoFollow(dirPath);
			} catch (err) {
				thrownError = err;
			}

			expect(thrownError).not.toBeNull();
			expect((thrownError as { code?: string }).code).toBe("ELOOP");
		});

		it("throws code ENOENT if path does not exist", async () => {
			const missingPath = path.join(tempDir, "nonexistent.jsonl");

			let thrownError: unknown = null;
			try {
				await openTranscriptNoFollow(missingPath);
			} catch (err) {
				thrownError = err;
			}

			expect(thrownError).not.toBeNull();
			expect((thrownError as { code?: string }).code).toBe("ENOENT");
		});
	});

	describe("findLastCompactBoundaryOffset", () => {
		it("returns 0 for empty files or files without compact boundary", async () => {
			const emptyPath = path.join(tempDir, "empty.jsonl");
			await fs.writeFile(emptyPath, "", "utf-8");

			const offsetEmpty = await findLastCompactBoundaryOffset(emptyPath);
			expect(offsetEmpty).toBe(0);

			const normalPath = path.join(tempDir, "normal.jsonl");
			const lines = [
				JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", content: "test 1" }),
				JSON.stringify({ step_index: 1, source: "MODEL", content: "response 1" }),
			].join("\n") + "\n";
			await fs.writeFile(normalPath, lines, "utf-8");

			const offsetNormal = await findLastCompactBoundaryOffset(normalPath);
			expect(offsetNormal).toBe(0);
		});

		it("returns 0 gracefully for missing files", async () => {
			const missingPath = path.join(tempDir, "not-found.jsonl");
			const offset = await findLastCompactBoundaryOffset(missingPath);
			expect(offset).toBe(0);
		});

		it("locates byte offset after the last compact boundary record", async () => {
			const targetPath = path.join(tempDir, "history.jsonl");
			const line1 = JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", content: "Initial greeting" }) + "\n";
			const line2 = JSON.stringify({ type: "compact_boundary", summary: "Summary of earlier turns" }) + "\n";
			const line3 = JSON.stringify({ step_index: 2, source: "USER_EXPLICIT", content: "Continue work" }) + "\n";
			const line4 = JSON.stringify({ type: "compact_boundary", summary: "Second compaction boundary" }) + "\n";
			const line5 = JSON.stringify({ step_index: 4, source: "MODEL", content: "Final answer" }) + "\n";

			const expectedOffset = Buffer.byteLength(line1 + line2 + line3 + line4, "utf-8");
			await fs.writeFile(targetPath, line1 + line2 + line3 + line4 + line5, "utf-8");

			const offset = await findLastCompactBoundaryOffset(targetPath);
			expect(offset).toBe(expectedOffset);
		});

		it("handles corrupted lines gracefully without throwing", async () => {
			const targetPath = path.join(tempDir, "corrupted.jsonl");
			const line1 = "{ broken json line without closure\n";
			const line2 = JSON.stringify({ type: "compact_boundary", summary: "valid boundary" }) + "\n";
			const line3 = "another {bad: syntax}\n";
			const line4 = JSON.stringify({ step_index: 2, content: "clean line" }) + "\n";

			const expectedOffset = Buffer.byteLength(line1 + line2, "utf-8");
			await fs.writeFile(targetPath, line1 + line2 + line3 + line4, "utf-8");

			const offset = await findLastCompactBoundaryOffset(targetPath);
			expect(offset).toBe(expectedOffset);
		});
	});

	describe("streamSearchTranscript", () => {
		it("returns empty array for missing or empty files", async () => {
			const missingPath = path.join(tempDir, "absent.jsonl");
			const emptyPath = path.join(tempDir, "empty.jsonl");
			await fs.writeFile(emptyPath, "", "utf-8");

			const resultsMissing = await streamSearchTranscript({
				filePath: missingPath,
				query: "anything",
			});
			expect(resultsMissing).toEqual([]);

			const resultsEmpty = await streamSearchTranscript({
				filePath: emptyPath,
				query: "anything",
			});
			expect(resultsEmpty).toEqual([]);
		});

		it("searches with case-insensitive substring and extracts turn index, role, timestamp, snippet, and context", async () => {
			const targetPath = path.join(tempDir, "conversation.jsonl");
			const turns = [
				{
					step_index: 10,
					source: "USER_EXPLICIT",
					created_at: "2026-11-08T08:00:00.000Z",
					content: "Please inspect the PostgreSQL connection pool configurations.",
				},
				{
					step_index: 11,
					source: "MODEL",
					created_at: "2026-11-08T08:01:00.000Z",
					content: "I checked the configuration and postgresql pool size is 20.",
				},
				{
					step_index: 12,
					source: "TOOL",
					created_at: "2026-11-08T08:02:00.000Z",
					content: "Status check ok, redis cache connected.",
				},
			];

			await fs.writeFile(
				targetPath,
				turns.map((t) => JSON.stringify(t)).join("\n") + "\n",
				"utf-8"
			);

			const results = await streamSearchTranscript({
				filePath: targetPath,
				query: "PoStGrEsQl",
			});

			expect(results).toHaveLength(2);

			expect(results[0].turnIndex).toBe(10);
			expect(results[0].role).toBe("USER_EXPLICIT");
			expect(results[0].timestamp).toBe("2026-11-08T08:00:00.000Z");
			expect(results[0].snippet.toLowerCase()).toContain("postgresql");
			expect(results[0].context).toContain("PostgreSQL connection pool");

			expect(results[1].turnIndex).toBe(11);
			expect(results[1].role).toBe("MODEL");
			expect(results[1].timestamp).toBe("2026-11-08T08:01:00.000Z");
			expect(results[1].snippet.toLowerCase()).toContain("postgresql");
		});

		it("searches with regex patterns", async () => {
			const targetPath = path.join(tempDir, "regex-test.jsonl");
			const turns = [
				{
					turnIndex: 1,
					role: "user",
					timestamp: "2026-11-08T08:10:00Z",
					content: "Failed with error code ERR_404 in handler.",
				},
				{
					turnIndex: 2,
					role: "assistant",
					timestamp: "2026-11-08T08:11:00Z",
					content: "Encountered err_500 during retry attempt.",
				},
				{
					turnIndex: 3,
					role: "user",
					timestamp: "2026-11-08T08:12:00Z",
					content: "Everything succeeded on turn three.",
				},
			];

			await fs.writeFile(
				targetPath,
				turns.map((t) => JSON.stringify(t)).join("\n") + "\n",
				"utf-8"
			);

			const results = await streamSearchTranscript({
				filePath: targetPath,
				query: /ERR_\d{3}/i,
			});

			expect(results).toHaveLength(2);
			expect(results[0].turnIndex).toBe(1);
			expect(results[0].snippet).toContain("ERR_404");
			expect(results[1].turnIndex).toBe(2);
			expect(results[1].snippet).toContain("err_500");
		});

		it("respects maxResults limit and halts scanning early", async () => {
			const targetPath = path.join(tempDir, "many-results.jsonl");
			const turns = Array.from({ length: 25 }, (_, i) => ({
				step_index: i,
				source: i % 2 === 0 ? "USER_EXPLICIT" : "MODEL",
				created_at: `2026-11-08T08:${i.toString().padStart(2, "0")}:00Z`,
				content: `Target keyword present in message number ${i}`,
			}));

			await fs.writeFile(
				targetPath,
				turns.map((t) => JSON.stringify(t)).join("\n") + "\n",
				"utf-8"
			);

			const results = await streamSearchTranscript({
				filePath: targetPath,
				query: "target keyword",
				maxResults: 4,
			});

			expect(results).toHaveLength(4);
			expect(results[0].turnIndex).toBe(0);
			expect(results[3].turnIndex).toBe(3);
		});

		it("streams starting from a specific startOffset", async () => {
			const targetPath = path.join(tempDir, "offset-search.jsonl");
			const line1 = JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", content: "alpha match" }) + "\n";
			const line2 = JSON.stringify({ type: "compact_boundary", summary: "compacted" }) + "\n";
			const line3 = JSON.stringify({ step_index: 2, source: "USER_EXPLICIT", content: "beta match" }) + "\n";
			const line4 = JSON.stringify({ step_index: 3, source: "MODEL", content: "gamma match" }) + "\n";

			await fs.writeFile(targetPath, line1 + line2 + line3 + line4, "utf-8");

			const boundaryOffset = await findLastCompactBoundaryOffset(targetPath);
			expect(boundaryOffset).toBe(Buffer.byteLength(line1 + line2, "utf-8"));

			const results = await streamSearchTranscript({
				filePath: targetPath,
				query: "match",
				startOffset: boundaryOffset,
			});

			expect(results).toHaveLength(2);
			expect(results[0].turnIndex).toBe(2);
			expect(results[0].snippet).toContain("beta match");
			expect(results[1].turnIndex).toBe(3);
			expect(results[1].snippet).toContain("gamma match");
		});

		it("handles corrupted lines gracefully without aborting whole search", async () => {
			const targetPath = path.join(tempDir, "corrupted-search.jsonl");
			const lines = [
				"{ this is broken json",
				JSON.stringify({
					step_index: 1,
					source: "USER_EXPLICIT",
					created_at: "2026-11-08T08:00:00Z",
					content: "First valid match found here.",
				}),
				"random text line that is not json",
				JSON.stringify({
					step_index: 2,
					source: "MODEL",
					created_at: "2026-11-08T08:01:00Z",
					content: "Second valid match found here.",
				}),
			].join("\n") + "\n";

			await fs.writeFile(targetPath, lines, "utf-8");

			const results = await streamSearchTranscript({
				filePath: targetPath,
				query: "valid match",
			});

			expect(results).toHaveLength(2);
			expect(results[0].turnIndex).toBe(1);
			expect(results[1].turnIndex).toBe(2);
		});

		it("supports positional argument invocation signature", async () => {
			const targetPath = path.join(tempDir, "positional.jsonl");
			const line = JSON.stringify({
				step_index: 5,
				source: "MODEL",
				created_at: "2026-11-08T08:20:00Z",
				content: "Positional signature search test.",
			}) + "\n";
			await fs.writeFile(targetPath, line, "utf-8");

			const results = await streamSearchTranscript(targetPath, "positional", { maxResults: 1 });
			expect(results).toHaveLength(1);
			expect(results[0].turnIndex).toBe(5);
		});

		it("supports async iteration using for-await-of loop", async () => {
			const targetPath = path.join(tempDir, "async-iter.jsonl");
			const lines = [
				JSON.stringify({ step_index: 1, source: "USER_EXPLICIT", content: "item one stream" }),
				JSON.stringify({ step_index: 2, source: "MODEL", content: "item two stream" }),
			].join("\n") + "\n";
			await fs.writeFile(targetPath, lines, "utf-8");

			const collected: TranscriptSearchResult[] = [];
			for await (const match of streamSearchTranscript(targetPath, "stream")) {
				collected.push(match);
			}

			expect(collected).toHaveLength(2);
			expect(collected[0].turnIndex).toBe(1);
			expect(collected[1].turnIndex).toBe(2);
		});
	});
});
