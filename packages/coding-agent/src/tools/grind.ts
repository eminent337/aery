import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@aryee337/aery-core";
import * as z from "zod/v4";
import type { ToolSession } from "./index";
import type { OutputMeta } from "./output-meta";
import { toolResult } from "./tool-result";

const ANSI_REGEX =
	/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]|\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export function sanitizeAnsi(text: string): string {
	return stripVTControlCharacters(text).replace(ANSI_REGEX, "");
}

export function truncateOutput(output: string, maxOutputChars: number): string {
	if (output.length <= maxOutputChars) {
		return output;
	}
	const truncatedCount = output.length - maxOutputChars;
	return `${output.slice(0, maxOutputChars)}\n... [truncated ${truncatedCount} characters] ...\n`;
}

export interface GrindFailure {
	file?: string;
	line?: number;
	message: string;
}

export interface GrindToolDetails {
	command: string;
	passed: boolean;
	exitCode: number;
	output: string;
	errorSummary?: string;
	failures?: GrindFailure[];
	durationMs: number;
	meta?: OutputMeta;
}

export const grindSchema = z.object({
	command: z.string().describe("Verification or test command to run (e.g., 'bun test', 'npm test', 'cargo test', 'pytest')"),
	timeoutMs: z.number().optional().describe("Execution timeout in milliseconds (1000 to 120000). Default: 30000."),
	maxOutputChars: z.number().optional().describe("Maximum output characters to retain. Default: 8000."),
	cwd: z.string().optional().describe("Working directory for command execution. Defaults to session cwd."),
});

export type GrindParams = z.infer<typeof grindSchema>;

export function parseGrindFailures(output: string): GrindFailure[] {
	const failures: GrindFailure[] = [];
	const seen = new Set<string>();

	const lines = output.split("\n");

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) continue;

		// Pattern 1: FAIL/FAILED/error [file]:[line](:[col])? (message)?
		const matchFileColonLine = line.match(
			/^(?:(?:FAIL|FAILED|error|Error|✖|✗)\s+)?([a-zA-Z0-9_\-\.\/\\~]+?\.[a-zA-Z0-9]+):(\d+)(?::\d+)?(?:\s*[-:]\s*(.*)|\s+(.*))?$/,
		);
		if (matchFileColonLine) {
			const file = matchFileColonLine[1];
			const lineNum = parseInt(matchFileColonLine[2], 10);
			const rawMsg = (matchFileColonLine[3] || matchFileColonLine[4] || "").trim();
			const message = rawMsg || line;
			const key = `${file}:${lineNum}:${message}`;
			if (!seen.has(key)) {
				seen.add(key);
				failures.push({ file, line: lineNum, message });
			}
			continue;
		}

		// Pattern 2: TypeScript paren format: "src/foo.ts(42,15): error TS2322: ..."
		const matchParen = line.match(
			/^([a-zA-Z0-9_\-\.\/\\~]+?\.[a-zA-Z0-9]+)\((\d+)(?:,\d+)?\):\s*(.*)$/,
		);
		if (matchParen) {
			const file = matchParen[1];
			const lineNum = parseInt(matchParen[2], 10);
			const message = matchParen[3].trim() || line;
			const key = `${file}:${lineNum}:${message}`;
			if (!seen.has(key)) {
				seen.add(key);
				failures.push({ file, line: lineNum, message });
			}
			continue;
		}

		// Pattern 3: Pytest: "FAILED tests/test_calc.py::test_add - AssertionError: ..."
		const matchPytest = line.match(
			/^FAILED\s+([a-zA-Z0-9_\-\.\/\\~]+?\.[a-zA-Z0-9]+)::([^\s]+)\s*[-:]\s*(.*)$/,
		);
		if (matchPytest) {
			const file = matchPytest[1];
			const message = `${matchPytest[2]}: ${matchPytest[3]}`.trim();
			const key = `${file}:0:${message}`;
			if (!seen.has(key)) {
				seen.add(key);
				failures.push({ file, message });
			}
			continue;
		}

		// Pattern 4: Stack trace line: "at foo (/path/to/file.ts:42:15)" or "at /path/to/file.ts:42:15"
		const matchStack = line.match(
			/^\s*at\s+(?:.*?\()?(?:file:\/\/)?([a-zA-Z0-9_\-\.\/\\~]+?\.[a-zA-Z0-9]+):(\d+)(?::\d+)?\)?$/,
		);
		if (matchStack) {
			const file = matchStack[1];
			const lineNum = parseInt(matchStack[2], 10);
			const message = line;
			const key = `${file}:${lineNum}:${message}`;
			if (!seen.has(key)) {
				seen.add(key);
				failures.push({ file, line: lineNum, message });
			}
			continue;
		}

		// Pattern 5: Python traceback: "File "/path/to/file.py", line 42, in test_something"
		const matchPyTrace = line.match(
			/^File "([^"]+\.[a-zA-Z0-9]+)", line (\d+)(?:, in (.*))?$/,
		);
		if (matchPyTrace) {
			const file = matchPyTrace[1];
			const lineNum = parseInt(matchPyTrace[2], 10);
			const message = matchPyTrace[3] ? `in ${matchPyTrace[3]}` : line;
			const key = `${file}:${lineNum}:${message}`;
			if (!seen.has(key)) {
				seen.add(key);
				failures.push({ file, line: lineNum, message });
			}
			continue;
		}
	}

	return failures;
}

