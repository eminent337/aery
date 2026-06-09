/**
 * Thinking Steps Extension
 *
 * Parses LLM thinking blocks into structured steps and renders them
 * as a collapsible step list below the raw thinking text.
 *
 * Architecture:
 * - Uses the existing `AssistantThinkingRenderer` hook to render steps
 *   below each thinking block in the assistant message.
 * - Pure parsing + rendering — no prototype patching, no state management.
 * - Three modes: collapsed (summary only), expanded (full steps), off.
 */

import type { Component } from "@aryee337/aery-tui";
import type { AssistantThinkingRenderContext, ExtensionAPI } from "../extensibility/extensions/types.js";
import type { Theme, ThemeColor } from "../modes/theme/theme.js";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type ThinkingStepsMode = "collapsed" | "expanded" | "off";

interface ThinkingStep {
	id: number;
	summary: string;
	body: string;
	role: ThinkingSemanticRole;
}

type ThinkingSemanticRole = "inspect" | "plan" | "compare" | "verify" | "write" | "search" | "error" | "default";

export interface ThinkingStepsExtensionOptions {
	defaultMode?: ThinkingStepsMode;
}

// ──────────────────────────────────────────────────────────────────────────
// Parsing
// ──────────────────────────────────────────────────────────────────────────

const HEADING_RE = /^\s{0,3}#{1,6}\s+/;
const LIST_RE = /^\s*(?:[-*+]\s+|\d+[.)]\s+|[a-z][.)]\s+)/i;

export function inferThinkingRole(text: string): ThinkingSemanticRole {
	const lower = text.toLowerCase();
	if (/\b(read|grep|find|look|search|examine|inspect|check|scan)\b/.test(lower)) return "inspect";
	if (/\b(plan|design|approach|strategy|architecture|decide)\b/.test(lower)) return "plan";
	if (/\b(compare|versus|trade.?off|alternative|option|pros|cons)\b/.test(lower)) return "compare";
	if (/\b(verify|test|validate|assert|confirm|ensure)\b/.test(lower)) return "verify";
	if (/\b(write|create|implement|add|edit|modify|change|fix|patch)\b/.test(lower)) return "write";
	if (/\b(search|query|lookup|fetch|api)\b/.test(lower)) return "search";
	if (/\b(error|fail|bug|issue|problem|wrong|broken)\b/.test(lower)) return "error";
	return "default";
}

export function iconForRole(role: ThinkingSemanticRole): string {
	switch (role) {
		case "inspect":
			return "\u{1F50D}";
		case "plan":
			return "\u{1F4CB}";
		case "compare":
			return "\u2696\uFE0F";
		case "verify":
			return "\u2705";
		case "write":
			return "\u270F\uFE0F";
		case "search":
			return "\u{1F50E}";
		case "error":
			return "\u274C";
		default:
			return "\u{1F4AD}";
	}
}

function roleColorKey(role: ThinkingSemanticRole): ThemeColor {
	switch (role) {
		case "inspect":
			return "accent";
		case "plan":
			return "accent";
		case "compare":
			return "statusLineSpend";
		case "verify":
			return "success";
		case "write":
			return "accent";
		case "search":
			return "accent";
		case "error":
			return "error";
		default:
			return "thinkingText";
	}
}

function deriveSummaryFromBody(body: string): string {
	const firstLine = body.split("\n").find(l => l.trim()) ?? "";
	const cleaned = firstLine.replace(HEADING_RE, "").replace(LIST_RE, "").trim();
	if (cleaned.length <= 80) return cleaned;
	return `${cleaned.slice(0, 77)}...`;
}

/**
 * Split thinking text into logical steps.
 * Steps break at headings, subsequent list items, or blank-line paragraph boundaries.
 */
