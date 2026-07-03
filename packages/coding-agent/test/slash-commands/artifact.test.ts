import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeAcpBuiltinSlashCommand } from "@aryee337/aery/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@aryee337/aery/slash-commands/types";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-command-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function createRuntimeHarness(artifactsDir: string) {
	const output = vi.fn(async (_text: string) => {
		return;
	});

	return {
		output,
		runtime: {
			sessionManager: {
				getArtifactsDir: () => artifactsDir,
			},
			output,
		} as unknown as SlashCommandRuntime,
	};
}

describe("/artifact slash command", () => {
	it("lists artifacts when none exist", async () => {
		await withTempDir(async tempDir => {
			const harness = createRuntimeHarness(tempDir);
			const result = await executeAcpBuiltinSlashCommand("/artifact list", harness.runtime);

			expect(result).toEqual({ consumed: true });
			expect(harness.output).toHaveBeenCalledWith("No artifacts found.");
		});
	});

	it("lists existing artifacts with sizes", async () => {
		await withTempDir(async tempDir => {
			await fs.writeFile(path.join(tempDir, "0.bash.log"), "hello bash");
			await fs.writeFile(path.join(tempDir, "1.read.log"), "hello read");

			const harness = createRuntimeHarness(tempDir);
			const result = await executeAcpBuiltinSlashCommand("/artifact list", harness.runtime);

			expect(result).toEqual({ consumed: true });
			const outputArg = harness.output.mock.calls[0]?.[0] as string | undefined;
			expect(outputArg).toContain("Artifacts in this session:");
			expect(outputArg).toContain("0.bash.log");
			expect(outputArg).toContain("1.read.log");
			expect(outputArg).toContain("0.0 KB");
		});
	});

	it("views artifact content", async () => {
		await withTempDir(async tempDir => {
			await fs.writeFile(path.join(tempDir, "0.bash.log"), "artifact content");

			const harness = createRuntimeHarness(tempDir);
			const result = await executeAcpBuiltinSlashCommand("/artifact view 0.bash.log", harness.runtime);

			expect(result).toEqual({ consumed: true });
			expect(harness.output).toHaveBeenCalledWith("--- Artifact: 0.bash.log ---\nartifact content");
		});
	});

	it("clears artifacts", async () => {
		await withTempDir(async tempDir => {
			await fs.writeFile(path.join(tempDir, "0.bash.log"), "content");
			await fs.writeFile(path.join(tempDir, "0.bash.log.metadata.json"), "{}");

			const harness = createRuntimeHarness(tempDir);
			const result = await executeAcpBuiltinSlashCommand("/artifact clear", harness.runtime);

			expect(result).toEqual({ consumed: true });
			expect(harness.output).toHaveBeenCalledWith("Successfully cleared 1 artifact file(s).");

			const files = await fs.readdir(tempDir);
			expect(files).toEqual([]);
		});
	});
});
