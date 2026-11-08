import { type ChildProcess, spawn } from "node:child_process";

export interface ShellEnvResolverOptions {
	shell?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	forceRefresh?: boolean;
	fallbackEnv?: Record<string, string>;
}

export const SHELL_ENV_START_MARKER = "__AERY_SHELL_ENV_START__";
export const SHELL_ENV_END_MARKER = "__AERY_SHELL_ENV_END__";

const DEFAULT_TIMEOUT_MS = 5000;

const ANSI_REGEX =
	/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]|\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_REGEX, "");
}

export function extractEnvFromOutput(rawOutput: string): Record<string, string> {
	if (!rawOutput) {
		return {};
	}

	let target = rawOutput;
	const startIdx = rawOutput.indexOf(SHELL_ENV_START_MARKER);
	if (startIdx !== -1) {
		const afterStart = startIdx + SHELL_ENV_START_MARKER.length;
		const endIdx = rawOutput.indexOf(SHELL_ENV_END_MARKER, afterStart);
		if (endIdx !== -1) {
			target = rawOutput.slice(afterStart, endIdx);
		} else {
			target = rawOutput.slice(afterStart);
		}
	}

	const cleaned = stripAnsi(target).trim();
	if (!cleaned) {
		return {};
	}

	const firstBrace = cleaned.indexOf("{");
	const lastBrace = cleaned.lastIndexOf("}");
	if (firstBrace !== -1 && lastBrace > firstBrace) {
		const jsonCandidate = cleaned.slice(firstBrace, lastBrace + 1);
		try {
			const parsed = JSON.parse(jsonCandidate);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				const result: Record<string, string> = {};
				for (const [key, value] of Object.entries(parsed)) {
					if (typeof value === "string") {
						result[key] = value;
					} else if (value !== null && value !== undefined) {
						result[key] = String(value);
					}
				}
				return result;
			}
		} catch {
			// Fall back to line by line parsing
		}
	}

	const result: Record<string, string> = {};
	const lines = cleaned.split(/\r?\n/);
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}
		const eqIndex = line.indexOf("=");
		if (eqIndex <= 0) {
			continue;
		}
		const key = line.slice(0, eqIndex).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			continue;
		}
		const value = line.slice(eqIndex + 1);
		result[key] = value;
	}

	return result;
}

let cachedEnv: Record<string, string> | null = null;
let pendingResolution: Promise<Record<string, string>> | null = null;

export function getCachedShellEnv(): Record<string, string> | null {
	return cachedEnv ? { ...cachedEnv } : null;
}

export function clearShellEnvCache(): void {
	cachedEnv = null;
	pendingResolution = null;
}

function killChild(child: ChildProcess): void {
	if (child.pid && process.platform !== "win32") {
		try {
			process.kill(-child.pid, "SIGKILL");
			return;
		} catch {
			// Fall through to regular child kill
		}
	}
	try {
		child.kill("SIGKILL");
	} catch {}
}

function resolveFallback(options?: ShellEnvResolverOptions): Record<string, string> {
	if (options?.fallbackEnv) {
		return { ...options.fallbackEnv };
	}
	const fallback: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") {
			fallback[key] = value;
		}
	}
	return fallback;
}

async function executeShellEnvResolution(options?: ShellEnvResolverOptions): Promise<Record<string, string>> {
	const shell = options?.shell || process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/bash");

	const probeCommand = [
		`echo "${SHELL_ENV_START_MARKER}"`,
		'node -e "console.log(JSON.stringify(process.env))" 2>/dev/null || env',
		`echo "${SHELL_ENV_END_MARKER}"`,
	].join("; ");

	const isWindows = process.platform === "win32";
	const isCmd = isWindows && (shell.endsWith("cmd.exe") || shell.endsWith("cmd"));
	const args = isCmd ? ["/c", probeCommand] : ["-l", "-i", "-c", probeCommand];

	return new Promise<Record<string, string>>(resolve => {
		let settled = false;
		let timer: NodeJS.Timeout | null = null;
		let child: ChildProcess | null = null;
		let stdoutBuffer = "";

		const finish = (env: Record<string, string>, shouldCache: boolean) => {
			if (settled) {
				return;
			}
			settled = true;

			if (timer) {
				clearTimeout(timer);
				timer = null;
			}

			if (options?.signal) {
				options.signal.removeEventListener("abort", onAbort);
			}

			if (shouldCache) {
				cachedEnv = { ...env };
			}

			resolve(env);
		};

		const onAbort = () => {
			if (child && !child.killed) {
				killChild(child);
			}
			finish(resolveFallback(options), false);
		};

		if (options?.signal) {
			if (options.signal.aborted) {
				finish(resolveFallback(options), false);
				return;
			}
			options.signal.addEventListener("abort", onAbort, { once: true });
		}

		const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		if (timeoutMs > 0) {
			timer = setTimeout(() => {
				if (child && !child.killed) {
					killChild(child);
				}
				finish(resolveFallback(options), false);
			}, timeoutMs);
		}

		try {
			child = spawn(shell, args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					TERM: "dumb",
				},
				detached: !isWindows,
			});
		} catch {
			finish(resolveFallback(options), false);
			return;
		}

		child.on("error", () => {
			finish(resolveFallback(options), false);
		});

		if (child.stderr) {
			child.stderr.resume();
		}

		if (child.stdout) {
			child.stdout.on("data", (chunk: Buffer) => {
				stdoutBuffer += chunk.toString("utf8");
			});
		}

		child.on("close", () => {
			const extracted = extractEnvFromOutput(stdoutBuffer);
			if (Object.keys(extracted).length > 0) {
				finish(extracted, true);
			} else {
				finish(resolveFallback(options), false);
			}
		});
	});
}

export async function resolveShellEnv(options?: ShellEnvResolverOptions): Promise<Record<string, string>> {
	if (!options?.forceRefresh) {
		if (cachedEnv) {
			return { ...cachedEnv };
		}
		if (pendingResolution) {
			return pendingResolution;
		}
	}

	const promise = executeShellEnvResolution(options);
	if (!options?.forceRefresh) {
		pendingResolution = promise;
	}

	try {
		return await promise;
	} finally {
		if (pendingResolution === promise) {
			pendingResolution = null;
		}
	}
}