export function splitThinkingIntoSteps(text: string): ThinkingStep[] {
	const normalized = text.replace(/\r\n?/g, "\n").trim();
	if (!normalized) return [];

	const lines = normalized.split("\n");
	const steps: ThinkingStep[] = [];
	let currentSummary = "";
	let currentBody: string[] = [];
	let stepId = 0;

	function flush() {
		const summary = currentSummary.trim() || deriveSummaryFromBody(currentBody.join("\n"));
		if (!summary) return;
		const body = currentBody.join("\n").trim();
		const role = inferThinkingRole(`${summary} ${body}`);
		steps.push({ id: stepId++, summary, body, role });
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const isHeading = HEADING_RE.test(line);
		const isListItem = LIST_RE.test(line);
		const isBlank = line.trim() === "";

		if (isHeading || (isListItem && (currentBody.length > 0 || currentSummary))) {
			flush();
			currentSummary = line.replace(HEADING_RE, "").trim();
			currentBody = [];
		} else if (isBlank && currentBody.length > 0 && currentSummary) {
			flush();
			currentSummary = "";
			currentBody = [];
		} else {
			currentBody.push(line);
			if (!currentSummary && currentBody.length <= 3) {
				const trimmed = line.trim();
				if (trimmed) currentSummary = trimmed;
			}
		}
	}

	flush();
	return steps;
}

// ──────────────────────────────────────────────────────────────────────────
// Rendering
// ──────────────────────────────────────────────────────────────────────────

function renderCollapsedSteps(steps: ThinkingStep[], theme: Theme): string {
	if (steps.length === 0) return "";
	const lines: string[] = [];
	if (steps.length <= 3) {
		for (const step of steps) {
			lines.push(
				`${theme.fg(roleColorKey(step.role), iconForRole(step.role))} ${theme.fg("thinkingText", step.summary)}`,
			);
		}
	} else {
		for (const step of steps.slice(0, 2)) {
			lines.push(
				`${theme.fg(roleColorKey(step.role), iconForRole(step.role))} ${theme.fg("thinkingText", step.summary)}`,
			);
		}
		lines.push(theme.fg("dim", `  +${steps.length - 2} more steps`));
	}
	return lines.join("\n");
}

function renderExpandedSteps(steps: ThinkingStep[], theme: Theme): string {
	if (steps.length === 0) return "";
	return steps
		.map(
			step =>
				`${theme.fg(roleColorKey(step.role), iconForRole(step.role))} ${theme.fg("thinkingText", step.summary)}`,
		)
		.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// Extension Factory
// ──────────────────────────────────────────────────────────────────────────

export function createThinkingStepsExtension(options?: ThinkingStepsExtensionOptions) {
	const defaultMode = options?.defaultMode ?? "collapsed";

	return function thinkingStepsExtension(api: ExtensionAPI): void {
		let currentMode: ThinkingStepsMode = defaultMode;

		api.registerAssistantThinkingRenderer(
			(context: AssistantThinkingRenderContext, theme: Theme): Component | undefined => {
				if (currentMode === "off") return undefined;
				if (!context.text.trim()) return undefined;

				const steps = splitThinkingIntoSteps(context.text);
				if (steps.length === 0) return undefined;

				const rendered =
					currentMode === "expanded" ? renderExpandedSteps(steps, theme) : renderCollapsedSteps(steps, theme);

				if (!rendered) return undefined;

				return {
					render(_width: number): string[] {
						return rendered.split("\n");
					},
					invalidate() {},
				};
			},
		);

		api.registerCommand("thinking-steps", {
			description: "Toggle thinking steps display: /thinking-steps [collapsed|expanded|off]",
			handler: async (args, ctx) => {
				const arg = args?.trim().toLowerCase();
				if (arg === "collapsed" || arg === "expanded" || arg === "off") {
					currentMode = arg;
					ctx.ui.notify(`Thinking steps mode: ${currentMode}`, "info");
					return;
				}
				if (currentMode === "off") currentMode = "collapsed";
				else if (currentMode === "collapsed") currentMode = "expanded";
				else currentMode = "off";
				ctx.ui.notify(`Thinking steps mode: ${currentMode}`, "info");
			},
		});
	};
}
