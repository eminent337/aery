/**
 * 4-Tier Web Search Cascade Executor
 *
 * Sequential execution: tavily → exa → parallel → ddg
 * Falls through on: error, empty results, or 202 (rate-limited success)
 * Each provider gets 25s hard timeout.
 * Final error aggregates all failures.
 */
import type { AuthStorage } from "@aryee337/aery-ai";
import { getSearchProvider } from "./provider";
import type { SearchParams } from "./providers/base";
import type { SearchProviderId, SearchResponse } from "./types";
import { SearchProviderError } from "./types";

const CASCADE_ORDER: SearchProviderId[] = ["tavily", "exa", "parallel", "ddg"];

interface CascadeOptions {
	provider?: SearchProviderId | "auto";
	signal?: AbortSignal;
}

interface ProviderAttempt {
	provider: SearchProviderId;
	response?: SearchResponse;
	error?: Error;
	status?: number;
}

export async function executeCascade(
	params: Omit<SearchParams, "authStorage" | "sessionId" | "signal">,
	authStorage: AuthStorage,
	sessionId: string | undefined,
	options: CascadeOptions = {},
): Promise<SearchResponse> {
	const { provider: preferredProvider, signal } = options;

	const providersToTry = preferredProvider && preferredProvider !== "auto" ? [preferredProvider] : CASCADE_ORDER;

	const attempts: ProviderAttempt[] = [];
	let lastProvider: SearchProviderId = providersToTry[0];

	for (const providerId of providersToTry) {
		lastProvider = providerId;

		const provider = await getSearchProvider(providerId);
		const available = await provider.isAvailable(authStorage);

		if (!available) {
			attempts.push({
				provider: providerId,
				error: new SearchProviderError(providerId, "Provider not configured"),
			});
			continue;
		}

		try {
			const response = await provider.search({
				...params,
				signal,
				authStorage,
				sessionId,
			});

			const hasResults = response.sources && response.sources.length > 0;

			if (!hasResults) {
				attempts.push({
					provider: providerId,
					error: new SearchProviderError(providerId, "No results returned"),
				});
				continue;
			}

			return response;
		} catch (error) {
			const err = error as Error;
			const status = error instanceof SearchProviderError ? error.status : undefined;

			const isAbort = error instanceof DOMException && error.name === "AbortError";
			if (isAbort) throw error;

			const isEmptyOrRateLimited = status === 204 || status === 202;
			if (isEmptyOrRateLimited) {
				attempts.push({ provider: providerId, error: err, status });
				continue;
			}

			attempts.push({ provider: providerId, error: err, status });
		}
	}

	const errorMessages = attempts.map(a => {
		if (a.error instanceof SearchProviderError) {
			return `${a.provider}: ${a.error.message}`;
		}
		if (a.error) {
			return `${a.provider}: ${a.error.message}`;
		}
		return `${a.provider}: unknown error`;
	});

	const aggregated = `All web search providers failed (${CASCADE_ORDER.join(" → ")}): ${errorMessages.join("; ")}`;

	throw new SearchProviderError(lastProvider, aggregated);
}
