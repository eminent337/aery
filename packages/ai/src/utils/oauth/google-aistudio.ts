/**
 * Google AI Studio Web Auth flow (Gemini 4 Argon, Gemini 2.5 Pro via Generative Language API)
 * Allows developers to authenticate directly with their Google Account without manual API keys.
 */
import { $env } from "@aryee337/aery-utils";
import { runGoogleOAuthLogin } from "./google-oauth-shared";
import type { OAuthController, OAuthCredentials, OAuthLoginCallbacks } from "./types";

const decode = (s: string) => atob(s);
const DEFAULT_CLIENT_ID = decode(
	"NjgxMjU1ODA5Mzk1LW9vOGZ0Mm9wcmRybnA5ZTNhcWY2YXYzaG1kaWIxMzVqLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29t",
);
const DEFAULT_CLIENT_SECRET = decode("R09DU1BYLTR1SGdNUG0tMW83U2stZ2VWNkN1NWNsWEZzeGw=");

export const GOOGLE_AISTUDIO_CALLBACK_PORT = 51122;
export const GOOGLE_AISTUDIO_CALLBACK_PATH = "/oauth2callback";

export const GOOGLE_AISTUDIO_SCOPES = [
	"https://www.googleapis.com/auth/generative-language",
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function getClientId(): string {
	return $env.GOOGLE_AISTUDIO_CLIENT_ID || DEFAULT_CLIENT_ID;
}

function getClientSecret(): string {
	return $env.GOOGLE_AISTUDIO_CLIENT_SECRET || DEFAULT_CLIENT_SECRET;
}

/**
 * Initiates the interactive browser OAuth login flow for Google AI Studio.
 */
export async function loginGoogleAiStudio(callbacks: OAuthLoginCallbacks | OAuthController): Promise<OAuthCredentials> {
	return runGoogleOAuthLogin(callbacks, {
		clientId: getClientId(),
		clientSecret: getClientSecret(),
		authUrl: AUTH_URL,
		tokenUrl: TOKEN_URL,
		scopes: GOOGLE_AISTUDIO_SCOPES,
		callbackPort: GOOGLE_AISTUDIO_CALLBACK_PORT,
		callbackPath: GOOGLE_AISTUDIO_CALLBACK_PATH,
		discoverProject: async () => {
			return $env.GOOGLE_CLOUD_PROJECT || $env.GOOGLE_CLOUD_PROJECT_ID || "";
		},
	});
}

/**
 * Refreshes an expired Google AI Studio OAuth token.
 */
export async function refreshGoogleAiStudioToken(
	refreshToken: string,
	projectId: string = "",
): Promise<OAuthCredentials> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: getClientId(),
			client_secret: getClientSecret(),
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}),
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Google AI Studio token refresh failed: ${error}`);
	}

	const data = (await response.json()) as {
		access_token: string;
		expires_in: number;
		refresh_token?: string;
	};

	return {
		refresh: data.refresh_token || refreshToken,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
		projectId,
	};
}

/**
 * Formats a Google AI Studio OAuth credential for internal token passing.
 */
export function formatGoogleAiStudioApiKey(credentials: OAuthCredentials): string {
	return credentials.access;
}
