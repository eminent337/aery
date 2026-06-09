/**
 * Best-of-N selection — pick the highest-scoring candidate.
 *
 * Used by the agent loop when multiple tool outputs or thought chains
 * are generated, to surface the best one to the LLM.
 */

export interface Candidate<T = unknown> {
	id: string;
	content: T;
	score: number;
	metadata?: Record<string, unknown>;
}

export interface BestOfNConfig {
	/** Minimum score to be considered. Default: 0. */
	minScore?: number;
	/** Tie-breaker: prefer earlier if true, later if false. Default: true. */
	preferFirstOnTie?: boolean;
}

export class BestOfNSelector {
	readonly #config: BestOfNConfig;

	constructor(config: BestOfNConfig = {}) {
		this.#config = { minScore: 0, preferFirstOnTie: true, ...config };
	}

	select<T>(candidates: Candidate<T>[]): Candidate<T> | undefined {
		if (candidates.length === 0) return undefined;
		const filtered = candidates.filter(c => c.score >= (this.#config.minScore ?? 0));
		if (filtered.length === 0) return undefined;

		let best = filtered[0]!;
		for (let i = 1; i < filtered.length; i++) {
			const c = filtered[i]!;
			if (c.score > best.score) {
				best = c;
			} else if (c.score === best.score) {
				if (!(this.#config.preferFirstOnTie ?? true)) {
					best = c;
				}
			}
		}
		return best;
	}

	/** Return sorted candidates (descending score) for display/logging. */
	rank<T>(candidates: Candidate<T>[]): Candidate<T>[] {
		return [...candidates]
			.filter(c => c.score >= (this.#config.minScore ?? 0))
			.sort((a, b) => {
				if (b.score !== a.score) return b.score - a.score;
				return (this.#config.preferFirstOnTie ?? true) ? 0 : 0;
			});
	}
}
