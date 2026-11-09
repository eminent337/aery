import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	OPENCODE_STANDARD_PATHS,
	OPENCODE_FREE_MODELS,
	isExecutableFile,
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
		it("includes standard search locations dynamically derived from home", () => {
			expect(OPENCODE_STANDARD_PATHS).toContain("/usr/local/bin/opencode");
			expect(OPENCODE_STANDARD_PATHS).toContain("/usr/bin/opencode");
			const expectedHomeNpm = path.join(
				process.env.HOME || os.homedir(),
				".npm-global",
				"bin",
				"opencode"
			);
			expect(OPENCODE_STANDARD_PATHS).toContain(expectedHomeNpm);
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

	describe("isExecutableFile", () => {
		it("returns true for a real executable regular file", () => {
			expect(isExecutableFile(process.execPath)).toBe(true);
		});

		it("returns false for a directory", () => {
			expect(isExecutableFile(os.tmpdir())).toBe(false);
		});

		it("returns false for a nonexistent file", () => {
			expect(isExecutableFile("/nonexistent/file/path")).toBe(false);
		});
	});

	describe("resolveOpencodeBinary", () => {
		it("returns customPath when provided and executable", () => {
			const statSpy = spyOn(fs, "statSync").mockImplementation(((p: string) => {
				if (p === "/custom/bin/opencode") {
					return { isFile: () => true } as any;
				}
				throw new Error("ENOENT");
			}) as any);
			const accessSpy = spyOn(fs, "accessSync").mockImplementation(((p: string) => {
				if (p === "/custom/bin/opencode") return;
				throw new Error("EACCES");
			}) as any);

			const result = resolveOpencodeBinary("/custom/bin/opencode");
			expect(result).toBe("/custom/bin/opencode");
			statSpy.mockRestore();
			accessSpy.mockRestore();
		});

		it("returns null when customPath does not exist or is not executable", () => {
			const statSpy = spyOn(fs, "statSync").mockImplementation(() => {
				throw new Error("ENOENT");
			});

			const result = resolveOpencodeBinary("/nonexistent/bin/opencode");
			expect(result).toBeNull();
			statSpy.mockRestore();
		});

		it("prefers OPENCODE_BIN env override if it exists and is executable", () => {
			process.env.OPENCODE_BIN = "/override/bin/opencode";
			const statSpy = spyOn(fs, "statSync").mockImplementation(((p: string) => {
				if (p === "/override/bin/opencode") {
					return { isFile: () => true } as any;
				}
				throw new Error("ENOENT");
			}) as any);
			const accessSpy = spyOn(fs, "accessSync").mockImplementation(((p: string) => {
				if (p === "/override/bin/opencode") return;
				throw new Error("EACCES");
			}) as any);

			const result = resolveOpencodeBinary();
			expect(result).toBe("/override/bin/opencode");
			statSpy.mockRestore();
			accessSpy.mockRestore();
		});

		it("checks PATH directories with trimmed and unquoted entries", () => {
			delete process.env.OPENCODE_BIN;
			process.env.PATH = `  "/custom/tools"  : '/opt/other' `;

			const statSpy = spyOn(fs, "statSync").mockImplementation(((p: string) => {
				if (p === "/custom/tools/opencode") {
					return { isFile: () => true } as any;
				}
				throw new Error("ENOENT");
			}) as any);
			const accessSpy = spyOn(fs, "accessSync").mockImplementation(((p: string) => {
				if (p === "/custom/tools/opencode") return;
				throw new Error("EACCES");
			}) as any);

			const result = resolveOpencodeBinary();
			expect(result).toBe("/custom/tools/opencode");
			statSpy.mockRestore();
			accessSpy.mockRestore();
		});

		it("returns null when binary cannot be found anywhere", () => {
			delete process.env.OPENCODE_BIN;
			const statSpy = spyOn(fs, "statSync").mockImplementation(() => {
				throw new Error("ENOENT");
			});

			const result = resolveOpencodeBinary();
			expect(result).toBeNull();
			statSpy.mockRestore();
		});
	});

	describe("getOpencodeEnvironment", () => {
		it("sets OPENCODE_DISABLE_UPDATE_CHECK to 1", () => {
			const env = getOpencodeEnvironment({ EXISTING_VAR: "true" });
			expect(env.OPENCODE_DISABLE_UPDATE_CHECK).toBe("1");
			expect(env.EXISTING_VAR).toBe("true");
		});

		it("falls back to user-scoped XDG_DATA_HOME when directory is not writable", () => {
			const env = getOpencodeEnvironment({
				USER: "testuser",
				HOME: "/proc/nonexistent-or-readonly-dir",
				XDG_DATA_HOME: "/proc/nonexistent-or-readonly-dir",
			});
			const expectedFallback = path.join(os.tmpdir(), "aery-opencode-data-testuser");
			expect(env.XDG_DATA_HOME).toBe(expectedFallback);
		});

		it("preserves safe XDG_DATA_HOME when directory is writable and cleans up test file", () => {
			const tmpDir = path.join(os.tmpdir(), `aery-test-${Date.now()}`);
			fs.mkdirSync(tmpDir, { recursive: true });
			try {
				const env = getOpencodeEnvironment({
					XDG_DATA_HOME: tmpDir,
				});
				expect(env.XDG_DATA_HOME).toBe(tmpDir);
				// Verify no leftover .test-write files
				const remaining = fs.readdirSync(tmpDir).filter((f) => f.startsWith(".test-write-"));
				expect(remaining.length).toBe(0);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});

	describe("createOpencodeAcpClient", () => {
		it("instantiates AcpClient with opencode binary and acp args", () => {
			const statSpy = spyOn(fs, "statSync").mockImplementation(((p: string) => {
				if (p === "/mock/opencode") {
					return { isFile: () => true } as any;
				}
				throw new Error("ENOENT");
			}) as any);
			const accessSpy = spyOn(fs, "accessSync").mockImplementation(((p: string) => {
				if (p === "/mock/opencode") return;
				throw new Error("EACCES");
			}) as any);

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

			statSpy.mockRestore();
			accessSpy.mockRestore();
		});

		it("throws an informative error if opencode binary cannot be found", () => {
			delete process.env.OPENCODE_BIN;
			const statSpy = spyOn(fs, "statSync").mockImplementation(() => {
				throw new Error("ENOENT");
			});

			expect(() => {
				createOpencodeAcpClient({ binaryPath: "/nonexistent/opencode" });
			}).toThrow(/OpenCode binary not found/);

			statSpy.mockRestore();
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
