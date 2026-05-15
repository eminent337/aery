import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";

const testDir = realpathSync(__dirname);
const packageRoot = resolve(testDir, "..");
const repoRoot = resolve(packageRoot, "../..");
const cliPath = resolve(packageRoot, "src/cli.ts");
const tsxPath = resolve(repoRoot, "node_modules/tsx/dist/cli.mjs");
const tsconfigPath = resolve(repoRoot, "tsconfig.json");

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-stdout-clean-"));
	tempDirs.push(dir);
	return dir;
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
	const tempRoot = createTempDir();
	const agentDir = join(tempRoot, "agent");
	const projectDir = join(tempRoot, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });

	return await new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, [tsxPath, cliPath, ...args], {
			cwd: projectDir,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
				AERY_OFFLINE: "1",
				TSX_TSCONFIG_PATH: tsconfigPath,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolvePromise({ stdout, stderr, code });
		});
	});
}

describe("stdout cleanliness in non-interactive modes", () => {
	it("keeps stdout empty for --mode json --help", async () => {
		const result = await runCli(["--mode", "json", "--help"]);

		expect(result.code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("Usage:");
	});

	it("keeps stdout empty for -p --help", async () => {
		const result = await runCli(["-p", "--help"]);

		expect(result.code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("Usage:");
	});
});
