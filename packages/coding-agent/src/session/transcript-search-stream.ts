/**
 * Streaming JSONL Transcript Search Engine.
 *
 * Implements high-throughput, low-memory scanning of transcript files
 * using buffer slicing and readline streams.
 */

import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as readline from "node:readline";

export interface TranscriptSearchOptions {
	filePath: string;
	query: string | RegExp;
	startOffset?: number;
	maxResults?: number;
	contextChars?: number;
}

export interface TranscriptSearchResult {
	turnIndex: number;
	role: string;
	timestamp: string;
	snippet: string;
	context: string;
	content?: string;
}

export type SearchTranscriptPromise = Promise<TranscriptSearchResult[]> & AsyncIterable<TranscriptSearchResult>;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSearchMatcher(query: string | RegExp): {
	exec: (text: string) => { index: number; length: number } | null;
} {
	if (typeof query === "string") {
		const lowerQuery = query.toLowerCase();
		return {
			exec: (text: string) => {
				const idx = text.toLowerCase().indexOf(lowerQuery);
				if (idx === -1) {
					return null;
				}
				return { index: idx, length: query.length };
			},
		};
	}

	const flags = new Set(query.flags.split(""));
	flags.delete("g");
	flags.delete("y");
	const regex = new RegExp(query.source, Array.from(flags).join(""));

	return {
		exec: (text: string) => {
			const match = regex.exec(text);
			if (!match) {
				return null;
			}
			return { index: match.index, length: match[0].length };
		},
	};
}

function extractSnippet(text: string, matchIndex: number, matchLength: number, window = 40): string {
	const start = Math.max(0, matchIndex - window);
	const end = Math.min(text.length, matchIndex + matchLength + window);
	let snippet = text.slice(start, end).replace(/\r?\n/g, " ");
	if (start > 0) {
		snippet = `...${snippet}`;
	}
	if (end < text.length) {
		snippet = `${snippet}...`;
	}
	return snippet;
}

function extractTurnIndex(parsed: Record<string, unknown>, fallbackIndex: number): number {
	if (typeof parsed.step_index === "number") {
		return parsed.step_index;
	}
	if (typeof parsed.turnIndex === "number") {
		return parsed.turnIndex;
	}
	if (typeof parsed.turn_index === "number") {
		return parsed.turn_index;
	}
	if (typeof parsed.turn === "number") {
		return parsed.turn;
	}
	return fallbackIndex;
}

function extractRole(parsed: Record<string, unknown>): string {
	if (typeof parsed.role === "string" && parsed.role.length > 0) {
		return parsed.role;
	}
	if (typeof parsed.source === "string" && parsed.source.length > 0) {
		return parsed.source;
	}
	if (typeof parsed.type === "string" && parsed.type.length > 0) {
		return parsed.type;
	}
	return "unknown";
}

function extractTimestamp(parsed: Record<string, unknown>): string {
	if (typeof parsed.timestamp === "string") {
		return parsed.timestamp;
	}
	if (typeof parsed.created_at === "string") {
		return parsed.created_at;
	}
	if (typeof parsed.createdAt === "string") {
		return parsed.createdAt;
	}
	return "";
}

function collectSearchCandidates(
	parsed: Record<string, unknown>,
	rawLine: string
): Array<{ text: string; isPrimary: boolean }> {
	const candidates: Array<{ text: string; isPrimary: boolean }> = [];

	if (typeof parsed.content === "string") {
		candidates.push({ text: parsed.content, isPrimary: true });
	} else if (Array.isArray(parsed.content)) {
		const extracted = parsed.content
			.map((entry) => {
				if (typeof entry === "string") {
					return entry;
				}
				if (entry && typeof entry === "object" && "text" in entry && typeof entry.text === "string") {
					return entry.text;
				}
				return "";
			})
			.filter(Boolean)
			.join("\n");
		if (extracted) {
			candidates.push({ text: extracted, isPrimary: true });
		}
	}

	if (typeof parsed.thinking === "string") {
		candidates.push({ text: parsed.thinking, isPrimary: false });
	}

	if (typeof parsed.text === "string") {
		candidates.push({ text: parsed.text, isPrimary: true });
	}

	if (Array.isArray(parsed.tool_calls)) {
		try {
			candidates.push({ text: JSON.stringify(parsed.tool_calls), isPrimary: false });
		} catch {}
	}

	candidates.push({ text: rawLine, isPrimary: false });
	return candidates;
}

