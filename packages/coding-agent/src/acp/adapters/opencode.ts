import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcpClient } from "../client";

const homeDir = process.env.HOME || os.homedir();
const homeNpmGlobal = path.join(homeDir, ".npm-global", "bin", "opencode");

export const OPENCODE_STANDARD_PATHS: string[] = Array.from(
	new Set([
		homeNpmGlobal,
		"/usr/local/bin/opencode",
		"/usr/bin/opencode",
	])
);

export const OPENCODE_FREE_MODELS: readonly string[] = [
	"qwen3.6-plus-free",
	"qwen2.5-coder-free",
	"minimax-m2.5-free",
	"glm-5-free",
	"trinity-large-preview-free",
	"deepseek-chat",
];

export function isExecutableFile(targetPath: string): boolean {
	try {
		const stats = fs.statSync(targetPath);
		if (!stats.isFile()) {
			return false;
		}
		fs.accessSync(targetPath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export function resolveOpencodeBinary(customPath?: string): string | null {
	if (customPath) {
		return isExecutableFile(customPath) ? customPath : null;
	}

	if (process.env.OPENCODE_BIN && isExecutableFile(process.env.OPENCODE_BIN)) {
		return process.env.OPENCODE_BIN;
	}

	const candidates = [
		...OPENCODE_STANDARD_PATHS,
		path.join(homeDir, ".npm-global", "bin", "opencode"),
	];

	for (const candidate of candidates) {
		if (candidate && isExecutableFile(candidate)) {
			return candidate;
		}
	}

	const pathDirs = (process.env.PATH || "").split(path.delimiter);
	for (const rawDir of pathDirs) {
		const dir = rawDir.trim().replace(/^["']+|["']+$/g, "");
		if (!dir) continue;
		const candidate = path.join(dir, "opencode");
		if (isExecutableFile(candidate)) {
			return candidate;
		}
	}

	return null;
}

export function getOpencodeEnvironment(baseEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const source = baseEnv ?? process.env;
	const env: NodeJS.ProcessEnv = { ...source };
	env.OPENCODE_DISABLE_UPDATE_CHECK = "1";

	const effectiveHome = env.HOME || os.homedir();
	const candidateDir = env.XDG_DATA_HOME || path.join(effectiveHome, ".local", "share");

	let writable = false;
	let testFile: string | null = null;
	try {
		fs.mkdirSync(candidateDir, { recursive: true });
		fs.accessSync(candidateDir, fs.constants.W_OK);
		testFile = path.join(
			candidateDir,
			`.test-write-${Date.now()}-${Math.random().toString(36).slice(2)}`
		);
		fs.writeFileSync(testFile, "");
		writable = true;
	} catch {
		writable = false;
	} finally {
		if (testFile) {
			try {
				fs.unlinkSync(testFile);
			} catch {
				// ignore unlink cleanup error
			}
		}
	}

	if (!writable) {
		const userIdentifier =
			env.USER ||
			env.LOGNAME ||
			(typeof process.getuid === "function" ? String(process.getuid()) : "default");
		const fallback = path.join(os.tmpdir(), `aery-opencode-data-${userIdentifier}`);
		try {
			fs.mkdirSync(fallback, { recursive: true });
		} catch {
			// ignore fallback directory creation errors in restricted environments
		}
		env.XDG_DATA_HOME = fallback;
	} else if (!env.XDG_DATA_HOME) {
		env.XDG_DATA_HOME = candidateDir;
	}

	return env;
}

export interface CreateOpencodeAcpClientOptions {
	binaryPath?: string;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

export function createOpencodeAcpClient(options: CreateOpencodeAcpClientOptions = {}): AcpClient {
	const binary = resolveOpencodeBinary(options.binaryPath);
	if (!binary) {
		const target = options.binaryPath ? ` at "${options.binaryPath}"` : "";
		throw new Error(
			`OpenCode binary not found${target}. Please ensure opencode is installed or set OPENCODE_BIN.`
		);
	}

	const env = getOpencodeEnvironment(options.env);

	return new AcpClient({
		command: binary,
		args: ["acp"],
		cwd: options.cwd,
		env,
		timeoutMs: options.timeoutMs,
	});
}
