import { describe, expect, it } from "bun:test";
import { containsSecret, type SecretCategory, scanTextForSecrets } from "../src/privacy/secret-detector";

/** Fake-but-well-shaped secrets for testing (not real credentials). */
const POSITIVE_FIXTURES: Array<{ label: string; text: string; category: SecretCategory }> = [
	{
		label: "OpenAI key",
		text: "here is my key sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGh",
		category: "openai-key",
	},
	{
		label: "Anthropic key",
		text: "export ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrStUv",
		category: "anthropic-key",
	},
	{
		label: "AWS access key",
		text: "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
		category: "aws-access-key",
	},
	{
		label: "GitHub PAT",
		text: "token: ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
		category: "github-token",
	},
	{
		label: "GitHub fine-grained PAT",
		text: "github_pat_AbCdEfGhIjKl_0123456789AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
		category: "github-token",
	},
	{
		label: "Slack bot token",
		text: "SLACK_BOT_TOKEN=xoxb-fake-fake-fake-fake-fake-fake-fake",
		category: "slack-token",
	},
	{
		label: "Google API key",
		text: "key=AIzaSyA1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tU1v",
		category: "google-api-key",
	},
	{
		label: "OpenAI key (classic)",
		text: "OPENAI_API_KEY=sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIJ",
		category: "openai-key",
	},
	{
		label: "PEM private key",
		text: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
		category: "private-key",
	},
	{
		label: "OpenSSH private key",
		text: "-----BEGIN OPENSSH PRIVATE KEY-----",
		category: "private-key",
	},
	{
		label: "JWT",
		text: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N0L3k_xCZa8b4MsKCFcYf0",
		category: "jwt",
	},
	{
		label: "postgres connection string",
		text: "DATABASE_URL=postgres://admin:s3cr3tP4ssw0rd@db.example.com:5432/prod",
		category: "connection-string",
	},
	{
		label: "12-word seed phrase",
		text: "seed: abandon ability able about above absent absorb abstract absurd abuse access accident",
		category: "seed-phrase",
	},
	{
		label: "high-entropy bearer token",
		text: "Authorization: Bearer vF9kQ2x7RtZ4mN8pL1wY6aB3cD5eG7hJ0kM2nQ4sU8vX",
		category: "high-entropy-token",
	},
];

/** Ordinary content that must NEVER trip the detector. */
const NEGATIVE_FIXTURES: Array<{ label: string; text: string }> = [
	{ label: "ordinary prose", text: "The quick brown fox jumps over the lazy dog near the river bank." },
	{
		label: "aery source snippet",
		text: 'const api: Api = model.api;\nswitch (api) {\n\tcase "openai-completions":\n\t\treturn streamOpenAICompletions(model, context, providerOptions);\n}',
	},
	{ label: "short identifier", text: "const userId = 12345;" },
	{ label: "uuid", text: "requestId: 7ec0a172-c47f-406c-90c5-3376cd583d12" },
	{ label: "base64 blob (low variety)", text: `data = ${"AbCdEf".repeat(20)}` },
	{ label: "hex hash", text: "commit 10765ff fix: remove Hy3 Free docs" },
	{ label: "sentence with assignment word", text: "We set the password policy to require 12 characters minimum." },
	{ label: "key prefix discussion", text: "OpenAI keys start with sk- followed by a long suffix." },
	{ label: "bash command", text: "curl -s -H 'Authorization: Bearer $TOKEN' https://api.example.com/v1/models" },
	{ label: "plain words run", text: "abandon ability able about above absent" }, // 6 words < 12
	{ label: "normal url", text: "fetch https://opencode.ai/zen/v1/models for the catalog" },
];

describe("secret detector: positives", () => {
	for (const fixture of POSITIVE_FIXTURES) {
		it(`detects ${fixture.label}`, () => {
			const result = scanTextForSecrets(fixture.text);
			expect(result.matches.length).toBeGreaterThan(0);
			expect(result.matches[0]?.category).toBe(fixture.category);
		});
	}
});

describe("secret detector: negatives", () => {
	for (const fixture of NEGATIVE_FIXTURES) {
		it(`ignores ${fixture.label}`, () => {
			const result = scanTextForSecrets(fixture.text);
			expect(result.matches).toEqual([]);
		});
	}
});

describe("secret detector: containsSecret", () => {
	it("returns true when a secret is present", () => {
		expect(containsSecret("key: AKIAIOSFODNN7EXAMPLE")).toBe(true);
	});
	it("returns false for plain text", () => {
		expect(containsSecret("just a normal message about deployment")).toBe(false);
	});
});

describe("secret detector: offsets", () => {
	it("reports accurate offsets", () => {
		const text = "prefix AKIAIOSFODNN7EXAMPLE suffix";
		const result = scanTextForSecrets(text);
		expect(result.matches.length).toBe(1);
		const match = result.matches[0]!;
		expect(text.slice(match.start, match.end)).toBe("AKIAIOSFODNN7EXAMPLE");
	});
	it("finds multiple distinct matches", () => {
		const text = "one ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 two xoxb-fake-fake-fake-fake-fake-fake-fake";
		const result = scanTextForSecrets(text);
		const categories = result.matches.map(m => m.category);
		expect(categories).toContain("github-token");
		expect(categories).toContain("slack-token");
	});
	it("matches are sorted by offset", () => {
		const text = "xoxb-fake-fake-fake-fake-fake-fake-fake then AKIAIOSFODNN7EXAMPLE";
		const result = scanTextForSecrets(text);
		for (let i = 1; i < result.matches.length; i++) {
			expect(result.matches[i]!.start).toBeGreaterThanOrEqual(result.matches[i - 1]!.start);
		}
	});
});
