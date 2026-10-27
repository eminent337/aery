import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WriteTool } from "../../tools/write";

describe("WriteTool Artifact Integration", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aery-write-artifact-test-"));
	});

	afterEach(async () => {
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {}
	});

	it("saves structured artifact with metadata when artifactMetadata is supplied", async () => {
		const mockSession: any = {
			cwd: tempDir,
			enableLsp: false,
			settings: {
				get: () => false,
			},
			getClientBridge: () => undefined,
		};

		const writeTool = new WriteTool(mockSession);
		const result = await writeTool.execute("call-1", {
			path: "architecture_spec.md",
			content: "# Architecture Spec\nDesign overview.",
			artifactMetadata: {
				summary: "High-level architecture specification",
				userFacing: true,
				requestFeedback: true,
			},
		});

		const firstText = (result.content[0] as any).text;
		expect(firstText).toContain("Successfully wrote artifact");
		expect(firstText).toContain("Summary: High-level architecture specification");
		expect(firstText).toContain("Feedback Requested");
		expect(result.details?.artifact).toBeDefined();
		expect(result.details?.artifact?.id).toBe("architecture_spec");
		expect(result.details?.artifact?.metadata.summary).toBe("High-level architecture specification");
	});

	it("supports agy-style ArtifactMetadata (PascalCase)", async () => {
		const mockSession: any = {
			cwd: tempDir,
			enableLsp: false,
			settings: {
				get: () => false,
			},
			getClientBridge: () => undefined,
		};

		const writeTool = new WriteTool(mockSession);
		const result = await writeTool.execute("call-2", {
			path: "plan.md",
			content: "# Plan\nStep 1...",
			ArtifactMetadata: {
				Summary: "Migration plan",
				UserFacing: true,
				RequestFeedback: false,
			},
		});

		const secondText = (result.content[0] as any).text;
		expect(secondText).toContain("Successfully wrote artifact");
		expect(secondText).toContain("Summary: Migration plan");
		expect(result.details?.artifact?.metadata.summary).toBe("Migration plan");
	});
});
