import { beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	clearShellEnvCache,
	extractEnvFromOutput,
	getCachedShellEnv,
	resolveShellEnv,
} from "../src/exec/shell-env-resolver";

describe("shell-env-resolver", () => {
	beforeEach(() => {
		clearShellEnvCache();
	});

	describe("extractEnvFromOutput", () => {
		it("parses pure JSON block", () => {
			const json = JSON.stringify({
				PATH: "/usr/bin:/bin",
				SHELL: "/bin/bash",
				USER: "testuser",
			});
			const env = extractEnvFromOutput(json);
			expect(env.PATH).toBe("/usr/bin:/bin");
			expect(env.SHELL).toBe("/bin/bash");
			expect(env.USER).toBe("testuser");
		});

		it("parses JSON block surrounded by terminal banners and ANSI sequences", () => {
			const output = [
				"\u001b[31;1mWelcome to Arch Linux (x86_64)\u001b[0m",
				"System initialization message",
				'{"PATH":"/custom/bin:/usr/bin","EDITOR":"nvim","NODE_ENV":"production"}',
				"\u001b[32mSession established\u001b[0m",
			].join("\n");

			const env = extractEnvFromOutput(output);
			expect(env.PATH).toBe("/custom/bin:/usr/bin");
			expect(env.EDITOR).toBe("nvim");
			expect(env.NODE_ENV).toBe("production");
		});

		it("parses output enclosed in custom delimiter markers", () => {
			const output = [
				"banner noise line 1",
				"__AERY_SHELL_ENV_START__",
				'{"CUSTOM_KEY":"marker_val","PATH":"/bin"}',
				"__AERY_SHELL_ENV_END__",
				"closing message",
			].join("\n");

			const env = extractEnvFromOutput(output);
			expect(env.CUSTOM_KEY).toBe("marker_val");
			expect(env.PATH).toBe("/bin");
		});

		it("parses KEY=VALUE lines while ignoring terminal noise", () => {
			const output = [
				"\u001b[33mWarning: .profile has invalid syntax\u001b[0m",
				"fastfetch ASCII banner text",
				"VAR_A=apple",
				"VAR_B=banana=split",
				"EMPTY_VAR=",
				"INVALID LINE WITHOUT EQUALS",
				"   ",
				"VAR_C=cherry pie",
			].join("\n");

			const env = extractEnvFromOutput(output);
			expect(env.VAR_A).toBe("apple");
			expect(env.VAR_B).toBe("banana=split");
			expect(env.EMPTY_VAR).toBe("");
			expect(env.VAR_C).toBe("cherry pie");
			expect(env.INVALID_LINE_WITHOUT_EQUALS).toBeUndefined();
		});

		it("returns empty object for empty or unparseable text", () => {
			expect(extractEnvFromOutput("")).toEqual({});
			expect(extractEnvFromOutput("just some random text without variables")).toEqual({});
		});
	});

	describe("getCachedShellEnv and clearShellEnvCache", () => {
		it("returns null when cache is empty", () => {
			expect(getCachedShellEnv()).toBeNull();
		});

		it("clears cached environment when requested", async () => {
			const env = await resolveShellEnv({
				fallbackEnv: { TEST_CACHED_VAR: "true" },
				shell: "/bin/sh",
			});
			expect(env).toBeDefined();
			expect(getCachedShellEnv()).not.toBeNull();
			clearShellEnvCache();
			expect(getCachedShellEnv()).toBeNull();
		});
	});

	describe("resolveShellEnv", () => {
		it("resolves environment from real shell execution", async () => {
			const env = await resolveShellEnv({
				shell: "/bin/bash",
			});
			expect(typeof env).toBe("object");
			expect(env.PATH).toBeDefined();
			expect(getCachedShellEnv()).toEqual(env);
		});

		it("returns cached environment on subsequent calls without forceRefresh", async () => {
			const first = await resolveShellEnv({ shell: "/bin/bash" });
			const second = await resolveShellEnv({ shell: "/bin/bash" });
			expect(first).toEqual(second);
		});

		it("refreshes environment when forceRefresh is set to true", async () => {
			await resolveShellEnv({ shell: "/bin/bash" });
			const refreshed = await resolveShellEnv({
				forceRefresh: true,
				shell: "/bin/bash",
			});
			expect(refreshed.PATH).toBeDefined();
		});

		it("falls back gracefully when shell command fails to spawn", async () => {
			const fallback = { FALLBACK_ACTIVE: "yes" };
			const env = await resolveShellEnv({
				shell: "/path/to/definitely/nonexistent/shell/binary",
				fallbackEnv: fallback,
			});
			expect(env.FALLBACK_ACTIVE).toBe("yes");
		});

		it("falls back gracefully when shell execution times out", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shell-timeout-test-"));
			const hangingScript = path.join(tempDir, "hang.sh");
			await fs.writeFile(hangingScript, "#!/bin/sh\nsleep 5\n", { mode: 0o755 });

			try {
				const fallback = { TIMEOUT_REACHED: "1" };
				const env = await resolveShellEnv({
					shell: hangingScript,
					timeoutMs: 150,
					fallbackEnv: fallback,
				});
				expect(env.TIMEOUT_REACHED).toBe("1");
			} finally {
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		});

		it("falls back to process.env if fallbackEnv is not explicitly provided", async () => {
			const env = await resolveShellEnv({
				shell: "/path/to/nonexistent/shell",
			});
			expect(env.PATH).toBeDefined();
		});

		it("falls back immediately when abort signal triggers", async () => {
			const controller = new AbortController();
			controller.abort();
			const fallback = { ABORT_TEST: "success" };
			const env = await resolveShellEnv({
				signal: controller.signal,
				fallbackEnv: fallback,
			});
			expect(env.ABORT_TEST).toBe("success");
		});
	});
});
