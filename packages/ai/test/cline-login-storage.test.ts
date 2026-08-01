import { afterEach, describe, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

function mockClineFetchFlow() {
	global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
		const url = String(input);
		if (url.includes("/user_management/authorize/device")) {
			return new Response(
				JSON.stringify({
					device_code: "device-integration",
					user_code: "INTG-1234",
					verification_uri: "https://app.cline.bot/auth/device",
					verification_uri_complete: "https://app.cline.bot/auth/device?code=INTG-1234",
					expires_in: 600,
					interval: 5,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		if (url.includes("/user_management/authenticate")) {
			return new Response(
				JSON.stringify({
					access_token: "workos-integration-access",
					refresh_token: "workos-integration-refresh",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		if (url.includes("/api/v1/auth/register")) {
			return new Response(
				JSON.stringify({
					success: true,
					data: {
						accessToken: "cline-integration-access-token",
						refreshToken: "cline-integration-refresh-token",
						tokenType: "Bearer",
						expiresAt: "2099-01-01T00:00:00Z",
						userInfo: { clineUserId: "acct-integration", email: "u@example.com" },
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		return new Response("{}", { status: 404 });
	}) as unknown as typeof fetch;
}

describe("cline AuthStorage.login integration", () => {
	test("persists OAuth credential and getApiKey returns the Cline access token", async () => {
		mockClineFetchFlow();
		const store = await SqliteAuthCredentialStore.open(":memory:");
		const storage = new AuthStorage(store);
		await storage.reload();
		await storage.login("cline", {
			onAuth: () => {},
			onPrompt: async () => "",
		});
		expect(storage.hasAuth("cline")).toBe(true);
		const credential = storage.getOAuthCredential("cline");
		expect(credential?.type).toBe("oauth");
		expect(credential?.access).toBe("cline-integration-access-token");
		expect(credential?.refresh).toBe("cline-integration-refresh-token");
		const apiKey = await storage.getApiKey("cline");
		expect(apiKey).toBe("workos:cline-integration-access-token");
	});
	test("replaces a stale api_key credential so getApiKey returns the Cline token", async () => {
		mockClineFetchFlow();
		const store = await SqliteAuthCredentialStore.open(":memory:");
		const storage = new AuthStorage(store);
		await storage.reload();
		// Seed a stale api_key holding a WorkOS token (the pre-fix state).
		await storage.set("cline", { type: "api_key", key: "workos-stale-token" });
		expect(await storage.getApiKey("cline")).toBe("workos-stale-token");
		await storage.login("cline", {
			onAuth: () => {},
			onPrompt: async () => "",
		});
		// getApiKey must now return the real Cline token, not the stale WorkOS one.
		const apiKey = await storage.getApiKey("cline");
		expect(apiKey).toBe("workos:cline-integration-access-token");
		expect(storage.getOAuthCredential("cline")?.type).toBe("oauth");
	});
});