/**
 * Safely opens a transcript file without following symlinks.
 * Throws code ELOOP if path is a symlink or directory.
 */
export async function openTranscriptNoFollow(filePath: string): Promise<fs.FileHandle> {
	let lstat: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		lstat = await fs.lstat(filePath);
	} catch (err: unknown) {
		const error = err as NodeJS.ErrnoException;
		if (error.code === "ENOENT") {
			const notFound = new Error(`File not found: ${filePath}`);
			(notFound as NodeJS.ErrnoException).code = "ENOENT";
			throw notFound;
		}
		throw err;
	}

	if (lstat.isSymbolicLink()) {
		const symlinkErr = new Error(`Path is a symbolic link: ${filePath}`);
		(symlinkErr as NodeJS.ErrnoException).code = "ELOOP";
		throw symlinkErr;
	}

	if (lstat.isDirectory()) {
		const dirErr = new Error(`Path is a directory: ${filePath}`);
		(dirErr as NodeJS.ErrnoException).code = "ELOOP";
		throw dirErr;
	}

	const handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);

	try {
		const stat = await handle.stat();
		if (stat.isDirectory()) {
			await handle.close();
			const dirErr = new Error(`Path is a directory: ${filePath}`);
			(dirErr as NodeJS.ErrnoException).code = "ELOOP";
			throw dirErr;
		}
		return handle;
	} catch (err) {
		await handle.close();
		throw err;
	}
}

/**
 * Scans a JSONL file to locate the byte offset after the last compact_boundary record.
 * Uses buffer slicing to locate line offsets safely.
 */
export async function findLastCompactBoundaryOffset(filePath: string): Promise<number> {
	let handle: fs.FileHandle;
	try {
		handle = await openTranscriptNoFollow(filePath);
	} catch (err: unknown) {
		const error = err as NodeJS.ErrnoException;
		if (error.code === "ENOENT") {
			return 0;
		}
		throw err;
	}

	try {
		let lastBoundaryOffset = 0;
		let currentOffset = 0;
		let remainder = Buffer.alloc(0);
		const CHUNK_SIZE = 64 * 1024;
		const buffer = Buffer.alloc(CHUNK_SIZE);

		const inspectLine = (lineSlice: Buffer, lineEndOffset: number): void => {
			const text = lineSlice.toString("utf-8").trim();
			if (!text || !text.includes("compact_boundary")) {
				return;
			}
			try {
				const parsed = JSON.parse(text);
				if (
					parsed &&
					typeof parsed === "object" &&
					(parsed.type === "compact_boundary" ||
						parsed.kind === "compact_boundary" ||
						parsed.event === "compact_boundary")
				) {
					lastBoundaryOffset = lineEndOffset;
				}
			} catch {
				// Skip corrupted line
			}
		};

		while (true) {
			const { bytesRead } = await handle.read(buffer, 0, CHUNK_SIZE, null);
			if (bytesRead === 0) {
				break;
			}

			const chunk = buffer.subarray(0, bytesRead);
			const combined = remainder.length > 0 ? Buffer.concat([remainder, chunk]) : chunk;
			let lineStart = 0;

			for (let i = 0; i < combined.length; i++) {
				if (combined[i] === 0x0a) {
					const lineEnd = i;
					const lineSlice = combined.subarray(lineStart, lineEnd);
					const lineByteLength = lineEnd - lineStart + 1;
					const endOffsetOfLine = currentOffset + lineByteLength;

					inspectLine(lineSlice, endOffsetOfLine);

					currentOffset = endOffsetOfLine;
					lineStart = i + 1;
				}
			}

			if (lineStart < combined.length) {
				remainder = Buffer.from(combined.subarray(lineStart));
			} else {
				remainder = Buffer.alloc(0);
			}
		}

		if (remainder.length > 0) {
			const endOffsetOfLine = currentOffset + remainder.length;
			inspectLine(remainder, endOffsetOfLine);
		}

		return lastBoundaryOffset;
	} finally {
		await handle.close();
	}
}

