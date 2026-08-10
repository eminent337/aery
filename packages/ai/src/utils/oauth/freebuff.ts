/**
 * Freebuff / Codebuff Web Device Authentication flow.
 *
 * Connects to Codebuff CLI Auth API (https://www.codebuff.com):
 * 1. Requests a CLI login URL from https://www.codebuff.com/api/auth/cli/code
 * 2. Opens the browser to the login URL for user sign in.
 * 3. Polls https://www.codebuff.com/api/auth/cli/status until approved.
 * 4. Returns the Freebuff authentication token.
 *
 * The token is only accepted on the `www.` host — requests to `codebuff.com`
 * (no www) return 401 `Missing or invalid Authorization header`, so every
 * endpoint constant below uses the www host.
 */
import type { FetchImpl } from "../../types";
import type { OAuthCredentials } from "./types";

export const CODEBUFF_BASE_URL = "https://www.codebuff.com";
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
	onPrompt?: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
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
		instructions:
			"Sign in with your Freebuff / Codebuff account in the browser (use GitHub or Email if Google SSO shows redirect_uri_mismatch)",
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

/**
 * Common HTTP headers required by Codebuff/Freebuff endpoints.
 */
export function getFreebuffCommonHeaders(): Record<string, string> {
	return {
		"User-Agent": "ai-sdk/openai-compatible/3.5.0/codebuff",
	};
}
const FREEBUFF_ACTING_USER_HEADER = "x-freebuff-acting-user-id";
/**
 * Normalize a base URL so an `/api/v1` suffix is applied exactly once.
 * Accepts either the origin (`https://www.codebuff.com`) or a base that
 * already ends in `/api/v1`, and always returns the origin form with the
 * `/api/v1` prefix (no trailing slash).
 */
export function resolveFreebuffApiBase(baseUrl?: string): string {
	const origin = (baseUrl ?? CODEBUFF_BASE_URL).replace(/\/+$/, "").replace(/\/api\/v1$/, "");
	return `${origin}/api/v1`;
}

/**
 * Start a Freebuff agent run and return its `runId`. The chat-completions
 * endpoint rejects requests without a valid `codebuff_metadata.run_id`
 * (`400 {"message":"No runId found in request body"}`), so every completion
 * must first create a run via `POST /api/v1/agent-runs`.
 */

/**
 * POSTs to /api/v1/freebuff/session to claim an active slot on the Freebuff server.
 * The Codebuff backend requires an active session slot before it admits requests
 * to the free queue. If the user doesn't have an active session, completions fail
 * with 402 Out of credits.
 */
export async function claimFreebuffSessionSlot(options: {
	apiKey: string;
	baseUrl?: string;
	modelId?: string;
	signal?: AbortSignal;
}): Promise<{
		status: string;
		accessTier: string;
		instanceId: string;
		model: string;
		admittedAt: string;
		expiresAt: string;
		remainingMs: number;
		countryCode: string;
		countryBlockReason?: string;
		rateLimit?: {
			limit: number;
			recentCount: number;
			period: string;
		};
	} | null> {
	const { apiKey } = options;
	const apiBase = resolveFreebuffApiBase(options.baseUrl);
	const modelId = options.modelId ?? "base2-free";

	try {
		const response = await fetch(`${apiBase}/freebuff/session`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"x-freebuff-model": modelId,
			},
			signal: options.signal ?? AbortSignal.timeout(10_000),
		});

		if (response.ok) {
			const data = (await response.json()) as any;
			console.log("FREEBUFF SESSION SUCCESS:", data);
			if (data.status === "active") {
				return data;
			}
		} else {
			const text = await response.text();
			console.log("FREEBUFF SESSION ERROR:", response.status, text);
		}

		return null;
	} catch (_err) {
		return null;
	}
}

