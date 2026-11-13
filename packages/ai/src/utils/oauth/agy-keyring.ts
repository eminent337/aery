/**
 * OS keyring bridge for Google Antigravity credentials.
 *
 * `agy` (the official Antigravity CLI) stores its OAuth token in the system
 * keyring under service="gemini", username="antigravity" using the
 * `github.com/zalando/go-keyring` library (backed by DBus Secret Service on
 * Linux, Keychain on macOS).
 *
 * This module reads that keyring entry via the `secret-tool` CLI (libsecret)
 * so Aery can obtain a fresh token without requiring a separate login when
 * `agy` is already authenticated on the same machine.
 *
 * The fallback chain in AuthStorage is:
 *   1. Aery's own SQLite credential store  (freshest when Aery itself logged in)
 *   2. OS keyring entry written by `agy`    (fallback - auto-refreshed if expired)
 *   3. Fail -> prompt user to run `aery auth google-antigravity`
 */

import { logger } from "@aryee337/aery-utils";
import { $ } from "bun";

/** Shape of the token JSON stored in the keyring by `agy`. */
interface AgyKeyringToken {
	token?: {
		access_token?: string;
		refresh_token?: string;
		token_type?: string;
		expiry?: string;
	};
	auth_method?: string;
}

/** Keyring lookup coordinates matching `agy`'s go-keyring write. */
const KEYRING_SERVICE = "gemini";
const KEYRING_USERNAME = "antigravity";

/**
 * Read the Antigravity OAuth token that `agy` stored in the OS keyring.
 *
 * When the access token is expired, auto-refreshes it using the stored
 * refresh_token and writes the fresh token back to the keyring.
 *
 * Returns `null` when:
 * - `secret-tool` is not installed (libsecret not present).
 * - No matching entry exists in the keyring.
 * - The stored JSON is malformed.
 * - The token is expired and refresh failed.
 */
export async function readAgyKeyringToken(): Promise<{
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number;
} | null> {
	try {
		const result = await $`secret-tool lookup service ${KEYRING_SERVICE} username ${KEYRING_USERNAME}`
			.quiet()
			.nothrow();

		if (result.exitCode !== 0) return null;

		const raw = result.text().trim();
		if (!raw) return null;

		const parsed: AgyKeyringToken = JSON.parse(raw);
		const token = parsed.token;
		if (!token?.access_token) return null;

		const expiresAt = token.expiry ? new Date(token.expiry).getTime() : undefined;

		// When expired (with a 30s buffer), attempt auto-refresh using refresh_token
		const BUFFER_MS = 30_000;
		if (expiresAt !== undefined && expiresAt - BUFFER_MS <= Date.now()) {
			if (token.refresh_token) {
				try {
					const { refreshAntigravityToken } = await import("./google-antigravity");
					const refreshed = await refreshAntigravityToken(token.refresh_token, "default-cli-project");
					const updatedPayload = JSON.stringify({
						...parsed,
						token: {
							...token,
							access_token: refreshed.access,
							refresh_token: refreshed.refresh,
							expiry: new Date(refreshed.expires).toISOString(),
						},
					});
					const proc = Bun.spawn(
						[
							"secret-tool",
							"store",
							"--label=Antigravity token",
							"service",
							KEYRING_SERVICE,
							"username",
							KEYRING_USERNAME,
						],
						{ stdin: "pipe" },
					);
					proc.stdin.write(updatedPayload);
					proc.stdin.end();

					return {
						accessToken: refreshed.access,
						refreshToken: refreshed.refresh,
						expiresAt: refreshed.expires,
					};
				} catch (refreshErr) {
					logger.debug("agy keyring token refresh failed", {
						err: refreshErr instanceof Error ? refreshErr.message : String(refreshErr),
					});
					return null;
				}
			}
			logger.debug("agy keyring token is expired with no refresh_token", { expiresAt, now: Date.now() });
			return null;
		}

		return {
			accessToken: token.access_token,
			refreshToken: token.refresh_token,
			expiresAt,
		};
	} catch (err) {
		// secret-tool not found, entry missing, or JSON parse error - all are silent.
		logger.debug("agy keyring read failed (non-fatal)", {
			err: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/**
 * Convenience wrapper: returns just the bearer access token string, or
 * `undefined` when the keyring entry is absent / expired.
 */
export async function readAgyKeyringAccessToken(): Promise<string | undefined> {
	const result = await readAgyKeyringToken();
	return result?.accessToken;
}
