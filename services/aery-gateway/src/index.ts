/**
 * Aery Gateway - Cloudflare Worker
 *
 * Users bring provider API keys, store them under one Aery key, and Aery routes
 * through /v1/<provider>/... with provider-specific request auth.
 */

export interface Env {
	KEYS: KVNamespace;
	FREE_TIER_OPENROUTER_KEY?: string;
	GATEWAY_VERSION?: string;
}

type StoredCredential = string | { key: string; accountId?: string };
type StoredKeys = Record<string, StoredCredential>;

interface ProviderRoute {
	baseUrl: string;
	auth: "bearer" | "anthropic-key" | "google-key-query";
	requiresAccountId?: boolean;
	openAiCompatible?: boolean;
}

const FREE_TIER_MODELS = new Set([
	"meta-llama/llama-3.1-8b-instruct:free",
	"google/gemma-2-9b-it:free",
	"qwen/qwen-2.5-7b-instruct:free",
	"mistralai/mistral-7b-instruct:free",
	"microsoft/phi-3-mini-128k-instruct:free",
]);

const FREE_TIER_DAILY_LIMIT = 50;

const PROVIDERS: Record<string, ProviderRoute> = {
	anthropic: { baseUrl: "https://api.anthropic.com", auth: "anthropic-key" },
	openai: { baseUrl: "https://api.openai.com/v1", auth: "bearer", openAiCompatible: true },
	"openai-responses": { baseUrl: "https://api.openai.com/v1", auth: "bearer" },
	"cloudflare-workers-ai": {
		baseUrl: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1",
		auth: "bearer",
		requiresAccountId: true,
		openAiCompatible: true,
	},
	openrouter: { baseUrl: "https://openrouter.ai/api/v1", auth: "bearer", openAiCompatible: true },
	mistral: { baseUrl: "https://api.mistral.ai/v1", auth: "bearer", openAiCompatible: true },
	groq: { baseUrl: "https://api.groq.com/openai/v1", auth: "bearer", openAiCompatible: true },
	fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1", auth: "bearer", openAiCompatible: true },
	together: { baseUrl: "https://api.together.xyz/v1", auth: "bearer", openAiCompatible: true },
	xai: { baseUrl: "https://api.x.ai/v1", auth: "bearer", openAiCompatible: true },
	moonshot: { baseUrl: "https://api.moonshot.cn/v1", auth: "bearer", openAiCompatible: true },
	"google-generative-ai": {
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		auth: "google-key-query",
	},
};

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json",
			"Access-Control-Allow-Origin": "*",
			...headers,
		},
	});
}

function err(message: string, status = 400): Response {
	return json({ error: message }, status);
}

function generateAeryKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return `aery_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function extractAeryKey(request: Request): string | null {
	const auth = request.headers.get("Authorization") ?? "";
	const match = auth.match(/^Bearer (aery_[0-9a-f]{32})$/);
	return match?.[1] ?? null;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
	try {
		const value = await request.json();
		if (!isObject(value)) throw new Error("JSON body must be an object.");
		return value;
	} catch (error) {
		throw new Error(error instanceof Error ? error.message : "Invalid JSON body.");
	}
}

function normalizeStoredKeys(value: unknown): StoredKeys {
	if (!isObject(value)) return {};
	const normalized: StoredKeys = {};
	for (const [provider, credential] of Object.entries(value)) {
		if (!PROVIDERS[provider]) continue;
		if (typeof credential === "string" && credential.trim()) {
			normalized[provider] = credential.trim();
			continue;
		}
		if (isObject(credential) && typeof credential.key === "string" && credential.key.trim()) {
			normalized[provider] = {
				key: credential.key.trim(),
				accountId: typeof credential.accountId === "string" ? credential.accountId.trim() : undefined,
			};
		}
	}
	return normalized;
}

function getCredentialKey(credential: StoredCredential): string {
	return typeof credential === "string" ? credential : credential.key;
}

function resolveBaseUrl(route: ProviderRoute, credential: StoredCredential): string {
	if (!route.requiresAccountId) return route.baseUrl;
	if (typeof credential === "string" || !credential.accountId) {
		throw new Error("Cloudflare account ID is required for cloudflare-workers-ai.");
	}
	return route.baseUrl.replace("{CLOUDFLARE_ACCOUNT_ID}", credential.accountId);
}

function requestBodyFor(method: string, request: Request): ReadableStream | null {
	return method === "GET" || method === "HEAD" ? null : request.body;
}

async function loadStoredKeys(request: Request, env: Env): Promise<{ aeryKey: string; keys: StoredKeys } | Response> {
	const aeryKey = extractAeryKey(request);
	if (!aeryKey) return err("Missing or invalid Authorization header", 401);

	const stored = await env.KEYS.get(`keys:${aeryKey}`);
	if (!stored) return err("Aery key not found", 404);

	return { aeryKey, keys: JSON.parse(stored) as StoredKeys };
}

async function handleRegister(request: Request, env: Env): Promise<Response> {
	let providers: StoredKeys = {};
	if (request.headers.get("content-length") !== "0") {
		try {
			const body = await readJsonObject(request);
			providers = normalizeStoredKeys(body.providers);
		} catch (error) {
			return err(error instanceof Error ? error.message : "Invalid JSON body.");
		}
	}

	const aeryKey = generateAeryKey();
	await env.KEYS.put(`keys:${aeryKey}`, JSON.stringify(providers));
	return json({ aery_key: aeryKey, providers: Object.keys(providers) }, 201);
}

async function handleUpdateKeys(request: Request, env: Env): Promise<Response> {
	const loaded = await loadStoredKeys(request, env);
	if (loaded instanceof Response) return loaded;

	try {
		const updates = normalizeStoredKeys(await readJsonObject(request));
		const merged: StoredKeys = { ...loaded.keys, ...updates };
		await env.KEYS.put(`keys:${loaded.aeryKey}`, JSON.stringify(merged));
		return json({ providers: Object.keys(merged) });
	} catch (error) {
		return err(error instanceof Error ? error.message : "Invalid JSON body.");
	}
}

async function handleListKeys(request: Request, env: Env): Promise<Response> {
	const loaded = await loadStoredKeys(request, env);
	if (loaded instanceof Response) return loaded;
	return json({ providers: Object.keys(loaded.keys) });
}

async function handleUsage(request: Request, env: Env): Promise<Response> {
	const loaded = await loadStoredKeys(request, env);
	if (loaded instanceof Response) return loaded;

	const keyPrefix = loaded.aeryKey.slice(0, 12);
	const list = await env.KEYS.list({ prefix: `usage:${keyPrefix}:` });
	const usage: Record<string, Record<string, number>> = {};

	for (const key of list.keys) {
		const value = await env.KEYS.get(key.name);
		if (!value) continue;
		const [, , date, provider] = key.name.split(":");
		usage[date] ??= {};
		usage[date][provider] = Number.parseInt(value, 10) || 0;
	}

	return json({ usage });
}

async function getRequestedModel(request: Request): Promise<string | undefined> {
	if (!request.headers.get("content-type")?.includes("json")) return undefined;
	try {
		const body = (await request.clone().json()) as { model?: unknown };
		return typeof body.model === "string" ? body.model : undefined;
	} catch {
		return undefined;
	}
}

async function handleFreeTier(request: Request, env: Env, aeryKey: string, providerPath: string): Promise<Response> {
	if (!env.FREE_TIER_OPENROUTER_KEY) return err("Free tier is not configured.", 503);

	const requestedModel = await getRequestedModel(request);
	if (!requestedModel || !FREE_TIER_MODELS.has(requestedModel)) {
		return err(`Free tier only supports these models: ${[...FREE_TIER_MODELS].join(", ")}`, 403);
	}

	const keyPrefix = aeryKey.slice(0, 12);
	const day = new Date().toISOString().slice(0, 10);
	const limitKey = `free:${keyPrefix}:${day}`;
	const used = Number.parseInt((await env.KEYS.get(limitKey)) ?? "0", 10) || 0;
	if (used >= FREE_TIER_DAILY_LIMIT) {
		return err(`Free tier limit reached (${FREE_TIER_DAILY_LIMIT} requests/day).`, 429);
	}

	await env.KEYS.put(limitKey, String(used + 1), { expirationTtl: 60 * 60 * 24 * 2 });

	const headers = new Headers(request.headers);
	headers.set("Authorization", `Bearer ${env.FREE_TIER_OPENROUTER_KEY}`);
	headers.set("X-Title", "Aery Free Tier");
	headers.delete("host");

	return fetchUpstream(`https://openrouter.ai/api/v1${providerPath}`, request, headers);
}

