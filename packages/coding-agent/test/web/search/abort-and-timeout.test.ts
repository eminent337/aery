/**
 * Regression coverage for issue #1221: `web_search` froze when an upstream
 * provider stalled because Bun's WinHTTP fetch could ignore `AbortSignal`,
 * and `executeSearch` masked the eventual `AbortError` as a normal provider
 * failure.
 *
 * The fix has two halves: a hard-timeout safety net wrapped around every
 * provider's outbound fetch (via the shared `withHardTimeout` helper), and
 * an abort re-throw in the provider-fallback loop so the session sees a real
 * cancellation instead of "all providers failed".
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ToolSession } from "../../../src/tools";
import { ToolAbortError } from "../../../src/tools/tool-errors";
import { WebSearchTool } from "../../../src/web/search";
import * as provider from "../../../src/web/search/provider";
import type { SearchParams } from "../../../src/web/search/providers/base";
import { withHardTimeout } from "../../../src/web/search/providers/utils";
import { SearchProviderError, type SearchProviderId, type SearchResponse } from "../../../src/web/search/types";

const FAKE_SESSION = {} as ToolSession;

describe("withHardTimeout", () => {
	it("returns a signal that aborts on the hard timeout when no caller signal is supplied", async () => {
		const signal = withHardTimeout(undefined, 10);
		await Bun.sleep(40);
		expect(signal.aborted).toBe(true);
	});

	it("forwards a caller signal's abort to the composed signal", () => {
		const ac = new AbortController();
		const signal = withHardTimeout(ac.signal, 60_000);
		ac.abort(new Error("user-cancel"));
		expect(signal.aborted).toBe(true);
	});

	it("fires the hard timeout even when the caller signal stays open", async () => {
		const ac = new AbortController();
		const signal = withHardTimeout(ac.signal, 10);
		await Bun.sleep(40);
		expect(signal.aborted).toBe(true);
		expect(ac.signal.aborted).toBe(false);
	});
});

describe("executeSearch abort propagation (cascade)", () => {
	afterEach(() => vi.restoreAllMocks());

	function fakeProvider(
		id: SearchProviderId,
		behaviour: (params: SearchParams) => Promise<SearchResponse>,
	): provider.SearchProvider {
		return {
			id,
			label: id.charAt(0).toUpperCase() + id.slice(1),
			isAvailable: () => true,
			search: behaviour,
		};
	}

	it("surfaces caller cancellation as ToolAbortError instead of falling through to the next provider", async () => {
		// Two providers: the first throws an AbortError after the caller aborted,
		// the second would happily return a value. Pre-fix, executeSearch would
		// fall through to provider B and report success; post-fix, the abort
		// re-throw stops the loop immediately.
		const secondProviderSearch = vi.fn();
		vi.spyOn(provider, "getSearchProvider").mockImplementation(async id => {
			if (id === "tavily")
				return fakeProvider("tavily", async () => {
					throw new DOMException("aborted", "AbortError");
				});
			if (id === "exa") return fakeProvider("exa", secondProviderSearch);
			return fakeProvider(id, async () => {
				throw new SearchProviderError(id, "Not configured");
			});
		});

		const tool = new WebSearchTool(FAKE_SESSION);
		const ac = new AbortController();
		ac.abort();

		await expect(tool.execute("test-id", { query: "anything" }, ac.signal)).rejects.toBeInstanceOf(ToolAbortError);
		expect(secondProviderSearch).not.toHaveBeenCalled();
	});

	it("still reports provider failures as a tool result when the caller has not aborted", async () => {
		// Defensive: the abort re-throw must NOT alter normal provider-error
		// flow. A genuine provider error should still produce an error result
		// rather than throwing.
		vi.spyOn(provider, "getSearchProvider").mockImplementation(async id => {
			if (id === "tavily")
				return fakeProvider("tavily", async () => {
					throw new Error("upstream 500");
				});
			return fakeProvider(id, async () => {
				throw new SearchProviderError(id, "Not configured");
			});
		});

		const tool = new WebSearchTool(FAKE_SESSION);
		const result = await tool.execute("test-id", { query: "anything" });
		const block = result.content[0];
		expect(block?.type).toBe("text");
		expect(block && "text" in block ? block.text : "").toContain("upstream 500");
		expect(result.details?.error).toContain("upstream 500");
	});
});
