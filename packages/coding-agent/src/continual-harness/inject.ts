/**
 * Continual Harness — context injection.
 *
 * Pure helpers that turn harness state into a `<harness>` block the agent
 * sees at the start of a session. This is the *read* side of the continual
 * loop: refinements are persisted by the engine, and this module surfaces
 * them back into the working context.
 */
import { truncateApproxTokens } from "../mnemopi/config.js";
import type { HarnessEntry, HarnessState, RefinementKind } from "./types.js";

/** Kinds surfaced in the injected block, in display order. */
export const INJECTION_KINDS: readonly RefinementKind[] = ["prompt", "memory", "skill", "subagent"];

/** Cap on entries rendered per kind before the token cap kicks in. */
const MAX_ENTRIES_PER_KIND = 8;

/** Default minimum relevance score for an entry to be injected. */
export const DEFAULT_MIN_SCORE = 1;

/** Default minimum relevance threshold (entries scoring below this are excluded). */
export const DEFAULT_THRESHOLD = 2;

/**
 * Log an injection event for debugging.
 */
export function logInjectionEvent(message: string, data?: Record<string, unknown>): void {
	const timestamp = new Date().toISOString();
	const logLine = `[harness-inject] ${timestamp} ${message}`;
	console.debug(logLine, ...(data ? [data] : []));
}

/**
 * Render a single harness entry as an injectable line.
 */
export function formatHarnessEntry(entry: HarnessEntry): string {
	const kind = entry.kind;
	const title = entry.title || entry.id;
	if (kind === "skill") {
		const ref = entry.reference && typeof entry.reference === "object" ? entry.reference : {};
		const args = entry.arguments && typeof entry.arguments === "object" ? entry.arguments : {};
		return `- skill "${title}": ${entry.content}${Object.keys(ref).length ? ` (reference: ${JSON.stringify(ref)})` : ""}${Object.keys(args).length ? ` (args: ${JSON.stringify(args)})` : ""}`;
	}
	return `- ${kind} "${title}": ${entry.content}`;
}

/**
 * Build the `<harness>` block from a harness state.
 *
 * - Empty state → `undefined` (nothing to inject).
 * - Entries are rendered per kind (prompt, memory, skill, subagent) in
 *   display order, capped at MAX_ENTRIES_PER_KIND per kind.
 * - The whole block is token-capped with `truncateApproxTokens`; a cap of 0
 *   means no cap.
 */
export function buildHarnessBlock(state: HarnessState, tokenLimit: number): string | undefined {
	const sections: string[] = [];
	for (const kind of INJECTION_KINDS) {
		const entries = Object.values(state.entries[kind]);
		if (entries.length === 0) continue;
		const shown = entries.slice(0, MAX_ENTRIES_PER_KIND);
		const lines = shown.map(formatHarnessEntry);
		if (entries.length > shown.length) {
			lines.push(`  … and ${entries.length - shown.length} more`);
		}
		sections.push(`## ${kind[0].toUpperCase()}${kind.slice(1)} entries\n${lines.join("\n")}`);
	}
	if (sections.length === 0) return undefined;
	let block = `<harness>\n${sections.join("\n\n")}\n</harness>`;
	if (tokenLimit > 0) {
		block = truncateApproxTokens(block, tokenLimit);
	}
	return block;
}
/**
 * Build the `<harness>` block from a pre-selected list of entries (e.g. the
 * output of `recallHarnessEntries`). Same rendering + token-cap rules as
 * `buildHarnessBlock`.
 */
export function buildHarnessBlockFromEntries(entries: HarnessEntry[], tokenLimit: number): string | undefined {
	if (entries.length === 0) return undefined;
	const byKind = new Map<RefinementKind, HarnessEntry[]>();
	for (const entry of entries) {
		const list = byKind.get(entry.kind) ?? [];
		list.push(entry);
		byKind.set(entry.kind, list);
	}
	const sections: string[] = [];
	for (const kind of INJECTION_KINDS) {
		const kindEntries = byKind.get(kind) ?? [];
		if (kindEntries.length === 0) continue;
		const lines = kindEntries.map(formatHarnessEntry);
		sections.push(`## ${kind[0].toUpperCase()}${kind.slice(1)} entries\n${lines.join("\n")}`);
	}
	if (sections.length === 0) return undefined;
	let block = `<harness>\n${sections.join("\n\n")}\n</harness>`;
	if (tokenLimit > 0) {
		block = truncateApproxTokens(block, tokenLimit);
	}
	return block;
}
/**
 * Recall-aware block builder: score entries against `query` (the user's
 * current prompt) and inject only the relevant ones. Falls back to the
 * top-N block when the query yields no matches (e.g. first turn with an
 * empty prompt).
 */
export function buildHarnessRecallBlock(
	state: HarnessState,
	query: string,
	tokenLimit: number,
	minScore = DEFAULT_MIN_SCORE,
	threshold = DEFAULT_THRESHOLD,
): string | undefined {
	if (query) {
		const recalled = recallHarnessEntries(state, query, tokenLimit, minScore, threshold);
		if (recalled.length > 0) {
			logInjectionEvent("recall-block", { count: recalled.length, query: query.slice(0, 50) });
			return buildHarnessBlockFromEntries(recalled, tokenLimit);
		}
	}
	const block = buildHarnessBlock(state, tokenLimit);
	if (block) {
		logInjectionEvent("fallback-block", { count: Object.values(state.entries).flat().length });
	}
	return block;
}

/**
 * Score a single entry against a query (the user's latest prompt).
 *
 * Simple lexical scoring over title + content. Higher is more relevant.
 */
export function scoreHarnessEntry(entry: HarnessEntry, query: string): number {
	if (!query) return 0;
	const q = query.toLowerCase();
	let score = 0;
	// Title hits are worth more than body hits.
	const title = (entry.title || "").toLowerCase();
	if (title && q.includes(title)) score += 3;
	// Per-word matches in title.
	for (const word of title.split(/\W+/).filter(w => w.length > 2)) {
		if (q.includes(word)) score += 1;
	}
	const content = (entry.content || "").toLowerCase();
	for (const word of q.split(/\W+/).filter(w => w.length > 3)) {
		if (content.includes(word)) score += 1;
	}
	return score;
}

/**
 * Pick the most relevant entries for a query, capped by token limit.
 *
 * Returns entries that scored >= threshold, sorted by score desc, then filtered by
 * the token cap (0 = no cap). If nothing scores above threshold, returns [].
 */
export function recallHarnessEntries(
	state: HarnessState,
	query: string,
	tokenLimit: number,
	minScore = DEFAULT_MIN_SCORE,
	threshold = DEFAULT_THRESHOLD,
): HarnessEntry[] {
	if (!query) return [];
	const scored: { entry: HarnessEntry; score: number }[] = [];
	for (const kind of INJECTION_KINDS) {
		for (const entry of Object.values(state.entries[kind])) {
			const score = scoreHarnessEntry(entry, query);
			if (score >= threshold) scored.push({ entry, score });
		}
	}
	scored.sort((a, b) => b.score - a.score);
	const selected: HarnessEntry[] = [];
	let usedChars = 0;
	const maxChars = tokenLimit > 0 ? tokenLimit * 4 : Number.POSITIVE_INFINITY;
	for (const { entry } of scored) {
		const rendered = formatHarnessEntry(entry);
		if (usedChars + rendered.length > maxChars && selected.length > 0) break;
		selected.push(entry);
		usedChars += rendered.length;
	}
	return selected;
}
