/**
 * ObservationDistiller provides fast heuristic and semantic classification
 * for capturing observations from agent turns.
 *
 * See file:///home/aryee/aery/ai_agent/docs/superpowers/specs/2026-11-08-progressive-memory-engine-design.md
 */

import * as path from "node:path";
import type { InsertObservationParams, ObservationCategory } from "./types";

export interface ToolExecutionRecord {
	toolName: string;
	params?: Record<string, unknown>;
	resultText?: string;
	isError?: boolean;
}

export interface DistillTurnInput {
	sessionId: string;
	entryId?: string | null;
	turnIndex: number;
	userPrompt?: string;
	assistantText?: string;
	assistantThinking?: string;
	toolExecutions?: ToolExecutionRecord[];
}

const FILE_EDIT_TOOLS = new Set(["write", "write_file", "edit", "edit_file", "ast_edit"]);

const COMMAND_TOOLS = new Set(["run_command", "bash", "terminal", "exec"]);

const TEST_RUNNER_PATTERN =
	/\b(?:bun\s+test|npm\s+test|pnpm\s+test|yarn\s+test|pytest|vitest|jest|cargo\s+test|go\s+test)\b/i;

const PACKAGE_INSTALL_PATTERN =
	/\b(?:bun\s+add|npm\s+(?:install|i|add)|pnpm\s+add|yarn\s+add|pip\s+install|cargo\s+add)\b/i;

const DECISION_PATTERNS = [
	/\b(?:architectural\s+decision|decision)\s*[:-]\s*(.+)/i,
	/\b(decided\s+to\s+.+)/i,
	/\b(we\s+will\s+use\s+.+)/i,
];

const DISCOVERY_PATTERNS = [
	/\b(?:discovery)\s*[:-]\s*(.+)/i,
	/\b(discovered(?:\s+that)?\s+.+)/i,
	/\b(found\s+that\s+.+)/i,
];

function hasBugKeywords(text?: string): boolean {
	if (!text) return false;
	return /\b(?:fix|fixed|fixing|bug|bugs|error|errors|issue|issues|crash|crashes|failing|failed|problem)\b/i.test(
		text,
	);
}

function isConfigFile(filePath: string): boolean {
	const base = path.basename(filePath).toLowerCase();
	return (
		base === "package.json" ||
		base === "tsconfig.json" ||
		base.startsWith(".env") ||
		/\.(?:ya?ml|toml|ini|conf)$/i.test(base) ||
		/(?:settings|config|schema)/i.test(filePath)
	);
}

function extractFilePath(params?: Record<string, unknown>): string | null {
	if (!params) return null;
	const candidate =
		params.path ?? params.filePath ?? params.Path ?? params.file ?? params.target_file ?? params.targetFile;
	if (typeof candidate === "string" && candidate.trim().length > 0) {
		return candidate.trim();
	}
	return null;
}

function extractCommand(params?: Record<string, unknown>): string | null {
	if (!params) return null;
	const candidate = params.CommandLine ?? params.command ?? params.cmd;
	if (typeof candidate === "string" && candidate.trim().length > 0) {
		return candidate.trim();
	}
	return null;
}

function cleanTitle(title: string): string {
	let cleaned = title
		.replace(/[\u2013\u2014]/g, "-")
		.trim()
		.replace(/^[:\-\s]+/, "");
	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	if (cleaned.length > 80) {
		return `${cleaned.slice(0, 77)}...`;
	}
	return cleaned;
}

function cleanSummary(summary: string): string {
	let cleaned = summary.replace(/[\u2013\u2014]/g, "-").trim();
	if (cleaned.length > 0 && !/[.!?]$/.test(cleaned)) {
		cleaned += ".";
	}
	return cleaned;
}

function areTitlesSimilar(a: string, b: string): boolean {
	const normA = a.toLowerCase().trim();
	const normB = b.toLowerCase().trim();
	if (normA === normB) return true;
	if (normA.startsWith(normB) || normB.startsWith(normA)) return true;

	const wordsA = new Set(normA.split(/\s+/).filter(w => w.length > 2));
	const wordsB = new Set(normB.split(/\s+/).filter(w => w.length > 2));
	let intersection = 0;
	for (const w of wordsA) {
		if (wordsB.has(w)) intersection++;
	}
	const union = new Set([...wordsA, ...wordsB]).size;
	if (union === 0) return true;
	return intersection / union >= 0.6;
}

function hasSimilarTitle(seenTitles: string[], newTitle: string): boolean {
	return seenTitles.some(existing => areTitlesSimilar(existing, newTitle));
}

