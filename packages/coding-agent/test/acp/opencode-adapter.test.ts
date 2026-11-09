import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	OPENCODE_STANDARD_PATHS,
	OPENCODE_FREE_MODELS,
	resolveOpencodeBinary,
	getOpencodeEnvironment,
	createOpencodeAcpClient,
} from "../../src/acp/adapters/opencode";
import {
	AcpClient,
	AcpTransport,
	resolveOpencodeBinary as indexResolve,
	createOpencodeAcpClient as indexCreate,
} from "../../src/acp/index";

describe("OpenCode ACP Adapter", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	describe("OPENCODE_STANDARD_PATHS", () => {
		it("includes standard search locations", () => {
			expect(OPENCODE_STANDARD_PATHS).toContain("/home/aryee/.npm-global/bin/opencode");
			expect(OPENCODE_STANDARD_PATHS).toContain("/usr/local/bin/opencode");
			expect(OPENCODE_STANDARD_PATHS).toContain("/usr/bin/opencode");
			if (process.env.HOME) {
				const homeExpected = path.join(process.env.HOME, ".npm-global", "bin", "opencode");
				expect(OPENCODE_STANDARD_PATHS).toContain(homeExpected);
			}
		});
	});

	describe("OPENCODE_FREE_MODELS", () => {
		it("contains verified free models provided by OpenCode", () => {
			expect(OPENCODE_FREE_MODELS).toContain("qwen3.6-plus-free");
			expect(OPENCODE_FREE_MODELS).toContain("minimax-m2.5-free");
			expect(OPENCODE_FREE_MODELS).toContain("glm-5-free");
			expect(OPENCODE_FREE_MODELS).toContain("trinity-large-preview-free");
			expect(OPENCODE_FREE_MODELS).toContain("deepseek-chat");
		});
	});

	describe("resolveOpencodeBinary", () => {
		it("returns customPath when provided and exists", () => {
			const existsSpy = spyOn(fs, "existsSync").mockImplementation((p) => {
				return p === "/custom/bin/opencode";
			});

			const result = resolveOpencodeBinary("/custom/bin/opencode");
			expect(result).toBe("/custom/bin/opencode");
			existsSpy.mockRestore();
		});

		it("returns null when customPath does not exist", () => {
			const existsSpy = spyOn(fs, "existsSync").mockReturnValue(false);

			const result = resolveOpencodeBinary("/nonexistent/bin/opencode");
			expect(result).toBeNull();
			existsSpy.mockRestore();
		});

		it("prefers OPENCODE_BIN env override if it exists", () => {
			process.env.OPENCODE_BIN = "/override/bin/opencode";
			const existsSpy = spyOn(fs, "existsSync").mockImplementation((p) => {
				return p === "/override/bin/opencode";
			});

			const result = resolveOpencodeBinary();
			expect(result).toBe("/override/bin/opencode");
			existsSpy.mockRestore();
		});

		it("falls back to standard paths when OPENCODE_BIN is not set", () => {
			delete process.env.OPENCODE_BIN;
			const existsSpy = spyOn(fs, "existsSync").mockImplementation((p) => {
				return p === "/home/aryee/.npm-global/bin/opencode";
			});

			const result = resolveOpencodeBinary();
			expect(result).toBe("/home/aryee/.npm-global/bin/opencode");
			existsSpy.mockRestore();
		});

		it("checks PATH directories when standard paths do not exist", () => {
			delete process.env.OPENCODE_BIN;
			process.env.PATH = "/opt/bin:/custom/tools";

			const existsSpy = spyOn(fs, "existsSync").mockImplementation((p) => {
				return p === "/custom/tools/opencode";
			});

			const result = resolveOpencodeBinary();
			expect(result).toBe("/custom/tools/opencode");
			existsSpy.mockRestore();
		});

		it("returns null when binary cannot be found anywhere", () => {
			delete process.env.OPENCODE_BIN;
			const existsSpy = spyOn(fs, "existsSync").mockReturnValue(false);

			const result = resolveOpencodeBinary();
			expect(result).toBeNull();
			existsSpy.mockRestore();
		});
	});

	describe("getOpencodeEnvironment", () => {
		it("sets OPENCODE_DISABLE_UPDATE_CHECK to 1", () => {
			const env = getOpencodeEnvironment({ EXISTING_VAR: "true" });
			expect(env.OPENCODE_DISABLE_UPDATE_CHECK).toBe("1");
			expect(env.EXISTING_VAR).toBe("true");
		});

		it("falls back to safe XDG_DATA_HOME when directory is not writable", () => {
			const env = getOpencodeEnvironment({
				HOME: "/proc/nonexistent-or-readonly-dir",
				XDG_DATA_HOME: "/proc/nonexistent-or-readonly-dir",
			});
			expect(env.XDG_DATA_HOME).toBe("/tmp/aery-opencode-data");
		});

		it("preserves safe XDG_DATA_HOME when directory is writable", () => {
			const tmpDir = path.join(os.tmpdir(), `aery-test-${Date.now()}`);
			fs.mkdirSync(tmpDir, { recursive: true });
			try {
				const env = getOpencodeEnvironment({
					XDG_DATA_HOME: tmpDir,
				});
				expect(env.XDG_DATA_HOME).toBe(tmpDir);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});

	describe("createOpencodeAcpClient", () => {
		it("instantiates AcpClient with opencode binary and acp args", () => {
			const existsSpy = spyOn(fs, "existsSync").mockImplementation((p) => {
				return p === "/mock/opencode";
			});

			const client = createOpencodeAcpClient({
				binaryPath: "/mock/opencode",
				cwd: "/workspace/test",
				timeoutMs: 15000,
			});

			expect(client).toBeInstanceOf(AcpClient);
			const opts = (client as any).options;
			expect(opts.command).toBe("/mock/opencode");
			expect(opts.args).toEqual(["acp"]);
			expect(opts.cwd).toBe("/workspace/test");
			expect(opts.timeoutMs).toBe(15000);
			expect(opts.env?.OPENCODE_DISABLE_UPDATE_CHECK).toBe("1");

			existsSpy.mockRestore();
		});

		it("throws an informative error if opencode binary cannot be found", () => {
			delete process.env.OPENCODE_BIN;
			const existsSpy = spyOn(fs, "existsSync").mockReturnValue(false);

			expect(() => {
				createOpencodeAcpClient({ binaryPath: "/nonexistent/opencode" });
			}).toThrow(/OpenCode binary not found/);

			existsSpy.mockRestore();
		});
	});

	describe("Module exports from acp/index", () => {
		it("re-exports all expected types and functions", () => {
			expect(typeof AcpClient).toBe("function");
			expect(typeof AcpTransport).toBe("function");
			expect(typeof indexResolve).toBe("function");
			expect(typeof indexCreate).toBe("function");
		});
	});
});
