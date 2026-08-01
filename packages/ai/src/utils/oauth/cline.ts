/**
 * Cline Web Device Authentication flow.
 *
 * Connects to WorkOS & Cline Auth API (https://app.cline.bot & https://api.cline.bot):
 * 1. Requests device authorization from WorkOS (client_01K3A541FN8TA3EPPHTD2325AR).
 * 2. Opens the browser to https://app.cline.bot/auth/device with the user code.
 * 3. Polls WorkOS for authentication completion.
 * 4. Registers tokens with https://api.cline.bot/api/v1/auth/register and returns
 *    the Cline-issued OAuth credentials (access + refresh + expiry), which are
 *    what actually authorize api.cline.bot/v1 requests. The raw WorkOS token is
 *    never a valid Cline API key — persisting it produces a login that looks
 *    successful but 401s on every model request.
 */

import type { OAuthCredentials } from "./types";

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

interface ClineAuthResponseData {
	accessToken: string;
	refreshToken?: string;
	tokenType?: string;
	expiresAt?: string;
	userInfo?: {
		clineUserId?: string;
		email?: string;
		[name: string]: unknown;
	};
}

interface ClineRegisterResponse {
	success?: boolean;
	data?: ClineAuthResponseData;
	accessToken?: string;
	apiKey?: string;
	token?: string;
}

function toEpochMs(isoDateTime: string | undefined): number {
	if (!isoDateTime) {
		return 0;
	}
	const ms = Date.parse(isoDateTime);
	return Number.isFinite(ms) ? ms : 0;
}

function toClineCredentials(responseData: ClineAuthResponseData): OAuthCredentials {
	const refreshToken = responseData.refreshToken;
	const accessToken = responseData.accessToken;
	if (!refreshToken) {
		throw new Error("Cline token response did not include a refresh token");
	}
	const userInfo = responseData.userInfo;
	return {
		access: accessToken,
		refresh: refreshToken,
		expires: toEpochMs(responseData.expiresAt),
		accountId: userInfo?.clineUserId,
		email: userInfo?.email,
	};
}

/**
 * Login to Cline using web-based WorkOS Device Authentication.
 *
 * Returns the Cline-issued OAuth credentials. Throws when the register
 * exchange fails rather than silently persisting the WorkOS token, which
 * cannot authorize api.cline.bot requests.
 */
export async function loginCline(callbacks: {
	onAuth?: (info: { url: string; instructions?: string }) => void;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
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
			if (tokenData.access_token && tokenData.refresh_token) {
				callbacks.onProgress?.("Signing in complete! Exchanging tokens with Cline...");

				// 4. Exchange WorkOS token with Cline backend. This step is
				// mandatory: only the register response carries the Cline API
				// credential. Surface failures instead of falling back.
				const registerResponse = await fetch(CLINE_REGISTER_URL, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						accessToken: tokenData.access_token,
						refreshToken: tokenData.refresh_token,
					}),
				});

				if (!registerResponse.ok) {
					const text = await registerResponse.text().catch(() => "");
					throw new Error(`Cline token registration failed: ${registerResponse.status} ${text}`);
				}

				const regData = (await registerResponse.json()) as ClineRegisterResponse;
				const responseData = regData.data;
				if (!responseData?.accessToken) {
					const legacyKey = regData.apiKey || regData.accessToken || regData.token;
					if (legacyKey) {
						// Legacy fallback: provider returned a flat api key. Persist
						// it as a bearer credential without refresh support.
						return {
							access: legacyKey,
							refresh: "",
							expires: 0,
						};
					}
					throw new Error("Cline token registration response missing access token");
				}
				return toClineCredentials(responseData);
			}
			if (tokenData.access_token && !tokenData.refresh_token) {
				throw new Error("WorkOS authentication did not return a refresh token; please try again");
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

/**
 * Refresh Cline OAuth credentials using the Cline refresh token.
 * Mirrors the Cline SDK: POST /api/v1/auth/refresh with grantType refresh_token.
 */
export async function refreshClineToken(current: OAuthCredentials): Promise<OAuthCredentials> {
	const response = await fetch(`${CLINE_REGISTER_URL.replace(/\/register$/, "/refresh")}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			refreshToken: current.refresh,
			grantType: "refresh_token",
		}),
		signal: AbortSignal.timeout(30_000),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Cline token refresh failed: ${response.status} ${text}`);
	}

	const regData = (await response.json()) as ClineRegisterResponse;
	const responseData = regData.data;
	if (!responseData?.accessToken) {
		throw new Error("Cline token refresh response missing access token");
	}
	return toClineCredentials(responseData);
}
/**
 * Format a Cline access token with the required `workos:` prefix if missing.
 */
export function formatClineApiKey(accessToken: string): string {
	const token = accessToken.trim();
	return token.toLowerCase().startsWith("workos:") ? token : `workos:${token}`;
}
/**
 * Common HTTP headers required by api.cline.bot endpoints.
 */
export function getClineCommonHeaders(): Record<string, string> {
	return {
		"User-Agent": "Cline/3.5.0",
		"HTTP-Referer": "https://cline.bot",
		"X-Title": "Cline",
		"X-IS-MULTIROOT": "false",
		"X-CLIENT-TYPE": "cline-cli",
		"X-CLIENT-VERSION": "3.5.0",
		"X-CORE-VERSION": "3.5.0",
	};
}