function applyProviderAuth(url: URL, headers: Headers, route: ProviderRoute, apiKey: string): void {
	headers.delete("host");
	headers.delete("x-api-key");

	if (route.auth === "anthropic-key") {
		headers.delete("Authorization");
		headers.set("x-api-key", apiKey);
		return;
	}

	if (route.auth === "google-key-query") {
		headers.delete("Authorization");
		url.searchParams.set("key", apiKey);
		return;
	}

	headers.set("Authorization", `Bearer ${apiKey}`);
}

async function fetchUpstream(targetUrl: string, request: Request, headers: Headers): Promise<Response> {
	const upstream = await fetch(targetUrl, {
		method: request.method,
		headers,
		body: requestBodyFor(request.method, request),
	});

	return new Response(upstream.body, {
		status: upstream.status,
		headers: upstream.headers,
	});
}

function trackUsage(ctx: ExecutionContext, env: Env, aeryKey: string, provider: string): void {
	const keyPrefix = aeryKey.slice(0, 12);
	const day = new Date().toISOString().slice(0, 10);
	const usageKey = `usage:${keyPrefix}:${day}:${provider}`;

	ctx.waitUntil(
		env.KEYS.get(usageKey).then((value) => {
			const count = value ? Number.parseInt(value, 10) + 1 : 1;
			return env.KEYS.put(usageKey, String(count), { expirationTtl: 60 * 60 * 24 * 90 });
		}),
	);
}

async function handleProxy(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	provider: string,
	providerPath: string,
): Promise<Response> {
	const route = PROVIDERS[provider];
	if (!route) return err(`Unknown provider: ${provider}`, 400);

	const loaded = await loadStoredKeys(request, env);
	if (loaded instanceof Response) return loaded;

	const credential = loaded.keys[provider];
	if (!credential) {
		if (provider === "openrouter") return handleFreeTier(request, env, loaded.aeryKey, providerPath);
		return err(`No API key stored for provider: ${provider}`, 404);
	}

	let target: URL;
	try {
		target = new URL(`${resolveBaseUrl(route, credential)}${providerPath}`);
	} catch (error) {
		return err(error instanceof Error ? error.message : "Invalid provider configuration.", 400);
	}

	const headers = new Headers(request.headers);
	applyProviderAuth(target, headers, route, getCredentialKey(credential));
	trackUsage(ctx, env, loaded.aeryKey, provider);

	return fetchUpstream(target.toString(), request, headers);
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const method = request.method;

		if (method === "OPTIONS") {
			return new Response(null, {
				headers: {
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
					"Access-Control-Allow-Headers": "Authorization, Content-Type",
				},
			});
		}

		if (url.pathname === "/health") return json({ ok: true, version: env.GATEWAY_VERSION ?? "dev" });
		if (url.pathname === "/providers") {
			return json({
				providers: Object.entries(PROVIDERS).map(([id, route]) => ({
					id,
					openAiCompatible: !!route.openAiCompatible,
					requiresAccountId: !!route.requiresAccountId,
				})),
			});
		}

		if (url.pathname === "/register" && method === "POST") return handleRegister(request, env);
		if (url.pathname === "/keys" && method === "PUT") return handleUpdateKeys(request, env);
		if (url.pathname === "/keys" && method === "GET") return handleListKeys(request, env);
		if (url.pathname === "/usage" && method === "GET") return handleUsage(request, env);

		const proxyMatch = url.pathname.match(/^\/v1\/([^/]+)(\/.*)?$/);
		if (proxyMatch) {
			const provider = proxyMatch[1];
			const providerPath = `${proxyMatch[2] ?? ""}${url.search}`;
			return handleProxy(request, env, ctx, provider, providerPath);
		}

		return err("Not found", 404);
	},
} satisfies ExportedHandler<Env>;