export function extractErrorSummary(output: string, failures: GrindFailure[], exitCode: number): string {
	const trimmed = output.trim();
	if (!trimmed) {
		return `Command failed with exit code ${exitCode}`;
	}

	// 1. Check for standard test runner summary lines (e.g. "1 fail, 3 pass", "1 failed, 2 passed")
	const summaryRegexes = [
		/(?:tests?:?\s*)?(\d+\s+failed|\d+\s+fail)(?:,\s*(\d+\s+passed|\d+\s+pass))?/i,
		/(\d+\s+passed|\d+\s+pass),\s*(\d+\s+failed|\d+\s+fail)/i,
		/test result: FAILED[^\n]*/i,
		/=+ (?:FAILURES|ERRORS) =+/i,
	];

	for (const regex of summaryRegexes) {
		const match = trimmed.match(regex);
		if (match) {
			return match[0].trim();
		}
	}

	// 2. Check for explicit error lines in output
	const lines = trimmed.split("\n").map(l => l.trim()).filter(Boolean);
	const errorLine = lines.find(l => /^(FAIL|FAILED|Error:|error:|AssertionError:|panic:|FATAL:)/i.test(l));
	if (errorLine) {
		return errorLine;
	}

	// 3. Fallback to first failure message if available
	if (failures.length > 0 && failures[0].message) {
		return failures[0].message;
	}

	// 4. Fallback to last line of output or exit code
	return lines[lines.length - 1] ?? `Command failed with exit code ${exitCode}`;
}

