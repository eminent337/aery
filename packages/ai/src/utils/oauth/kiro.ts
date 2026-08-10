import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { OAuthController } from "./types";

const execAsync = promisify(exec);
export const KIRO_DEVICE_AUTH_URL = "https://device.sso.us-east-1.amazonaws.com/";
/**
 * Check if local kiro-cli binary is authenticated.
 */
export async function isKiroAuthenticated(kiroPath?: string): Promise<boolean> {
	const bin = kiroPath || process.env.KIRO_CLI_PATH || `${process.env.HOME}/.local/bin/kiro-cli`;
	try {
		const { stdout, stderr } = await execAsync(`"${bin}" whoami`);
		const combined = (stdout + stderr).toLowerCase();
		return combined.includes("logged in") && !combined.includes("not logged in");
	} catch {
		return false;
	}
}
/**
 * Login to Kiro CLI using OAuth device authorization flow.
 * Verifies if local kiro-cli binary is already authenticated.
 * If not, spawns kiro-cli device flow, parses the device verification code,
 * and surfaces the AWS SSO / Builder ID device URL for sign-in.
 */
export async function loginKiro(options: OAuthController): Promise<string> {
	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}
	const kiroPath = process.env.KIRO_CLI_PATH || `${process.env.HOME}/.local/bin/kiro-cli`;
	options.onProgress?.("Checking Kiro CLI authentication status...");
	if (await isKiroAuthenticated(kiroPath)) {
		options.onProgress?.("Kiro CLI is already authenticated.");
		return "kiro-local";
	}
	options.onProgress?.("Initiating Kiro CLI authentication...");
	await new Promise<void>((resolve, reject) => {
		const proc = spawn(kiroPath, ["login", "--use-device-flow", "--license", "free"], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, NO_COLOR: "1" },
		});
		let output = "";
		let authNotified = false;
		const handleData = (chunk: Buffer) => {
			const text = chunk.toString();
			output += text;
			if (!authNotified) {
				const codeMatch = output.match(/Code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i);
				if (codeMatch) {
					authNotified = true;
					const userCode = codeMatch[1];
					options.onProgress?.(`Kiro verification code: ${userCode}`);
					options.onAuth?.({
						url: KIRO_DEVICE_AUTH_URL,
						instructions: `Navigate to ${KIRO_DEVICE_AUTH_URL} and enter code: ${userCode} to log in to Kiro CLI.`,
					});
				}
			}
			const lines = text.split("\n");
			for (const line of lines) {
				const trimmed = line.trim();
				if (
					trimmed &&
					!trimmed.includes("Logging in...") &&
					!trimmed.includes("Confirm the following code") &&
					!trimmed.includes("Code:")
				) {
					options.onProgress?.(`Kiro: ${trimmed}`);
				}
			}
		};
		proc.stdout.on("data", handleData);
		proc.stderr.on("data", handleData);
		options.signal?.addEventListener("abort", () => {
			proc.kill();
			reject(new Error("Login cancelled"));
		});
		proc.on("error", err => {
			reject(new Error(`Failed to spawn Kiro CLI: ${err.message}`));
		});
		proc.on("close", code => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`Kiro CLI login process exited with code ${code}`));
			}
		});
	});
	if (await isKiroAuthenticated(kiroPath)) {
		options.onProgress?.("Successfully authenticated Kiro CLI!");
		return "kiro-local";
	}
	throw new Error("Kiro CLI authentication verification failed.");
}
