import { spawn } from "node:child_process";
import { AsyncJobManager } from "../../async";
import { resolveAgentInvocation } from "./adapters";
import { findBinaryInPath } from "./discovery";
import type { ExternalAgentExecutionOptions } from "./types";

export interface ExternalAgentExecutionParams {
	agentId: string;
	prompt: string;
	options?: ExternalAgentExecutionOptions;
	signal?: AbortSignal;
}

export interface ExternalAgentExecutionResult {
	agent: string;
	binary: string;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut: boolean;
	error?: string;
	backgroundJob?: {
		jobId: string;
		status: "running";
		message: string;
	};
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export async function executeExternalAgent(
	params: ExternalAgentExecutionParams,
): Promise<ExternalAgentExecutionResult> {
	const { agentId, prompt, options, signal } = params;
	const invocation = resolveAgentInvocation(agentId, prompt, options);

	const resolvedBinaryPath = await findBinaryInPath(invocation.binary);
	if (!resolvedBinaryPath) {
		throw new Error(
			`External agent binary '${invocation.binary}' not found in PATH or not executable. Use call_external_agent with agent: 'list' to see available agents.`,
		);
	}

	const cwd = invocation.cwd ?? process.cwd();
	const timeoutMs = invocation.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	// Background execution path
	if (options?.background) {
		const manager = AsyncJobManager.instance();
		if (manager) {
			const jobId = manager.register(
				"task",
				`external-agent:${agentId}`,
				async ({ signal: jobSignal, onProgress }) => {
					await new Promise<void>((resolve, reject) => {
						const child = spawn(resolvedBinaryPath, invocation.args, {
							cwd,
							env: process.env,
							stdio: ["ignore", "pipe", "pipe"],
						});

						const onAbort = () => child.kill("SIGTERM");
						jobSignal.addEventListener("abort", onAbort, { once: true });

						child.stdout?.on("data", (chunk: Buffer) => {
							const text = chunk.toString();
							if (onProgress) void onProgress(text);
						});

						child.stderr?.on("data", (chunk: Buffer) => {
							const text = chunk.toString();
							if (onProgress) void onProgress(text);
						});

						child.on("close", code => {
							jobSignal.removeEventListener("abort", onAbort);
							if (code === 0) resolve();
							else reject(new Error(`Agent exited with code ${code}`));
						});

						child.on("error", err => {
							jobSignal.removeEventListener("abort", onAbort);
							reject(err);
						});
					});
				},
			);

			return {
				agent: agentId,
				binary: resolvedBinaryPath,
				exitCode: null,
				stdout: "",
				stderr: "",
				durationMs: 0,
				timedOut: false,
				backgroundJob: {
					jobId,
					status: "running",
					message: `Task dispatched to '${agentId}' in the background (job: ${jobId}). Use manage_task or the job tool to check progress.`,
				},
			};
		}
		// Fall through to sync if no AsyncJobManager available
	}

	// Synchronous execution path
	const startTime = Date.now();
	return new Promise<ExternalAgentExecutionResult>(resolve => {
		let timedOut = false;
		let stdout = "";
		let stderr = "";

		const child = spawn(resolvedBinaryPath, invocation.args, {
			cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const timeoutTimer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, timeoutMs);

		const onAbort = () => child.kill("SIGTERM");
		if (signal) {
			if (signal.aborted) {
				clearTimeout(timeoutTimer);
				child.kill("SIGKILL");
				return resolve({
					agent: agentId,
					binary: resolvedBinaryPath,
					exitCode: null,
					stdout: "",
					stderr: "Aborted before start",
					durationMs: 0,
					timedOut: false,
					error: "Aborted before start",
				});
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		child.on("close", code => {
			clearTimeout(timeoutTimer);
			if (signal) signal.removeEventListener("abort", onAbort);
			const durationMs = Date.now() - startTime;
			resolve({
				agent: agentId,
				binary: resolvedBinaryPath,
				exitCode: code,
				stdout: stdout.trim(),
				stderr: stderr.trim(),
				durationMs,
				timedOut,
				error: timedOut ? `Execution timed out after ${timeoutMs}ms` : undefined,
			});
		});

		child.on("error", err => {
			clearTimeout(timeoutTimer);
			if (signal) signal.removeEventListener("abort", onAbort);
			const durationMs = Date.now() - startTime;
			resolve({
				agent: agentId,
				binary: resolvedBinaryPath,
				exitCode: null,
				stdout: stdout.trim(),
				stderr: stderr.trim(),
				durationMs,
				timedOut,
				error: err.message,
			});
		});
	});
}
