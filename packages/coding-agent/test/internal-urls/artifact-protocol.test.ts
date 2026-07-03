import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InternalUrlRouter } from "../../src/internal-urls";
import { ArtifactProtocolHandler } from "../../src/internal-urls/artifact-protocol";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-protocol-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function fakeSessionWithArtifacts(artifactsDir: string) {
	return {
		sessionManager: {
			getArtifactsDir: () => artifactsDir,
		},
	};
}

describe("artifact:// protocol", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
	});

	afterEach(() => {
		InternalUrlRouter.resetForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("resolves artifact://<id> to the correct file content", async () => {
		await withTempDir(async tempDir => {
			const artifactsDir = path.join(tempDir, "artifacts");
			await fs.mkdir(artifactsDir, { recursive: true });
			await fs.writeFile(path.join(artifactsDir, "0.bash.log"), "hello bash output");
			await fs.writeFile(path.join(artifactsDir, "1.read.log"), "hello read output");

			AgentRegistry.global().register({
				id: "MainAgent",
				displayName: "task",
				kind: "main",
				// Unchecked cast of mock session for internal-url testing
				session: fakeSessionWithArtifacts(artifactsDir) as unknown as AgentSession,
				status: "idle",
			});

			const resource0 = await InternalUrlRouter.instance().resolve("artifact://0");
			expect(resource0.content).toBe("hello bash output");
			expect(resource0.contentType).toBe("text/plain");

			const resource1 = await InternalUrlRouter.instance().resolve("artifact://1");
			expect(resource1.content).toBe("hello read output");
		});
	});

	it("throws an error when ID is not numeric", async () => {
		await expect(InternalUrlRouter.instance().resolve("artifact://abc")).rejects.toThrow(
			"artifact:// ID must be numeric, got: abc",
		);
		await expect(InternalUrlRouter.instance().resolve("artifact://")).rejects.toThrow(
			"artifact:// URL requires a numeric ID",
		);
	});

	it("lists available IDs in the error message when not found", async () => {
		await withTempDir(async tempDir => {
			const artifactsDir = path.join(tempDir, "artifacts");
			await fs.mkdir(artifactsDir, { recursive: true });
			await fs.writeFile(path.join(artifactsDir, "0.bash.log"), "hello");
			await fs.writeFile(path.join(artifactsDir, "5.read.log"), "world");

			AgentRegistry.global().register({
				id: "MainAgent",
				displayName: "task",
				kind: "main",
				// Unchecked cast of mock session for internal-url testing
				session: fakeSessionWithArtifacts(artifactsDir) as unknown as AgentSession,
				status: "idle",
			});

			await expect(InternalUrlRouter.instance().resolve("artifact://2")).rejects.toThrow(
				"Artifact 2 not found. Available: 0, 5",
			);
		});
	});

	it("completes URL completions", async () => {
		await withTempDir(async tempDir => {
			const artifactsDir = path.join(tempDir, "artifacts");
			await fs.mkdir(artifactsDir, { recursive: true });
			await fs.writeFile(path.join(artifactsDir, "0.bash.log"), "hello");
			await fs.writeFile(path.join(artifactsDir, "3.read.log"), "world");

			AgentRegistry.global().register({
				id: "MainAgent",
				displayName: "task",
				kind: "main",
				// Unchecked cast of mock session for internal-url testing
				session: fakeSessionWithArtifacts(artifactsDir) as unknown as AgentSession,
				status: "idle",
			});

			const handler = new ArtifactProtocolHandler();
			const completions = await handler.complete();
			expect(completions).toEqual([{ value: "0" }, { value: "3" }]);
		});
	});
});
