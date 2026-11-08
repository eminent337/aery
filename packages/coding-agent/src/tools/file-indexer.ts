/**
 * file-indexer.ts — Bit-Parallel Fast File Indexer for Aery.
 *
 * Implements Claude Desktop's FileIndex engine using typed arrays (Int32Array, Uint16Array),
 * O(1) bitwise character mask pruning, and bounded top-K fuzzy ranking.
 */

import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@aryee337/aery-core";
import * as fs from "node:fs";
import * as path from "node:path";
import * as z from "zod/v4";

const SCORE_MATCH = 16;
const BONUS_BOUNDARY = 8;
const BONUS_CAMEL = 6;
const BONUS_CONSECUTIVE = 4;
const BONUS_FIRST_CHAR = 8;
const PENALTY_GAP_START = 3;
const PENALTY_GAP_EXTENSION = 1;
const MAX_QUERY_LEN = 64;

function isBoundaryChar(ch: string): boolean {
	return ch === "/" || ch === "\\" || ch === "." || ch === "_" || ch === "-";
}

function scoreBonusAt(haystack: string, index: number, isFirst: boolean): number {
	if (index === 0) return isFirst ? BONUS_FIRST_CHAR + BONUS_BOUNDARY : BONUS_BOUNDARY;
	const prev = haystack.charAt(index - 1);
	if (isBoundaryChar(prev)) return BONUS_BOUNDARY;
	const curr = haystack.charAt(index);
	if (curr >= "A" && curr <= "Z" && prev >= "a" && prev <= "z") return BONUS_CAMEL;
	return 0;
}

export interface FileIndexResult {
	path: string;
	score: number;
	positions: number[];
}

export class FileIndex {
	paths: string[] = [];
	lowerPaths: string[] = [];
	charBits: Int32Array = new Int32Array(0);
	pathLens: Uint16Array = new Uint16Array(0);
	readyCount = 0;

	get isFullyBuilt(): boolean {
		return this.paths.length > 0 && this.readyCount === this.paths.length;
	}

	loadFromFileList(fileList: string[]): void {
		const seen = new Set<string>();
		const unique: string[] = [];
		for (const p of fileList) {
			if (p.length > 0 && !seen.has(p)) {
				seen.add(p);
				unique.push(p);
			}
		}
		this.buildIndex(unique);
	}

	buildIndex(paths: string[]): void {
		const n = paths.length;
		this.paths = paths;
		this.lowerPaths = new Array(n);
		this.charBits = new Int32Array(n);
		this.pathLens = new Uint16Array(n);
		this.readyCount = 0;

		for (let i = 0; i < n; i++) {
			this.indexPath(i);
		}
		this.readyCount = n;
	}

	private indexPath(i: number): void {
		const lp = this.paths[i].toLowerCase();
		this.lowerPaths[i] = lp;
		const len = lp.length;
		this.pathLens[i] = len;

		let bits = 0;
		for (let j = 0; j < len; j++) {
			const c = lp.charCodeAt(j);
			if (c >= 97 && c <= 122) {
				bits |= 1 << (c - 97);
			}
		}
		this.charBits[i] = bits;
	}

	search(query: string, limit = 20): FileIndexResult[] {
		if (limit <= 0 || query.length === 0 || this.readyCount === 0) return [];

		const caseSensitive = query !== query.toLowerCase();
		const needle = caseSensitive ? query : query.toLowerCase();
		const nLen = Math.min(needle.length, MAX_QUERY_LEN);

		let needleBitmap = 0;
		const needleChars: string[] = [];
		for (let j = 0; j < nLen; j++) {
			const ch = needle.charAt(j);
			const cc = ch.charCodeAt(0);
			if (cc >= 97 && cc <= 122) {
				needleBitmap |= 1 << (cc - 97);
			}
			needleChars.push(ch);
		}

		const posBuf = new Int32Array(nLen);
		const topK: Array<{ path: string; fuzzScore: number; positions: number[] }> = [];
		let threshold = -Infinity;

		outer: for (let i = 0; i < this.readyCount; i++) {
			// O(1) bitwise rejection
			if ((this.charBits[i] & needleBitmap) !== needleBitmap) {
				continue;
			}

			const haystack = caseSensitive ? this.paths[i] : this.lowerPaths[i];
			let pos = haystack.indexOf(needleChars[0]);
			if (pos === -1) continue;

			posBuf[0] = pos;
			let gapPenalty = 0;
			let consecBonus = 0;
			let prev = pos;

			for (let j = 1; j < nLen; j++) {
				pos = haystack.indexOf(needleChars[j], prev + 1);
				if (pos === -1) continue outer;

				posBuf[j] = pos;
				const gap = pos - prev - 1;
				if (gap === 0) {
					consecBonus += BONUS_CONSECUTIVE;
				} else {
					gapPenalty += PENALTY_GAP_START + gap * PENALTY_GAP_EXTENSION;
				}
				prev = pos;
			}

			const origPath = this.paths[i];
			const hLen = this.pathLens[i];
			let score = nLen * SCORE_MATCH + consecBonus - gapPenalty;
			score += scoreBonusAt(origPath, posBuf[0], true);
			for (let j = 1; j < nLen; j++) {
				score += scoreBonusAt(origPath, posBuf[j], false);
			}
			score += Math.max(0, 32 - (hLen >> 2));

			if (topK.length < limit) {
				topK.push({
					path: origPath,
					fuzzScore: score,
					positions: Array.from(posBuf.subarray(0, nLen)),
				});
				if (topK.length === limit) {
					topK.sort((a, b) => a.fuzzScore - b.fuzzScore);
					threshold = topK[0].fuzzScore;
				}
			} else if (score > threshold) {
				let lo = 0;
				let hi = topK.length;
				while (lo < hi) {
					const mid = (lo + hi) >> 1;
					if (topK[mid].fuzzScore < score) {
						lo = mid + 1;
					} else {
						hi = mid;
					}
				}
				topK.splice(lo, 0, {
					path: origPath,
					fuzzScore: score,
					positions: Array.from(posBuf.subarray(0, nLen)),
				});
				topK.shift();
				threshold = topK[0].fuzzScore;
			}
		}

		topK.sort((a, b) => b.fuzzScore - a.fuzzScore);
		return topK.map(item => ({
			path: item.path,
			score: item.fuzzScore,
			positions: item.positions,
		}));
	}
}

