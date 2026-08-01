import { afterEach, describe, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

function mockFreebuffFetchFlow() {
	global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

		if (urlStr.includes("/api/auth/cli/code")) {
			return new Response(
				JSON.stringify({
					loginUrl: "https://www.codebuff.com/login?auth_code=test-code",
					fingerprintId: "test-fingerprint",
					fingerprintHash: "test-hash",
					expiresAt: Date.now() + 60000,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		if (urlStr.includes("/api/auth/cli/status")) {
			return new Response(
				JSON.stringify({
					user: {
						authToken: "freebuff-integration-auth-token",
						email: "user@example.com",
						id: "usr-12345",
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		return new Response("Not found", { status: 404 });
	}) as unknown as typeof fetch;
}

describe("freebuff AuthStorage.login integration", () => {
	test("persists OAuth credential and getApiKey returns the Freebuff auth token", async () => {
		mockFreebuffFetchFlow();

		const store = await SqliteAuthCredentialStore.open(":memory:");
		const storage = new AuthStorage(store);
		await storage.reload();

		await storage.login("freebuff", {
			onAuth: () => {},
			onPrompt: async () => "",
		});

		expect(storage.hasAuth("freebuff")).toBe(true);

		const credential = storage.getOAuthCredential("freebuff");
		expect(credential?.type).toBe("oauth");
		expect(credential?.access).toBe("freebuff-integration-auth-token");

		const apiKey = await storage.getApiKey("freebuff");
		expect(apiKey).toBe("freebuff-integration-auth-token");
	});
});
