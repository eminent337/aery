import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeBash } from "../../exec/bash-executor";
import { probeSandbox } from "../bwrap-driver";

describe("Live Sandbox Execution Containment", () => {
	let testWorkspace: string;
	const probe = probeSandbox();

	beforeAll(async () => {
		testWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "aery-sandbox-live-"));
	});

	afterAll(async () => {
		try {
			await fs.rm(testWorkspace, { recursive: true, force: true });
		} catch {}
	});

	it("permits write operations within the designated workspace", async () => {
		if (!probe.available) return;

		const targetFile = path.join(testWorkspace, "allowed.txt");
		const res = await executeBash(`echo 'sandbox write ok' > "${targetFile}"`, {
			cwd: testWorkspace,
			sandbox: {
				enabled: true,
				workspaceDir: testWorkspace,
			},
		});

		expect(res.exitCode).toBe(0);
		const content = await fs.readFile(targetFile, "utf-8");
		expect(content.trim()).toBe("sandbox write ok");
	});

	it("prevents write operations to the root filesystem outside the workspace", async () => {
		if (!probe.available) return;

		const forbiddenTarget = "/sandbox_forbidden_test_file";
		const res = await executeBash(`touch "${forbiddenTarget}"`, {
			cwd: testWorkspace,
			sandbox: {
				enabled: true,
				workspaceDir: testWorkspace,
			},
		});

		// Command should fail with non-zero exit code due to Read-only filesystem
		expect(res.exitCode).not.toBe(0);
		expect(res.output.toLowerCase()).toContain("read-only file system");
	});
});