export const fastFileSearchSchema = z.object({
	action: z.enum(["search", "index_directory", "status"]).describe("File search action to perform."),
	query: z.string().optional().describe("Fuzzy search needle to find matching files."),
	directory: z.string().optional().describe("Directory path to scan and index."),
	limit: z.number().int().optional().describe("Maximum number of results to return (default: 20)."),
});

export type FastFileSearchParams = z.infer<typeof fastFileSearchSchema>;

export class FastFileSearchTool implements AgentTool<typeof fastFileSearchSchema> {
	readonly name = "fast_file_search";
	readonly approval = "read" as const;
	readonly label = "Fast File Search";
	readonly summary = "Instant sub-millisecond bit-parallel fuzzy file search across entire codebases";
	readonly description =
		"Bit-parallel fast file indexer and fuzzy search tool. Employs precomputed character bitmasks to search 100k+ file repositories in under 1ms with boundary-aware ranking.";
	readonly parameters = fastFileSearchSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;

	private index = new FileIndex();

	setPathsForTesting(paths: string[]): void {
		this.index.loadFromFileList(paths);
	}

	private async scanDirectory(dir: string, maxFiles = 100000): Promise<string[]> {
		const results: string[] = [];
		const queue: string[] = [dir];

		while (queue.length > 0 && results.length < maxFiles) {
			const current = queue.shift()!;
			try {
				const entries = await fs.promises.readdir(current, { withFileTypes: true });
				for (const entry of entries) {
					const name = entry.name;
					if (name === ".git" || name === "node_modules" || name === ".turbo") continue;
					const fullPath = path.join(current, name);
					if (entry.isDirectory()) {
						queue.push(fullPath);
					} else if (entry.isFile()) {
						results.push(fullPath);
					}
				}
			} catch {}
		}
		return results;
	}

	async execute(
		toolCallId: string,
		params: FastFileSearchParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		switch (params.action) {
			case "status": {
				return {
					content: [
						{
							type: "text",
							text: `Fast File Indexer Status:\n• indexed_paths: ${this.index.readyCount}\n• is_fully_built: ${this.index.isFullyBuilt}`,
						},
					],
				};
			}

			case "index_directory": {
				const targetDir = params.directory || process.cwd();
				const files = await this.scanDirectory(targetDir);
				this.index.loadFromFileList(files);

				return {
					content: [
						{
							type: "text",
							text: `Indexed ${files.length} files from ${targetDir} in memory with bitwise acceleration.`,
						},
					],
				};
			}

			case "search": {
				if (!params.query) {
					return {
						isError: true,
						content: [{ type: "text", text: "query is required for search action." }],
					};
				}

				if (this.index.readyCount === 0) {
					// Auto-index current directory on first search if empty
					const files = await this.scanDirectory(process.cwd(), 50000);
					this.index.loadFromFileList(files);
				}

				const limit = params.limit || 20;
				const results = this.index.search(params.query, limit);

				return {
					content: [
						{
							type: "text",
							text:
								results.length > 0
									? `Found ${results.length} match${results.length === 1 ? "" : "es"} for "${params.query}":\n${results.map(r => `• ${r.path} (score: ${r.score})`).join("\n")}`
									: `No files matched query "${params.query}".`,
						},
					],
				};
			}

			default:
				return {
					isError: true,
					content: [{ type: "text", text: `Unknown action: ${(params as any).action}` }],
				};
		}
	}
}