export async function startFreebuffAgentRun(options: {
	apiKey: string;
	baseUrl?: string;
	agentId?: string;
	userId?: string;
	signal?: AbortSignal;
}): Promise<string | null> {
	const { apiKey } = options;
	const baseUrl = options.baseUrl;
	const apiBase = resolveFreebuffApiBase(baseUrl);
	const agentId = options.agentId ?? "base2-free";
	const userId = options.userId;
	const maxAttempts = 3;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			const response = await fetch(`${apiBase}/agent-runs`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
					...(userId ? { [FREEBUFF_ACTING_USER_HEADER]: userId } : {}),
				},
				body: JSON.stringify({
					action: "START",
					agentId,
					ancestorRunIds: [],
				}),
				signal: options.signal ?? AbortSignal.timeout(20_000),
			});
			if (!response.ok) {
				return null;
			}
			const body = (await response.json()) as { runId?: unknown };
			return typeof body.runId === "string" && body.runId.length > 0 ? body.runId : null;
		} catch (_err) {
			// Retry on transient network errors (socket reset, connection refused)
			const message = _err instanceof Error ? _err.message : String(_err);
			const isTransient =
				message.includes("ECONNRESET") ||
				message.includes("socket") ||
				message.includes("connection refused") ||
				message.includes("fetch failed");
			if (!isTransient || attempt === maxAttempts - 1) return null;
			await Bun.sleep(500 * 2 ** attempt);
		}
	}
	return null;
}

const freebuffRunCache = new Map<string, string | null>();
const freebuffInstanceCache = new Map<string, string>();

/**
 * Get or create a stable instance ID for the given API key.
 * The Freebuff server requires x-freebuff-instance-id on all chat requests.
 */
export function getFreebuffInstanceId(apiKey: string, sessionInstanceId?: string): string {
  const cached = freebuffInstanceCache.get(apiKey);
  if (cached) return cached;
  const instanceId = crypto.randomUUID();
  freebuffInstanceCache.set(apiKey, instanceId);
  return instanceId;
}

/**
 * Cached startFreebuffAgentRun for the given (baseUrl, apiKey) pair — one run
 * per process per credential. Returns null when starting fails.
 */
export async function ensureFreebuffRunId(options: {
	apiKey: string;
	baseUrl?: string;
	agentId?: string;
	userId?: string;
	signal?: AbortSignal;
}): Promise<string | null> {
	const cacheKey = `${options.baseUrl ?? CODEBUFF_BASE_URL}:${options.apiKey}:${options.agentId ?? "base2-free"}`;
	if (freebuffRunCache.has(cacheKey)) {
		const cached = freebuffRunCache.get(cacheKey);
		if (typeof cached === "string") return cached;
	}
	// First claim the free session slot server-side!
	const claimResult = await claimFreebuffSessionSlot({
		apiKey: options.apiKey,
		baseUrl: options.baseUrl,
		modelId: options.agentId,
	});
	// Store session instanceId if present in response
	if (claimResult && claimResult.instanceId && options.apiKey) {
	  freebuffInstanceCache.set(options.apiKey, claimResult.instanceId);
	}

	const runId = await startFreebuffAgentRun(options);
	freebuffRunCache.set(cacheKey, runId);
	return runId;
}

/**
 * Wrap a fetch so every `/chat/completions` POST gets `codebuff_metadata.run_id`
 * injected into the JSON body (required by the Codebuff backend) and the
 * standard Freebuff headers attached. Falls back to plain fetch when the run
 * cannot be started.
 */
export function createFreebuffFetch(options: {
	apiKey: string;
	baseUrl?: string;
	userId?: string;
	fetch?: FetchImpl;
	sessionInstanceId?: string;
}): FetchImpl {
	const baseFetch = options.fetch ?? globalThis.fetch;
	const baseUrl = options.baseUrl ?? CODEBUFF_BASE_URL;
	const apiKey = options.apiKey;
	const userId = options.userId;
	const instanceId = getFreebuffInstanceId(apiKey, options.sessionInstanceId);
	const mergeHeaders = (incoming: RequestInit["headers"]): Record<string, string> => {
		if (!incoming) return {};
		if (incoming instanceof Headers) return Object.fromEntries(incoming.entries());
		if (Array.isArray(incoming)) return Object.fromEntries(incoming);
		return { ...(incoming as Record<string, string>) };
	};
	// Always include the instance ID for Freebuff session binding
	const freebuffHeaders: Record<string, string> = {
		...getFreebuffCommonHeaders(),
		["x-freebuff-instance-id"]: instanceId,
	};
	return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url.includes("/chat/completions") && init?.body) {
			const runId = await ensureFreebuffRunId({ apiKey, baseUrl, userId });
			if (runId) {
				let bodyObj: Record<string, unknown>;
				try {
					bodyObj = JSON.parse(String(init.body)) as Record<string, unknown>;
				} catch {
					bodyObj = {};
				}
				const metadata = (bodyObj.codebuff_metadata ?? {}) as Record<string, unknown>;
				bodyObj.codebuff_metadata = { ...metadata, run_id: runId };
				init = {
					...init,
					body: JSON.stringify(bodyObj),
					headers: {
						...freebuffHeaders,
						...mergeHeaders(init.headers),
					},
				};
			}
		}
		const response = await baseFetch(input, init);
		// Notify capacity deferral listeners for 429 responses (ported from Freebuff SDK)
		notifyCapacityDeferralFromResponse(response);
		return response;
	}) as FetchImpl;
}

