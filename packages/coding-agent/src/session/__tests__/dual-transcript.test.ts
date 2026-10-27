import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DualTranscriptWriter } from "../dual-transcript";

describe("DualTranscriptWriter (ported from agy)", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aery-transcript-test-"));
	});

	afterEach(async () => {
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {}
	});

	it("writes small steps to both files without truncation", async () => {
		const writer = new DualTranscriptWriter({ dir: tempDir, truncationThreshold: 100 });

		const res = await writer.appendStep({
			source: "USER_EXPLICIT",
			type: "USER_INPUT",
			status: "DONE",
			content: "Hello, list my files",
		});

		expect(res.compactStep.truncated_fields).toBeUndefined();
		expect(res.compactStep.content).toBe("Hello, list my files");
		expect(res.fullStep.content).toBe("Hello, list my files");

		const compactList = await writer.readCompact();
		expect(compactList.length).toBe(1);
		expect(compactList[0].content).toBe("Hello, list my files");
	});

	it("truncates large content and flags truncated_fields in compact transcript while keeping full log intact", async () => {
		const writer = new DualTranscriptWriter({ dir: tempDir, truncationThreshold: 50 });

		const longContent = "A".repeat(300);
		const longThinking = "B".repeat(200);

		const res = await writer.appendStep({
			source: "MODEL",
			type: "PLANNER_RESPONSE",
			status: "DONE",
			content: longContent,
			thinking: longThinking,
		});

		expect(res.compactStep.truncated_fields).toEqual(["content", "thinking"]);
		expect(res.compactStep.content?.length).toBeLessThan(100);
		expect(res.compactStep.content).toContain("[truncated]");

		// Verify that reading full step returns unabridged data
		const fullStep = await writer.readFullStep(res.fullStep.step_index);
		expect(fullStep).not.toBeNull();
		expect(fullStep?.content).toBe(longContent);
		expect(fullStep?.thinking).toBe(longThinking);
		expect(fullStep?.truncated_fields).toBeUndefined();

		// Check stats
		const stats = await writer.getStats();
		expect(stats.fullBytes).toBeGreaterThan(stats.compactBytes);
		expect(stats.savedBytes).toBeGreaterThan(0);
	});
});
