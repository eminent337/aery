import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "../artifact-store";
import type { ArtifactMetadata } from "../types";

describe("Interactive Artifacts Store", () => {
	let testArtifactDir: string;
	let store: ArtifactStore;

	beforeAll(async () => {
		testArtifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "aery-artifacts-test-"));
		store = new ArtifactStore(testArtifactDir);
	});

	afterAll(async () => {
		try {
			await fs.rm(testArtifactDir, { recursive: true, force: true });
		} catch {}
	});

	it("creates an artifact with structured metadata", async () => {
		const metadata: ArtifactMetadata = {
			summary: "System design spec for high-throughput pipeline",
			userFacing: true,
			requestFeedback: true,
		};
		const content = "# Architecture Plan\n\nDetailed system architecture...";

		const artifact = await store.saveArtifact("architecture_plan", content, metadata);

		expect(artifact.id).toBe("architecture_plan");
		expect(artifact.filename).toBe("architecture_plan.md");
		expect(artifact.metadata.summary).toBe("System design spec for high-throughput pipeline");
		expect(artifact.metadata.requestFeedback).toBe(true);

		// File exists on disk
		const diskContent = await fs.readFile(artifact.path, "utf-8");
		expect(diskContent).toBe(content);
	});

	it("reads an existing artifact and retrieves its metadata", async () => {
		const retrieved = await store.getArtifact("architecture_plan");
		expect(retrieved).not.toBeNull();
		expect(retrieved?.id).toBe("architecture_plan");
		expect(retrieved?.metadata.userFacing).toBe(true);
		expect(retrieved?.content).toContain("# Architecture Plan");
	});

	it("lists all stored artifacts with metadata summary", async () => {
		await store.saveArtifact("test_notes", "Some notes", {
			summary: "Scratchpad notes",
			userFacing: false,
		});

		const list = await store.listArtifacts();
		expect(list.length).toBe(2);
		expect(list.map(a => a.id)).toContain("architecture_plan");
		expect(list.map(a => a.id)).toContain("test_notes");
	});
});
