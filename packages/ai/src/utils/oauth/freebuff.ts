/**
 * Freebuff / Codebuff Web Device Authentication flow.
 *
 * Connects to Codebuff CLI Auth API (https://codebuff.com):
 * 1. Requests a CLI login URL from https://codebuff.com/api/auth/cli/code
 * 2. Opens the browser to the login URL for user sign in.
 * 3. Polls https://codebuff.com/api/auth/cli/status until approved.
 * 4. Returns the Freebuff authentication token.
 */

import type { OAuthCredentials } from "./types";

const CODEBUFF_BASE_URL = "https://codebuff.com";
const CODE_URL = `${CODEBUFF_BASE_URL}/api/auth/cli/code`;
const STATUS_URL = `${CODEBUFF_BASE_URL}/api/auth/cli/status`;

interface LoginCodeResponse {
	loginUrl: string;
	fingerprintId: string;
	fingerprintHash: string;
	expiresAt: number | string;
}

interface LoginStatusResponse {
	user?: {
		authToken?: string;
		email?: string;
		name?: string;
		id?: string;
		[key: string]: unknown;
	};
	authToken?: string;
}

export function formatFreebuffApiKey(apiKey: string): string {
	return apiKey.trim();
}

/**
 * Login to Freebuff / Codebuff using browser-based web authentication.
 */
export async function loginFreebuff(callbacks: {
	onAuth?: (info: { url: string; instructions?: string }) => void;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	callbacks.onProgress?.("Initiating web sign-in for Freebuff...");

	const fingerprintId = `freebuff-aery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

	const initResponse = await fetch(CODE_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ fingerprintId }),
	});

	if (!initResponse.ok) {
		const text = await initResponse.text().catch(() => "");
		throw new Error(`Failed to initiate Freebuff authentication: ${initResponse.status} ${text}`);
	}

	const data = (await initResponse.json()) as LoginCodeResponse;
	if (!data.loginUrl || !data.fingerprintHash) {
		throw new Error("Freebuff login code response missing required fields");
	}

	callbacks.onAuth?.({
		url: data.loginUrl,
		instructions: "Sign in with your Freebuff / Codebuff account in the browser",
	});

	callbacks.onProgress?.("Waiting for web sign-in in browser...");

	const expiresAtMs = typeof data.expiresAt === "number" ? data.expiresAt : Date.parse(String(data.expiresAt));
	const deadline = Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 5 * 60 * 1000;
	const pollIntervalMs = 3_000;

	const statusUrl = new URL(STATUS_URL);
	statusUrl.searchParams.set("fingerprintId", fingerprintId);
	statusUrl.searchParams.set("fingerprintHash", data.fingerprintHash);
	statusUrl.searchParams.set("expiresAt", String(data.expiresAt));

	while (Date.now() < deadline) {
		if (callbacks.signal?.aborted) {
			throw new Error("Login cancelled");
		}

		const pollResponse = await fetch(statusUrl.toString(), {
			method: "GET",
			headers: { Accept: "application/json" },
		});

		if (pollResponse.ok) {
			const statusData = (await pollResponse.json()) as LoginStatusResponse;
			const authToken = statusData.user?.authToken || statusData.authToken;
			if (authToken) {
				callbacks.onProgress?.("Sign-in complete! Freebuff credentials stored.");
				return {
					access: authToken,
					refresh: "",
					expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
					email: statusData.user?.email,
					accountId: statusData.user?.id,
				};
			}
		}

		await Bun.sleep(pollIntervalMs);
	}

	throw new Error("Web authentication timed out. Please try again.");
}