/**
 * Fetch the Freebuff session and enumerate the models this account can
 * actually use. `GET /api/v1/freebuff/session` with the include-unused
 * header returns `rateLimitsByModel` keyed by model id — the authoritative
 * "active free models for this user" list (varies by access tier: limited
 * tiers get DeepSeek V4 Flash + MiMo V2.5; full tiers get the whole
 * free-mode allowlist).
 */
export async function fetchFreebuffActiveModels(options: {
	apiKey: string;
	baseUrl?: string;
	signal?: AbortSignal;
}): Promise<string[] | null> {
	const { apiKey } = options;
	const apiBase = resolveFreebuffApiBase(options.baseUrl);
	const maxAttempts = 3;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			const response = await fetch(`${apiBase}/freebuff/session`, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"x-freebuff-include-unused-rate-limits": "1",
				},
				signal: options.signal ?? AbortSignal.timeout(10_000),
			});
			if (!response.ok) {
				// Notify capacity deferral listeners (ported from Freebuff SDK)
				notifyCapacityDeferralFromResponse(response);
				return null;
			}
			const payload = (await response.json()) as { rateLimitsByModel?: Record<string, unknown> };
			if (!payload.rateLimitsByModel || typeof payload.rateLimitsByModel !== "object") {
				return null;
			}
			const ids = Object.keys(payload.rateLimitsByModel).filter(id => id.length > 0);
			return ids.length > 0 ? ids : null;
		} catch (_err) {
			const message = _err instanceof Error ? _err.message : String(_err);
			const isTransient =
				message.includes("ECONNRESET") ||
				message.includes("socket") ||
				message.includes("connection refused") ||
				message.includes("fetch failed");
			if (!isTransient || attempt === maxAttempts - 1) return null;
			await Bun.sleep(500 * 2 ** attempt);
		}
	}
	return null;
}
/**
 * Capacity deferral notification for Freebuff/Codebuff free-mode overload.
 * When the backend sheds a free-mode completion under saturation (HTTP 429
 * with error: 'free_mode_capacity_deferred'), this listener is notified so
 * the host can surface a "high demand" indicator instead of failing.
 *
 * Ported from Freebuff's SDK capacity deferral pattern.
 */
export type FreeModeCapacityDeferral = { retryAfterSeconds: number };
const freeModeCapacityDeferralListeners = new Set<(deferral: FreeModeCapacityDeferral) => void>();
export function registerFreeModeCapacityDeferralListener(listener: (deferral: FreeModeCapacityDeferral) => void): void {
	freeModeCapacityDeferralListeners.add(listener);
}
export function unregisterFreeModeCapacityDeferralListener(
	listener: (deferral: FreeModeCapacityDeferral) => void,
): void {
	freeModeCapacityDeferralListeners.delete(listener);
}
/**
 * Check a response for free-mode capacity deferral signals and notify listeners.
 * Returns true if a deferral was detected (caller may retry after the backoff).
 */
export function notifyCapacityDeferralFromResponse(response: Response): boolean {
	if (response.status !== 429) return false;
	const retryAfterHeader = response.headers.get("retry-after");
	const retryAfterSeconds =
		retryAfterHeader && Number.isFinite(Number(retryAfterHeader)) ? Number(retryAfterHeader) : undefined;
	if (retryAfterSeconds === undefined || retryAfterSeconds <= 0) return false;
	const deferral: FreeModeCapacityDeferral = { retryAfterSeconds };
	for (const listener of freeModeCapacityDeferralListeners) {
		try {
			listener(deferral);
		} catch {
			// Listener errors must never break the request path
		}
	}
	return true;
}
