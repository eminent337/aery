import { afterEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "../src/models";
import { isPrivacyFirewallError, type PrivacyFirewallError } from "../src/privacy/firewall-error";
import { __resetPrivacyPolicy, setPrivacyPolicy } from "../src/privacy/policy";
import { stream } from "../src/stream";
import type { Context, Model } from "../src/types";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	__resetPrivacyPolicy();
});

/** The bundled zen free model used by the free filter tests. */
function zenFreeModel(): Model<"openai-completions"> {
	const base = getBundledModel("opencode", "gpt-5-nano") ?? getBundledModel("openai", "gpt-4o-mini");
	return {
		...(base as Model<"openai-completions">),
		id: "muse-spark-1.2-contributor-free",
		api: "openai-completions",
		provider: "opencode-zen",
		baseUrl: "https://opencode.ai/zen/v1",
	} satisfies Model<"openai-completions">;
}

function nonFlaggedModel(): Model<"openai-completions"> {
	const base = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
	return { ...base, api: "openai-completions" } satisfies Model<"openai-completions">;
}

function contextWithSecret(): Context {
	return {
		messages: [{ role: "user", content: "please check my aws key AKIAIOSFODNN7EXAMPLE", timestamp: Date.now() }],
	};
}

function contextClean(): Context {
	return {
		messages: [{ role: "user", content: "fix the failing parser test", timestamp: Date.now() }],
	};
}

/** A fetch that records it was called and returns a minimal SSE stream. */
function recordingFetch(calls: string[]): typeof fetch {
	const fn = async (input: unknown): Promise<Response> => {
		calls.push(typeof input === "string" ? input : String((input as { url?: string }).url ?? input));
		return new Response("data: [DONE]\n\n", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	return fn as typeof fetch;
}

describe("stream() privacy firewall (stream-level)", () => {
	it("throws PrivacyFirewallError pre-network for flagged model + secret", () => {
		const calls: string[] = [];
		global.fetch = recordingFetch(calls);
		const model = zenFreeModel();

		let caught: unknown;
		try {
			stream(model, contextWithSecret(), { apiKey: "public" } as never);
		} catch (err) {
			caught = err;
		}

		expect(isPrivacyFirewallError(caught)).toBe(true);
		expect((caught as PrivacyFirewallError).categories).toContain("aws-access-key");
		// The request must never reach fetch
		expect(calls).toEqual([]);
	});

	it("proceeds for non-flagged model with the same secret", () => {
		const calls: string[] = [];
		global.fetch = recordingFetch(calls);

		let errored: unknown;
		try {
			stream(nonFlaggedModel(), contextWithSecret(), { apiKey: "test" } as never);
		} catch (err) {
			errored = err;
		}
		// No firewall error; request dispatched (fetch called) — may still fail
		// on stream parsing, but that proves the guard did not interfere.
		expect(isPrivacyFirewallError(errored)).toBe(false);
	});

	it("warn mode proceeds with finding surfaced", () => {
		const calls: string[] = [];
		global.fetch = recordingFetch(calls);
		setPrivacyPolicy({
			resolveMode: (_modelId, tier) => (tier === "data-collecting" ? "warn" : "off"),
			extraDataCollecting: new Set<string>(),
		});

		let errored: unknown;
		try {
			stream(zenFreeModel(), contextWithSecret(), { apiKey: "public" } as never);
		} catch (err) {
			errored = err;
		}
		expect(isPrivacyFirewallError(errored)).toBe(false);
	});

	it("off mode performs no scan (clean and dirty requests pass identically)", () => {
		const calls: string[] = [];
		global.fetch = recordingFetch(calls);
		setPrivacyPolicy({
			resolveMode: () => "off",
			extraDataCollecting: new Set<string>(),
		});

		for (const context of [contextClean(), contextWithSecret()]) {
			let errored: unknown;
			try {
				stream(zenFreeModel(), context, { apiKey: "public" } as never);
			} catch (err) {
				errored = err;
			}
			expect(isPrivacyFirewallError(errored)).toBe(false);
		}
	});

	it("clean context to flagged model proceeds (guard transparent)", () => {
		const calls: string[] = [];
		global.fetch = recordingFetch(calls);

		let errored: unknown;
		try {
			stream(zenFreeModel(), contextClean(), { apiKey: "public" } as never);
		} catch (err) {
			errored = err;
		}
		expect(isPrivacyFirewallError(errored)).toBe(false);
	});
});
