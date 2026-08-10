/**
 * Code explorer tool — finds relevant files for a query via ripgrep, ranks
 * them by hit density and term breadth, and returns the top files.
 *
 * Ported from Freebuff's `file-explorer/` agent family:
 * - `code-searcher.ts` (ripgrep-style multi-query search) → per-term `rg` runs
 * - `file-picker.ts` / `file-picker-max.ts` (fuzzy relevance ranking over
 *   candidate paths) → hit-count × distinct-term scoring with a top-k cutoff.
 */

import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@aryee337/aery-core";
import * as z from "zod/v4";
import { type ExecOptions, type ExecResult, execCommand } from "../exec/exec";
import type { ToolSession } from ".";
import { ToolError } from "./tool-errors";

const exploreSchema = z.object({
	query: z
		.string()
		.describe(
			"A description of the files to find. Be somewhat broad — e.g. 'session auth token refresh logic and its tests' instead of 'find x'. Identifiers and symbol names are used as search terms.",
		),
	max_files: z
		.number()
		.int()
		.min(1)
		.max(25)
		.optional()
		.default(8)
		.describe("Maximum number of ranked files to return. Defaults to 8."),
	cwd: z
		.string()
		.optional()
		.describe("Optional working directory to search within. Defaults to the session working directory."),
});

export interface RankedFile {
	path: string;
	matches: number;
	terms: string[];
}

export interface ExploreDetails {
	query: string;
	terms: string[];
	files: RankedFile[];
	searchedDirs: string[];
}

export type ExploreExecFn = (
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
) => Promise<ExecResult>;

/** Words too generic to be useful search terms. */
const STOP_WORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"that",
	"this",
	"find",
	"files",
	"file",
	"code",
	"codebase",
	"related",
	"need",
	"want",
	"help",
	"which",
	"what",
	"where",
	"are",
	"its",
	"their",
	"them",
	"used",
	"using",
	"from",
	"into",
	"about",
	"logic",
	"function",
	"class",
	"implement",
]);

/**
 * Extract candidate ripgrep terms from a natural-language query.
 * Splits camelCase / snake_case / kebab-case identifiers into parts and keeps
 * meaningful tokens (len >= 3, not stop words).
 */
export function extractSearchTerms(query: string): string[] {
	const normalized = query.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
	const tokens = normalized
		.toLowerCase()
		.replace(/[^a-z0-9\s]+/g, " ")
		.split(/\s+/)
		.filter(token => token.length >= 3 && !STOP_WORDS.has(token));
	// Dedupe preserving first-seen order.
	const seen = new Set<string>();
	const terms: string[] = [];
	for (const token of tokens) {
		if (seen.has(token)) continue;
		seen.add(token);
		terms.push(token);
	}
	return terms;
}

/** Parse `rg -c` output lines `path:count` into a per-file count map. */
export function parseRgCountOutput(stdout: string): { path: string; count: number }[] {
	const results: { path: string; count: number }[] = [];
	for (const line of stdout.split("\n")) {
		if (!line) continue;
		const colonIdx = line.lastIndexOf(":");
		if (colonIdx <= 0) continue;
		const count = Number.parseInt(line.slice(colonIdx + 1), 10);
		const filePath = line.slice(0, colonIdx);
		if (filePath && !Number.isNaN(count)) {
			results.push({ path: filePath, count });
		}
	}
	return results;
}

/**
 * Rank candidate files: score = total raw matches + 3 points per distinct term
 * matched. Sorts descending, ties broken by path length (shorter paths first).
 */
export function rankFilesByRelevance(
	fileHits: Map<string, { matches: number; terms: Set<string> }>,
	maxFiles: number,
): RankedFile[] {
	const ranked = Array.from(fileHits.entries())
		.map(([filePath, hit]) => ({
			path: filePath,
			matches: hit.matches,
			terms: Array.from(hit.terms).sort(),
			score: hit.matches + 3 * hit.terms.size,
		}))
		.sort((a, b) => b.score - a.score || a.path.length - b.path.length)
		.slice(0, maxFiles);
	return ranked.map(({ path, matches, terms }) => ({ path, matches, terms }));
}

export class ExploreTool implements AgentTool<typeof exploreSchema, ExploreDetails> {
	readonly loadMode = "discoverable" as const;
	readonly name = "explore";
	readonly approval = "read" as const;
	readonly label = "Code Explorer";
	readonly summary = "Finds and ranks the most relevant files for a query using ripgrep term search.";
	readonly description =
		"Searches the codebase with ripgrep for terms extracted from a natural-language query, then ranks matching files by hit density and term breadth, returning the most relevant paths (with per-file match counts and matched terms). Use before reading files to avoid dumping unrelated context.";
	readonly parameters = exploreSchema;

	#session?: ToolSession;
	#exec: ExploreExecFn;

	constructor(sessionOrExecOverride?: ToolSession | ExploreExecFn) {
		if (typeof sessionOrExecOverride === "function") {
			this.#exec = sessionOrExecOverride;
		} else {
			this.#session = sessionOrExecOverride;
			this.#exec = execCommand;
		}
	}

	async execute(
		_toolCallId: string,
		params: z.infer<typeof exploreSchema>,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ExploreDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ExploreDetails>> {
		const query = params.query.trim();
		if (!query) throw new ToolError("explore: query is required and must not be empty.");
		const cwd = params.cwd ?? this.#session?.cwd ?? ".";
		const terms = extractSearchTerms(query);
		if (terms.length === 0) throw new ToolError("explore: could not extract any search terms from the query.");

		const fileHits = new Map<string, { matches: number; terms: Set<string> }>();
		for (const term of terms) {
			// Phase 1: find files containing the term.
			const listResult = await this.#exec("rg", ["-l", "-i", "--no-messages", term, cwd], cwd);
			if (listResult.code !== 0) continue; // no matches for this term (or rg missing)
			const files = listResult.stdout.split("\n").filter(Boolean);
			if (files.length === 0) continue;

			// Phase 2: per-file match counts for the candidate set.
			const countResult = await this.#exec(
				"rg",
				["-c", "-i", "--no-messages", term, ...(params.cwd ? [cwd] : [])],
				cwd,
			);
			const counts = parseRgCountOutput(countResult.stdout);
			const countByFile = new Map(counts.map(entry => [entry.path, entry.count]));

			for (const file of files) {
				const entry = fileHits.get(file) ?? { matches: 0, terms: new Set<string>() };
				entry.matches += countByFile.get(file) ?? 1;
				entry.terms.add(term);
				fileHits.set(file, entry);
			}
		}

		if (fileHits.size === 0) {
			return {
				content: [
					{ type: "text", text: `explore: no files matched any of the terms [${terms.join(", ")}] in ${cwd}.` },
				],
				details: { query, terms, files: [], searchedDirs: [cwd] },
			};
		}

		const files = rankFilesByRelevance(fileHits, params.max_files ?? 8);
		const details: ExploreDetails = { query, terms, files, searchedDirs: [cwd] };

		const lines = [
			`Code explorer — ${files.length} ranked file(s) for query "${query}" (terms: ${terms.join(", ")}):\n`,
		];
		for (const file of files) {
			lines.push(
				`${file.path}  (${file.matches} match${file.matches === 1 ? "" : "es"}, terms: ${file.terms.join(", ")})`,
			);
		}
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details,
		};
	}
}