async function executeStreamSearch(options: TranscriptSearchOptions): Promise<TranscriptSearchResult[]> {
	const { filePath, query, startOffset = 0, maxResults = Number.POSITIVE_INFINITY } = options;

	if (maxResults <= 0) {
		return [];
	}

	let handle: fs.FileHandle;
	try {
		handle = await openTranscriptNoFollow(filePath);
	} catch (err: unknown) {
		const error = err as NodeJS.ErrnoException;
		if (error.code === "ENOENT") {
			return [];
		}
		throw err;
	}

	const results: TranscriptSearchResult[] = [];
	const matcher = buildSearchMatcher(query);

	try {
		const stat = await handle.stat();
		if (stat.size === 0 || startOffset >= stat.size) {
			return [];
		}

		const stream = handle.createReadStream({ start: startOffset });
		const rl = readline.createInterface({
			input: stream,
			crlfDelay: Number.POSITIVE_INFINITY,
		});

		let lineIndex = 0;
		for await (const rawLine of rl) {
			lineIndex++;
			const trimmed = rawLine.trim();
			if (!trimmed) {
				continue;
			}

			let parsed: Record<string, unknown> | null = null;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				// Corrupted line, continue to next line
				continue;
			}

			if (!parsed || typeof parsed !== "object") {
				continue;
			}

			const candidates = collectSearchCandidates(parsed, trimmed);
			let matchedCandidate: { text: string; matchIndex: number; matchLength: number } | null = null;

			for (const candidate of candidates) {
				const match = matcher.exec(candidate.text);
				if (match) {
					matchedCandidate = {
						text: candidate.text,
						matchIndex: match.index,
						matchLength: match.length,
					};
					break;
				}
			}

			if (!matchedCandidate) {
				continue;
			}

			const snippet = extractSnippet(
				matchedCandidate.text,
				matchedCandidate.matchIndex,
				matchedCandidate.matchLength
			);

			const context =
				typeof parsed.content === "string"
					? parsed.content
					: matchedCandidate.text;

			results.push({
				turnIndex: extractTurnIndex(parsed, lineIndex),
				role: extractRole(parsed),
				timestamp: extractTimestamp(parsed),
				snippet,
				context,
				content: typeof parsed.content === "string" ? parsed.content : undefined,
			});

			if (results.length >= maxResults) {
				rl.close();
				break;
			}
		}

		return results;
	} finally {
		await handle.close();
	}
}

function createSearchPromise(
	execute: () => Promise<TranscriptSearchResult[]>
): SearchTranscriptPromise {
	const promise = execute() as SearchTranscriptPromise;
	promise[Symbol.asyncIterator] = async function* () {
		const results = await promise;
		for (const r of results) {
			yield r;
		}
	};
	return promise;
}

export function streamSearchTranscript(options: TranscriptSearchOptions): SearchTranscriptPromise;
export function streamSearchTranscript(
	filePath: string,
	query: string | RegExp,
	options?: Omit<TranscriptSearchOptions, "filePath" | "query">
): SearchTranscriptPromise;
export function streamSearchTranscript(
	param1: string | TranscriptSearchOptions,
	param2?: string | RegExp,
	param3?: Omit<TranscriptSearchOptions, "filePath" | "query">
): SearchTranscriptPromise {
	const normalizedOptions: TranscriptSearchOptions =
		typeof param1 === "string"
			? {
					filePath: param1,
					query: param2 as string | RegExp,
					...param3,
			  }
			: param1;

	return createSearchPromise(() => executeStreamSearch(normalizedOptions));
}
