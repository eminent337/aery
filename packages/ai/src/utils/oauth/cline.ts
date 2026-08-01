/**
 * Cline Web Device Authentication flow.
 *
 * Connects to WorkOS & Cline Auth API (https://app.cline.bot & https://api.cline.bot):
 * 1. Requests device authorization from WorkOS (client_01K3A541FN8TA3EPPHTD2325AR).
 * 2. Opens the browser to https://app.cline.bot/auth/device with the user code.
 * 3. Polls WorkOS for authentication completion.
 * 4. Registers tokens with https://api.cline.bot/api/v1/auth/register.
 */

import type { OAuthController } from "./types";

const WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";
const WORKOS_DEVICE_AUTH_URL = "https://api.workos.com/user_management/authorize/device";
const WORKOS_AUTHENTICATE_URL = "https://api.workos.com/user_management/authenticate";
const CLINE_REGISTER_URL = "https://api.cline.bot/api/v1/auth/register";

interface WorkOSDeviceCodeResponse {
	device_code?: string;
	user_code?: string;
	verification_uri?: string;
	verification_uri_complete?: string;
	expires_in?: number;
	interval?: number;
	error?: string;
	error_description?: string;
}

interface WorkOSTokenResponse {
	access_token?: string;
	refresh_token?: string;
	user?: unknown;
	error?: string;
	error_description?: string;
}

interface ClineRegisterResponse {
	success?: boolean;
	data?: {
		accessToken?: string;
		refreshToken?: string;
		tokenType?: string;
		expiresAt?: string;
		userInfo?: unknown;
	};
	accessToken?: string;
	apiKey?: string;
	token?: string;
}

/**
 * Login to Cline using web-based WorkOS Device Authentication.
 */
export async function loginCline(callbacks: OAuthController): Promise<string> {
	callbacks.onProgress?.("Initiating WorkOS web sign-in for Cline...");

	// 1. Request device authorization code
	const initiateResponse = await fetch(WORKOS_DEVICE_AUTH_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: WORKOS_CLIENT_ID }),
	});

	if (!initiateResponse.ok) {
		const text = await initiateResponse.text().catch(() => "");
		throw new Error(`Failed to initiate Cline web authentication: ${initiateResponse.status} ${text}`);
	}

	const deviceData = (await initiateResponse.json()) as WorkOSDeviceCodeResponse;
	const { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval } = deviceData;

	if (!device_code || !user_code || (!verification_uri && !verification_uri_complete)) {
		throw new Error("Cline device authorization response missing required fields");
	}

	const authUrl = verification_uri_complete || verification_uri || "https://app.cline.bot/auth";
	const pollIntervalMs = (interval || 5) * 1000;
	const expiresInMs = (expires_in || 600) * 1000;
	const deadline = Date.now() + expiresInMs;

	// 2. Trigger browser open and display user code
	callbacks.onAuth?.({
		url: authUrl,
		instructions: `Enter code: ${user_code}`,
	});

	callbacks.onProgress?.(`Waiting for web sign-in... (Code: ${user_code})`);

	// 3. Poll WorkOS until approved or expired
	while (Date.now() < deadline) {
		if (callbacks.signal?.aborted) {
			throw new Error("Login cancelled");
		}

		const pollResponse = await fetch(WORKOS_AUTHENTICATE_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: WORKOS_CLIENT_ID,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code,
			}),
		});

		if (pollResponse.ok) {
			const tokenData = (await pollResponse.json()) as WorkOSTokenResponse;
			if (tokenData.access_token) {
				callbacks.onProgress?.("Signing in complete! Exchanging tokens with Cline...");

				// 4. Exchange WorkOS token with Cline backend
				try {
					const registerResponse = await fetch(CLINE_REGISTER_URL, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							accessToken: tokenData.access_token,
							refreshToken: tokenData.refresh_token,
						}),
					});
					if (registerResponse.ok) {
						const regData = (await registerResponse.json()) as ClineRegisterResponse;
						const key = regData.data?.accessToken || regData.apiKey || regData.accessToken || regData.token;
						if (key) return key;
					}
				} catch {
					// Ignore registration error and fall back to WorkOS access token
				}
				return tokenData.access_token;
			}
		} else {
			const errData = (await pollResponse.json().catch(() => ({}))) as WorkOSTokenResponse;
			if (errData.error === "access_denied") {
				throw new Error("Authorization was denied by user");
			}
			if (errData.error === "expired_token") {
				throw new Error("Authorization code expired. Please try again.");
			}
		}

		await Bun.sleep(pollIntervalMs);
	}

	throw new Error("Web authentication timed out. Please try again.");
}
