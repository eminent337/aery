/**
 * Reads the Freebuff / Codebuff auth token from the locally installed
 * Freebuff CLI credential store at `~/.config/manicode/credentials.json`.
 *
 * This allows Aery to use Freebuff's free models without requiring the user
 * to run `aery auth freebuff` separately — if the user has already logged
 * in via the official `freebuff` CLI, Aery picks up that credential
 * automatically.
 *
 * Credential file format (default profile):
 * {
 *   "default": {
 *     "authToken": "<uuid>",
 *     "id": "<user-id>",
 *     "email": "<email>",
 *     "fingerprintId": "<fp-id>",
 *     "fingerprintHash": "<fp-hash>"
 *   }
 * }
 */

import { isEnoent, logger } from "@aryee337/aery-utils";

const MANICODE_CREDENTIALS_PATH = `${Bun.env.HOME ?? "~"}/.config/manicode/credentials.json`;

interface ManicodeCredentials {
	[profile: string]: {
		authToken?: string;
		id?: string;
		email?: string;
		fingerprintId?: string;
		fingerprintHash?: string;
	};
}

/**
 * Read the Freebuff auth token installed by the official `freebuff` CLI.
 * Returns `undefined` when the file is absent or the token is missing.
 */
export async function readFreebuffLocalToken(): Promise<string | undefined> {
	try {
		const parsed: ManicodeCredentials = await Bun.file(MANICODE_CREDENTIALS_PATH).json();

		// Try the default profile first, then fall back to first available profile
		const profile = parsed.default ?? Object.values(parsed)[0];
		const token = profile?.authToken?.trim();

		if (token && token.length > 0) {
			logger.debug("freebuff local token loaded from manicode credentials", {
				path: MANICODE_CREDENTIALS_PATH,
				email: profile.email,
			});
			return token;
		}

		return undefined;
	} catch (err) {
		if (!isEnoent(err)) {
			// Log unexpected errors (e.g. JSON parse failure) but remain non-fatal
			logger.debug("freebuff local credential read failed (non-fatal)", {
				path: MANICODE_CREDENTIALS_PATH,
				err: err instanceof Error ? err.message : String(err),
			});
		}
		return undefined;
	}
}
