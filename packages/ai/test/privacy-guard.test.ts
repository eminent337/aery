import { describe, expect, it } from "bun:test";
import { isPrivacyFirewallError, PrivacyFirewallError } from "../src/privacy/firewall-error";
import { evaluateFirewall, scanContextForFirewall } from "../src/privacy/guard";
import { __resetPrivacyPolicy, setPrivacyPolicy } from "../src/privacy/policy";
import type { Context, Message } from "../src/types";

/** Helpers to build minimal contexts. */
function ctx(...messages: Message[]): Context {
	return { messages };
}
function user(text: string): Message {
	return { role: "user", content: text, timestamp: Date.now() } as Message;
}
function toolResult(text: string): Message {
	return {
		role: "toolResult",
		toolCallId: "t1",
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	} as Message;
}

describe("guard: scanContextForFirewall", () => {
	it("returns null for a clean context (prefilter skip)", () => {
		const c = ctx(
			user("please refactor the parser module"),
			toolResult("export function parse(s: string) { return s.trim(); }"),
		);
		expect(scanContextForFirewall(c)).toBeNull();
	});
	it("finds a secret in a user message", () => {
		const c = ctx(user("use this key: sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGh"));
		const f = scanContextForFirewall(c);
		expect(f).not.toBeNull();
		expect(f!.categories).toContain("openai-key");
		expect(f!.sources[0]!.role).toBe("user");
	});
	it("finds a secret inside a tool result (read .env output)", () => {
		const c = ctx(
			toolResult("¶.env#A1B2\nOPENAI_API_KEY=sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIJ\nPORT=3000"),
		);
		const f = scanContextForFirewall(c);
		expect(f).not.toBeNull();
		expect(f!.escalated).toBe(true);
	});
	it("does not escalate a prose mention even with a secret", () => {
		const c = ctx(user("configure models.yml with OPENAI_API_KEY=sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd"));
		const f = scanContextForFirewall(c);
		expect(f).not.toBeNull();
		expect(f!.escalated).toBe(false);
	});
});

describe("guard: evaluateFirewall (default policy = block data-collecting)", () => {
	it("off mode for zero-retention models — no scan, no throw", () => {
		const c = ctx(user("key: sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGh"));
		const r = evaluateFirewall("claude-sonnet-4-5", c);
		expect(r.mode).toBe("off");
		expect(r.finding).toBeNull();
	});
	it("block mode throws PrivacyFirewallError for flagged content", () => {
		const c = ctx(user("here is my aws key AKIAIOSFODNN7EXAMPLE"));
		const r = evaluateFirewall("muse-spark-1.2-contributor-free", c);
		expect(r.mode).toBe("block");
		expect(r.finding).not.toBeNull();
	});
	it("block mode passes clean content through with no finding", () => {
		const c = ctx(user("please fix the failing test in auth.test.ts"));
		const r = evaluateFirewall("big-pickle", c);
		expect(r.mode).toBe("block");
		expect(r.finding).toBeNull();
	});
	it("warn mode returns finding but never blocks", () => {
		setPrivacyPolicy({
			resolveMode(_modelId, _tier) {
				return "warn";
			},
			extraDataCollecting: new Set<string>(),
		});
		const c = ctx(user("aws key AKIAIOSFODNN7EXAMPLE please check"));
		const r = evaluateFirewall("muse-spark-1.2-contributor-free", c);
		expect(r.mode).toBe("warn");
		expect(r.finding).not.toBeNull();
		__resetPrivacyPolicy();
	});
});

describe("guard: PrivacyFirewallError", () => {
	it("carries categories and model id, never the secret value", () => {
		const secret = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGh";
		const err = new PrivacyFirewallError({ modelId: "big-pickle", categories: ["openai-key"], sensitiveKinds: [] });
		expect(isPrivacyFirewallError(err)).toBe(true);
		expect(err.modelId).toBe("big-pickle");
		expect(err.categories).toEqual(["openai-key"]);
		expect(err.message).toContain("big-pickle");
		expect(err.message).not.toContain(secret); // secret must never appear in the error
	});
	it("message mentions redaction guidance", () => {
		const err = new PrivacyFirewallError({
			modelId: "muse-spark-1.2-contributor-free",
			categories: ["aws-access-key"],
			sensitiveKinds: [],
		});
		expect(err.message).toContain("redacted");
	});
});
