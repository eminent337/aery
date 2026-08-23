/**
 * Conversation search — BM25 search over the active session's transcript.
 *
 * Ported from jcode upstream (crates/jcode-app-core/src/tool/conversation_search.rs)
 * with a real BM25 implementation (jcode used case-insensitive substring match).
 * Searches all user and assistant messages in the current session, returning
 * relevance-ranked snippets.
 */

import type { AgentMessage, AgentTool, AgentToolResult } from "@aryee337/aery-core";
import { untilAborted } from "@aryee337/aery-utils";
import * as z from "zod/v4";
import conversationSearchDescription from "../prompts/tools/conversation-search.md" with { type: "text" };
import { loadSessionMessagesReadOnly } from "../session/session-manager";
import type { ToolSession } from "./index";

const conversationSearchSchema = z.object({
	query: z.string().describe("Natural language search query"),
	maxResults: z.number().int().min(1).max(50).optional().describe("Max results to return (default 10)"),
});

export type ConversationSearchParams = z.infer<typeof conversationSearchSchema>;

interface SearchResult {
	turn: number;
	role: string;
	score: number;
	snippet: string;
}

/** Extract plain text from an AgentMessage for indexing. */
function extractMessageText(msg: AgentMessage): string {
	switch (msg.role) {
		case "bashExecution":
			return `${msg.command}\n${msg.output}`;
		case "pythonExecution":
			return `${msg.code}\n${msg.output}`;
		case "fileMention":
			return msg.files.map(f => `${f.path}\n${f.content}`).join("\n");
		case "branchSummary":
		case "compactionSummary":
			return msg.summary ?? "";
		default: {
			// UserMessage, AssistantMessage, ToolResultMessage, CustomMessage, HookMessage
			const content = (msg as { content?: unknown }).content;
			if (typeof content === "string") return content;
			if (!Array.isArray(content)) return "";
			const parts: string[] = [];
			for (const block of content) {
				if (block && typeof block === "object" && "type" in block && "text" in block) {
					parts.push((block as { text: string }).text);
				}
			}
			return parts.join("\n");
		}
	}
}

/** Build a term-frequency map from a document. */
function termFrequency(text: string): Map<string, number> {
	const tf = new Map<string, number>();
	const tokens = text.toLowerCase().match(/[\w]+/g);
	if (!tokens) return tf;
	for (const token of tokens) {
		tf.set(token, (tf.get(token) ?? 0) + 1);
	}
	return tf;
}

/**
 * BM25 scoring.
 *
 * Standard Okapi BM25: score(D, q) = Σ IDF(qi) · (f(qi, D) · (k1 + 1)) / (f(qi, D) + k1 · (1 - b + b · |D| / avgdl))
 */
function bm25Score(
	queryTerms: string[],
	docTf: Map<string, number>,
	docLen: number,
	avgdl: number,
	idfCache: Map<string, number>,
	k1 = 1.2,
	b = 0.75,
): number {
	let score = 0;
	for (const term of queryTerms) {
		const f = docTf.get(term) ?? 0;
		if (f === 0) continue;
		const cached = idfCache.get(term);
		if (cached === undefined) continue;
		const numerator = f * (k1 + 1);
		const denominator = f + k1 * (1 - b + b * (docLen / avgdl));
		score += cached * (numerator / denominator);
	}
	return score;
}

function idf(term: string, docTfs: Map<string, number>[], docCount: number): number {
	let docsWithTerm = 0;
	for (const tf of docTfs) {
		if (tf.has(term)) docsWithTerm++;
	}
	return Math.log(1 + (docCount - docsWithTerm + 0.5) / (docsWithTerm + 0.5));
}

/** Extract a ±charRadius snippet around the first occurrence of any query term. */
function extractSnippet(text: string, queryTerms: string[], radius = 60): string {
	const lower = text.toLowerCase();
	let firstPos = -1;
	for (const term of queryTerms) {
		const pos = lower.indexOf(term);
		if (pos !== -1 && (firstPos === -1 || pos < firstPos)) {
			firstPos = pos;
		}
	}
	if (firstPos === -1) {
		return text.slice(0, radius * 2).trim();
	}
	const start = Math.max(0, firstPos - radius);
	const end = Math.min(text.length, firstPos + radius);
	let snippet = text.slice(start, end).trim();
	if (start > 0) snippet = `...${snippet}`;
	if (end < text.length) snippet = `${snippet}...`;
	return snippet;
}

/** Tokenize a query for BM25 scoring. */
function tokenize(text: string): string[] {
	return text.toLowerCase().match(/[\w]+/g) ?? [];
}

function searchMessages(messages: AgentMessage[], query: string, maxResults: number): SearchResult[] {
	const queryTerms = tokenize(query);
	if (queryTerms.length === 0 || messages.length === 0) return [];

	const docTfs: Map<string, number>[] = [];
	const docTexts: string[] = [];
	const docRoles: string[] = [];
	let totalLen = 0;

	for (const msg of messages) {
		const text = extractMessageText(msg);
		docTexts.push(text);
		docTfs.push(termFrequency(text));
		docRoles.push(msg.role);
		totalLen += text.length;
	}

	const avgdl = totalLen / messages.length || 1;
	const docCount = messages.length;
	const idfCache = new Map<string, number>();
	for (const term of queryTerms) {
		idfCache.set(term, idf(term, docTfs, docCount));
	}

	const results: SearchResult[] = [];
	for (let i = 0; i < messages.length; i++) {
		const score = bm25Score(queryTerms, docTfs[i], docTexts[i].length, avgdl, idfCache);
		if (score > 0) {
			results.push({
				turn: i,
				role: docRoles[i],
				score,
				snippet: extractSnippet(docTexts[i], queryTerms),
			});
		}
	}

	results.sort((a, b) => b.score - a.score);
	return results.slice(0, maxResults);
}

export class ConversationSearchTool implements AgentTool<typeof conversationSearchSchema> {
	readonly name = "conversation_search";
	readonly approval = "read" as const;
	readonly label = "ConvSearch";
	readonly description = conversationSearchDescription;
	readonly parameters = conversationSearchSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "BM25 search over the active session's conversation transcript";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): ConversationSearchTool | null {
		return new ConversationSearchTool(session);
	}

	async execute(_id: string, params: ConversationSearchParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const sessionFile = this.session.getSessionFile();
			if (!sessionFile) {
				return {
					content: [{ type: "text", text: "No session file available for conversation search." }],
					details: { error: "no_session_file" },
				};
			}

			const messages = await loadSessionMessagesReadOnly(sessionFile);
			if (messages.length === 0) {
				return {
					content: [{ type: "text", text: "Conversation is empty — no messages to search." }],
					details: { totalMessages: 0 },
				};
			}

			const maxResults = params.maxResults ?? 10;
			const results = searchMessages(messages, params.query, maxResults);

			if (results.length === 0) {
				return {
					content: [
						{ type: "text", text: `No results found for '${params.query}' in ${messages.length} messages.` },
					],
					details: { totalMessages: messages.length, results: 0 },
				};
			}

			const lines: string[] = [
				`## Search Results for '${params.query}'\n\nFound ${results.length} match(es) across ${messages.length} messages:\n`,
			];
			for (const result of results) {
				lines.push(`**Message ${result.turn} (${result.role}, score ${result.score.toFixed(2)}):**`);
				lines.push(`${result.snippet}\n`);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					totalMessages: messages.length,
					results: results.length,
					topScore: results[0]?.score ?? 0,
				},
			};
		});
	}
}

export { bm25Score, extractMessageText, extractSnippet, searchMessages, tokenize };
