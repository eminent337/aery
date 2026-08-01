/**
 * Cline API login flow.
 *
 * Provides access to Cline API models (api.cline.bot).
 * 1. Open browser to https://cline.bot
 * 2. User gets their API key
 * 3. User pastes the API key back into the CLI
 */

import type { OAuthController } from "./types";

const AUTH_URL = "https://cline.bot";

/**
 * Login to Cline API.
 */
export async function loginCline(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error("Cline login requires onPrompt callback");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Log in to your Cline account and copy your API key",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your Cline API key",
		placeholder: "sk-...",
	});

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new Error("API key is required");
	}

	return trimmed;
}
