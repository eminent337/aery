import { afterEach, describe, expect, test, vi } from "bun:test";
import { loginCline } from "../src/utils/oauth/cline";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("cline web device authentication", () => {
	test("returns Cline OAuth credentials from the register endpoint response", async () => {
		const calls: string[] = [];
		global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
			const url = String(input);
			calls.push(url);
			if (url.includes("/user_management/authorize/device")) {
				return new Response(
					JSON.stringify({
						device_code: "device-123",
						user_code: "ABCD-EFGH",
						verification_uri: "https://app.cline.bot/auth/device",
						verification_uri_complete: "https://app.cline.bot/auth/device?code=ABCD-EFGH",
						expires_in: 600,
						interval: 5,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/user_management/authenticate")) {
				// Simulate pending then success
				return new Response(
					JSON.stringify({
						access_token: "workos-access-token",
						refresh_token: "workos-refresh-token",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/api/v1/auth/register")) {
				// Real Cline register shape: { success, data: { accessToken, ... } }
				return new Response(
					JSON.stringify({
						success: true,
						data: {
							accessToken: "cline-api-key-123",
							refreshToken: "cline-refresh-token",
							tokenType: "Bearer",
							expiresAt: "2099-01-01T00:00:00Z",
							userInfo: { clineUserId: "user-1", email: "test@example.com" },
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("{}", { status: 404 });
		}) as unknown as typeof fetch;

		const credentials = await loginCline({
			onAuth: () => {},
			onProgress: () => {},
		});

		expect(credentials.access).toBe("cline-api-key-123");
		expect(credentials.refresh).toBe("cline-refresh-token");
		expect(credentials.expires).toBe(Date.parse("2099-01-01T00:00:00Z"));
		expect(credentials.accountId).toBe("user-1");
		expect(credentials.email).toBe("test@example.com");
		// Verify register was called with the WorkOS access + refresh tokens
		const registerCall = calls.find(url => url.includes("/api/v1/auth/register"));
		expect(registerCall).toBeDefined();
	});

	test("throws when register fails instead of persisting the WorkOS token", async () => {
		global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
			const url = String(input);
			if (url.includes("/user_management/authorize/device")) {
				return new Response(
					JSON.stringify({
						device_code: "device-456",
						user_code: "WXYZ-ABCD",
						verification_uri: "https://app.cline.bot/auth/device",
						expires_in: 600,
						interval: 5,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/user_management/authenticate")) {
				return new Response(
					JSON.stringify({
						access_token: "workos-access-token",
						refresh_token: "workos-refresh-token",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/api/v1/auth/register")) {
				return new Response("{}", { status: 500 });
			}
			return new Response("{}", { status: 404 });
		}) as unknown as typeof fetch;

		await expect(
			loginCline({
				onAuth: () => {},
				onProgress: () => {},
			}),
		).rejects.toThrow(/registration failed/);
	});
});