export class GrindTool implements AgentTool<typeof grindSchema, GrindToolDetails> {
	readonly name = "grind";
	readonly approval = "exec" as const;
	readonly label = "Grind";
	readonly description =
		"Execute a verification or test command, parse errors/stack traces, and return a structured summary of passing or failing assertions.";
	readonly parameters = grindSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Autonomous verification loop tool to run tests and extract structured failures";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): GrindTool {
		return new GrindTool(session);
	}

	async execute(
		_toolCallId: string,
		params: GrindParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<GrindToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GrindToolDetails>> {
		const command = params.command.trim();
		const timeoutMs = params.timeoutMs ?? 30000;
		const maxOutputChars = params.maxOutputChars ?? 8000;
		const workingDir = params.cwd || this.session.cwd || process.cwd();

		if (signal?.aborted) {
			const details: GrindToolDetails = {
				command,
				passed: false,
				exitCode: -1,
				output: "Command aborted before execution started.",
				errorSummary: "Command aborted before execution started.",
				failures: [{ message: "Command aborted before execution started." }],
				durationMs: 0,
			};
			return toolResult(details)
				.text("Command aborted before execution started.")
				.error()
				.done();
		}

		const startTime = Date.now();

		return new Promise<AgentToolResult<GrindToolDetails>>(resolve => {
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			let aborted = false;
			let settled = false;

			const child = spawn("sh", ["-c", command], {
				cwd: workingDir,
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});

			const killChildTree = () => {
				if (child.pid && process.platform !== "win32") {
					try {
						process.kill(-child.pid, "SIGKILL");
						return;
					} catch {
						// Fall through to regular kill
					}
				}
				try {
					child.kill("SIGKILL");
				} catch {
					// Ignored: process already exited
				}
			};

			let timer: ReturnType<typeof setTimeout> | undefined;
			if (timeoutMs > 0) {
				timer = setTimeout(() => {
					timedOut = true;
					killChildTree();
				}, timeoutMs);
			}

			const onAbort = () => {
				aborted = true;
				killChildTree();
			};

			if (signal) {
				signal.addEventListener("abort", onAbort, { once: true });
			}

			child.stdout?.on("data", chunk => {
				stdout += chunk.toString();
			});

			child.stderr?.on("data", chunk => {
				stderr += chunk.toString();
			});

			child.on("error", err => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				if (signal) signal.removeEventListener("abort", onAbort);

				const durationMs = Date.now() - startTime;
				const errMsg = err.message || String(err);
				const details: GrindToolDetails = {
					command,
					passed: false,
					exitCode: -1,
					output: errMsg,
					errorSummary: errMsg,
					failures: [{ message: errMsg }],
					durationMs,
				};
				resolve(
					toolResult(details)
						.text(`Command failed with process error in ${durationMs}ms: ${errMsg}`)
						.error()
						.done(),
				);
			});

			child.on("close", (code, killSignal) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				if (signal) signal.removeEventListener("abort", onAbort);

				const durationMs = Date.now() - startTime;
				const rawOutput = (stdout + (stderr ? (stdout ? "\n" + stderr : stderr) : "")).trim();
				const sanitized = sanitizeAnsi(rawOutput);

				if (timedOut) {
					const timeoutMsg = `Command timed out after ${timeoutMs}ms`;
					const fullOutput = sanitized ? `${sanitized}\n${timeoutMsg}` : timeoutMsg;
					const truncated = truncateOutput(fullOutput, maxOutputChars);
					const details: GrindToolDetails = {
						command,
						passed: false,
						exitCode: -1,
						output: truncated,
						errorSummary: timeoutMsg,
						failures: [{ message: timeoutMsg }],
						durationMs,
					};
					return resolve(
						toolResult(details)
							.text(`Command timed out in ${durationMs}ms: ${timeoutMsg}\n\nOutput:\n${truncated}`)
							.error()
							.done(),
					);
				}

				if (aborted) {
					const abortMsg = "Command aborted by signal";
					const fullOutput = sanitized ? `${sanitized}\n${abortMsg}` : abortMsg;
					const truncated = truncateOutput(fullOutput, maxOutputChars);
					const details: GrindToolDetails = {
						command,
						passed: false,
						exitCode: -1,
						output: truncated,
						errorSummary: abortMsg,
						failures: [{ message: abortMsg }],
						durationMs,
					};
					return resolve(
						toolResult(details)
							.text(`Command aborted in ${durationMs}ms.\n\nOutput:\n${truncated}`)
							.error()
							.done(),
					);
				}

				if (code === null && killSignal) {
					const signalMsg = `Command terminated by signal ${killSignal}`;
					const fullOutput = sanitized ? `${sanitized}\n${signalMsg}` : signalMsg;
					const truncated = truncateOutput(fullOutput, maxOutputChars);
					const details: GrindToolDetails = {
						command,
						passed: false,
						exitCode: -1,
						output: truncated,
						errorSummary: signalMsg,
						failures: [{ message: signalMsg }],
						durationMs,
					};
					return resolve(
						toolResult(details)
							.text(`Command terminated by signal ${killSignal} in ${durationMs}ms.\n\nOutput:\n${truncated}`)
							.error()
							.done(),
					);
				}

				const exitCode = code ?? (sanitized.length > 0 ? 0 : 0);
				const passed = exitCode === 0;

				if (passed) {
					const truncated = truncateOutput(sanitized, maxOutputChars);
					const details: GrindToolDetails = {
						command,
						passed: true,
						exitCode: 0,
						output: truncated,
						errorSummary: undefined,
						failures: [],
						durationMs,
					};
					const text = truncated.trim()
						? `Command passed cleanly (exit 0) in ${durationMs}ms.\n\n${truncated}`
						: `Command passed cleanly (exit 0) in ${durationMs}ms.`;
					return resolve(toolResult(details).text(text).done());
				}

				const failures = parseGrindFailures(sanitized);
				const errorSummary = extractErrorSummary(sanitized, failures, exitCode);
				if (failures.length === 0) {
					failures.push({ message: errorSummary });
				}

				const truncated = truncateOutput(sanitized, maxOutputChars);
				const details: GrindToolDetails = {
					command,
					passed: false,
					exitCode,
					output: truncated,
					errorSummary,
					failures,
					durationMs,
				};

				const failuresText = failures.map(f => {
					const loc = f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : "";
					return loc ? `- [${loc}] ${f.message}` : `- ${f.message}`;
				}).join("\n");

				const text = `Command failed (exit ${exitCode}) in ${durationMs}ms: ${errorSummary}\n\nFailures (${failures.length}):\n${failuresText}\n\nOutput:\n${truncated}`;

				return resolve(toolResult(details).text(text).error().done());
			});
		});
	}
}
