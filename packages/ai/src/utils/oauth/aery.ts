import type { OAuthController } from "./types";

/**
 * Login to Aery Auto Router.
 * Aery Auto Router handles its own routing using bundled credentials.
 */
export async function loginAery(options: OAuthController): Promise<string> {
	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}
	return "aery-local";
}
