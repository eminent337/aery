import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { GrindTool, type GrindToolDetails, parseGrindFailures, sanitizeAnsi, truncateOutput } from "../../src/tools/grind";
import { BUILTIN_TOOLS } from "../../src/tools/index";

const makeSession = (cwd: string) => ({
	cwd,
	hasUI: false as const,
	getSessionFile: () => null,
	getSessionSpawns: () => null,
	settings: {
		get: (_key: string) => undefined,
	} as any,
});

describe("GrindTool", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grind-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("has the correct tool metadata and registration", () => {
		const tool = new GrindTool(makeSession(tmpDir) as any);
		expect(tool.name).toBe("grind");
		expect(tool.approval).toBe("exec");
		expect(tool.loadMode).toBe("discoverable");
		expect(typeof BUILTIN_TOOLS.grind).toBe("function");
		const fromBuiltin = BUILTIN_TOOLS.grind(makeSession(tmpDir) as any);
		expect(fromBuiltin.name).toBe("grind");
	});

	it("executes a passing command cleanly", async () => {
		const tool = new GrindTool(makeSession(tmpDir) as any);
		const result = await tool.execute("call-1", {
			command: "echo 'all 5 tests passed'",
		});

		const details = result.details as GrindToolDetails;
		expect(details).toBeDefined();
		expect(details.passed).toBe(true);
		expect(details.exitCode).toBe(0);
		expect(details.failures).toEqual([]);
		expect(details.errorSummary).toBeUndefined();
		expect(details.output).toContain("all 5 tests passed");
		expect(details.durationMs).toBeGreaterThanOrEqual(0);

		const textContent = result.content[0];
		expect(textContent.type).toBe("text");
		if (textContent.type === "text") {
			expect(textContent.text).toContain("Command passed cleanly (exit 0)");
		}
	});

	it("executes a failing command and parses failures and errorSummary", async () => {
		const tool = new GrindTool(makeSession(tmpDir) as any);
		const result = await tool.execute("call-2", {
			command: 'sh -c \'echo "FAIL src/foo.test.ts:42 expected true got false" && exit 1\'',
		});

		const details = result.details as GrindToolDetails;
		expect(details).toBeDefined();
		expect(details.passed).toBe(false);
		expect(details.exitCode).toBe(1);
		expect(details.errorSummary).toBeDefined();
		expect(details.errorSummary).toContain("FAIL src/foo.test.ts:42 expected true got false");

		expect(details.failures).toBeDefined();
		expect(details.failures!.length).toBeGreaterThan(0);
		const failure = details.failures![0];
		expect(failure.file).toBe("src/foo.test.ts");
		expect(failure.line).toBe(42);
		expect(failure.message).toContain("expected true got false");

		expect(result.isError).toBe(true);
	});

	it("enforces timeout protection and terminates long-running processes", async () => {
		const tool = new GrindTool(makeSession(tmpDir) as any);
		const start = Date.now();
		const result = await tool.execute("call-3", {
			command: "sleep 10",
			timeoutMs: 500,
		});
		const duration = Date.now() - start;

		expect(duration).toBeLessThan(3000);

		const details = result.details as GrindToolDetails;
		expect(details).toBeDefined();
		expect(details.passed).toBe(false);
		expect(details.errorSummary).toBeDefined();
		expect(details.errorSummary?.toLowerCase()).toContain("timed out");
		expect(result.isError).toBe(true);
	});

	it("truncates output when exceeding maxOutputChars", async () => {
		const tool = new GrindTool(makeSession(tmpDir) as any);
		const result = await tool.execute("call-4", {
			command: "node -e 'console.log(\"X\".repeat(2000))'",
			maxOutputChars: 500,
		});

		const details = result.details as GrindToolDetails;
		expect(details).toBeDefined();
		expect(details.passed).toBe(true);
		expect(details.output).toContain("[truncated ");
		expect(details.output).toContain("characters]");
		expect(details.output.length).toBeLessThan(1000);
	});

	it("strips ANSI escape codes from output", async () => {
		const tool = new GrindTool(makeSession(tmpDir) as any);
		const result = await tool.execute("call-5", {
			command: 'sh -c \'printf "\\033[31mFAIL\\033[0m src/test.ts:10 error\\n" && exit 1\'',
		});

		const details = result.details as GrindToolDetails;
		expect(details.output).not.toContain("\x1b[31m");
		expect(details.output).toContain("FAIL src/test.ts:10 error");
		expect(details.failures?.[0].file).toBe("src/test.ts");
		expect(details.failures?.[0].line).toBe(10);
	});

	it("executes command with custom working directory cwd", async () => {
		const subDir = path.join(tmpDir, "sub");
		await fs.mkdir(subDir, { recursive: true });
		await fs.writeFile(path.join(subDir, "marker.txt"), "found");

		const tool = new GrindTool(makeSession(tmpDir) as any);
		const result = await tool.execute("call-6", {
			command: "cat marker.txt",
			cwd: subDir,
		});

		const details = result.details as GrindToolDetails;
		expect(details.passed).toBe(true);
		expect(details.output).toContain("found");
	});

	it("cancels execution when signal is aborted", async () => {
		const controller = new AbortController();
		const tool = new GrindTool(makeSession(tmpDir) as any);

		setTimeout(() => controller.abort(), 100);

		const result = await tool.execute(
			"call-7",
			{ command: "sleep 10" },
			controller.signal,
		);

		const details = result.details as GrindToolDetails;
		expect(details.passed).toBe(false);
		expect(details.errorSummary).toContain("aborted");
	});
});

describe("Grind utilities", () => {
	it("sanitizeAnsi removes complex ANSI color and cursor codes", () => {
		const input = "\u001b[32mPASS\u001b[39m \u001b[1mbold\u001b[22m";
		expect(sanitizeAnsi(input)).toBe("PASS bold");
	});

	it("truncateOutput preserves short text and elides long text", () => {
		expect(truncateOutput("hello", 10)).toBe("hello");
		const long = "a".repeat(100);
		const truncated = truncateOutput(long, 40);
		expect(truncated).toContain("[truncated 60 characters]");
		expect(truncated.startsWith("a".repeat(40))).toBe(true);
	});

	it("parseGrindFailures handles TypeScript compiler parenthesized errors", () => {
		const output = "src/index.ts(15,3): error TS2304: Cannot find name 'foo'.";
		const failures = parseGrindFailures(output);
		expect(failures.length).toBe(1);
		expect(failures[0].file).toBe("src/index.ts");
		expect(failures[0].line).toBe(15);
		expect(failures[0].message).toContain("Cannot find name 'foo'");
	});

	it("parseGrindFailures handles pytest failure lines", () => {
		const output = "FAILED tests/test_math.py::test_division - ZeroDivisionError: division by zero";
		const failures = parseGrindFailures(output);
		expect(failures.length).toBe(1);
		expect(failures[0].file).toBe("tests/test_math.py");
		expect(failures[0].message).toContain("ZeroDivisionError: division by zero");
	});

	it("parseGrindFailures handles stack trace lines", () => {
		const output = "    at Object.<anonymous> (/home/aryee/app/test/app.test.ts:99:12)";
		const failures = parseGrindFailures(output);
		expect(failures.length).toBe(1);
		expect(failures[0].file).toBe("/home/aryee/app/test/app.test.ts");
		expect(failures[0].line).toBe(99);
	});
});