function extractExplicitObservations(
	text: string,
	patterns: RegExp[],
	category: ObservationCategory,
	input: DistillTurnInput,
	seenTitles: string[],
): InsertObservationParams[] {
	const observations: InsertObservationParams[] = [];
	const lines = text.split(/\r?\n/);

	for (const line of lines) {
		const trimmedLine = line.replace(/^[\s*\->#]+/, "").trim();
		if (!trimmedLine) continue;

		for (const pattern of patterns) {
			const match = trimmedLine.match(pattern);
			if (match) {
				const rawSentence = (match[1] ? match[1] : match[0]).trim();
				// Extract the first complete sentence on this line
				const sentencePart = rawSentence.split(/[.!?](?:\s|$)/)[0]?.trim() || rawSentence;
				const title = cleanTitle(sentencePart);

				if (title.length > 0 && !hasSimilarTitle(seenTitles, title)) {
					seenTitles.push(title);
					observations.push({
						sessionId: input.sessionId,
						entryId: input.entryId ?? null,
						turnIndex: input.turnIndex,
						category,
						title,
						summary: cleanSummary(rawSentence),
						files: [],
					});
				}
				break;
			}
		}
	}

	return observations;
}

export class ObservationDistiller {
	/**
	 * Distills structured observations from a completed agent turn.
	 */
	distillFromTurn(input: DistillTurnInput): InsertObservationParams[] {
		const observations: InsertObservationParams[] = [];
		const seenTitles: string[] = [];
		const seenFiles = new Set<string>();

		const toolExecutions = input.toolExecutions ?? [];
		const hadPriorError = toolExecutions.some(tool => tool.isError === true);
		const bugContext = hadPriorError || hasBugKeywords(input.userPrompt) || hasBugKeywords(input.assistantText);

		// 1. Process explicit decisions and discoveries from assistant text and thinking
		if (input.assistantThinking) {
			const decisionFromThinking = extractExplicitObservations(
				input.assistantThinking,
				DECISION_PATTERNS,
				"decision",
				input,
				seenTitles,
			);
			observations.push(...decisionFromThinking);

			const discoveryFromThinking = extractExplicitObservations(
				input.assistantThinking,
				DISCOVERY_PATTERNS,
				"discovery",
				input,
				seenTitles,
			);
			observations.push(...discoveryFromThinking);
		}

		if (input.assistantText) {
			const decisionFromText = extractExplicitObservations(
				input.assistantText,
				DECISION_PATTERNS,
				"decision",
				input,
				seenTitles,
			);
			observations.push(...decisionFromText);

			const discoveryFromText = extractExplicitObservations(
				input.assistantText,
				DISCOVERY_PATTERNS,
				"discovery",
				input,
				seenTitles,
			);
			observations.push(...discoveryFromText);
		}

		// 2. Process file modifications
		for (const tool of toolExecutions) {
			const toolLower = tool.toolName.toLowerCase();
			if (!FILE_EDIT_TOOLS.has(toolLower)) {
				continue;
			}

			const filePath = extractFilePath(tool.params);
			if (!filePath || seenFiles.has(filePath)) {
				continue;
			}
			seenFiles.add(filePath);

			const filename = path.basename(filePath);
			let category: ObservationCategory = "feature";
			let title = `Updated ${filename}`;
			let summary = `Updated ${filePath} with implementation changes.`;

			if (bugContext) {
				category = "bugfix";
				title = `Fixed ${filename}`;
				summary = `Fixed issues in ${filePath}.`;
			} else if (isConfigFile(filePath)) {
				category = "decision";
				title = `Updated ${filename}`;
				summary = `Updated configuration settings in ${filePath}.`;
			}

			const formattedTitle = cleanTitle(title);
			if (!hasSimilarTitle(seenTitles, formattedTitle)) {
				seenTitles.push(formattedTitle);
				observations.push({
					sessionId: input.sessionId,
					entryId: input.entryId ?? null,
					turnIndex: input.turnIndex,
					category,
					title: formattedTitle,
					summary: cleanSummary(summary),
					files: [filePath],
				});
			}
		}

		// 3. Process command executions (test runner or package installation)
		let sawCommandFailure = false;
		for (const tool of toolExecutions) {
			const toolLower = tool.toolName.toLowerCase();
			if (!COMMAND_TOOLS.has(toolLower)) {
				continue;
			}

			if (tool.isError) {
				sawCommandFailure = true;
				continue;
			}

			const cmd = extractCommand(tool.params);
			if (!cmd) continue;

			if (TEST_RUNNER_PATTERN.test(cmd)) {
				const isFix = sawCommandFailure || bugContext;
				if (isFix) {
					const title = `Fixed tests with ${cmd.split(/\s+/).slice(0, 2).join(" ")}`;
					const formattedTitle = cleanTitle(title);
					if (!hasSimilarTitle(seenTitles, formattedTitle)) {
						seenTitles.push(formattedTitle);
						observations.push({
							sessionId: input.sessionId,
							entryId: input.entryId ?? null,
							turnIndex: input.turnIndex,
							category: "bugfix",
							title: formattedTitle,
							summary: cleanSummary(`Test suite passed successfully after resolving errors: ${cmd}`),
							files: [],
						});
					}
				}
			} else if (PACKAGE_INSTALL_PATTERN.test(cmd)) {
				const title = "Installed package dependencies";
				const formattedTitle = cleanTitle(title);
				if (!hasSimilarTitle(seenTitles, formattedTitle)) {
					seenTitles.push(formattedTitle);
					observations.push({
						sessionId: input.sessionId,
						entryId: input.entryId ?? null,
						turnIndex: input.turnIndex,
						category: "decision",
						title: formattedTitle,
						summary: cleanSummary(`Installed package dependencies with command: ${cmd}`),
						files: [],
					});
				}
			}
		}

		return observations;
	}
}
