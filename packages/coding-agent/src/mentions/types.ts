/**
 * Context @ Mentions Types.
 *
 * Modeled after Google Antigravity (agy) Context Mentions architecture.
 * Allows user prompts to reference and attach files, directories, rules,
 * terminals, and subagents inline via `@` tokens.
 */

export type MentionType = "file" | "dir" | "rule" | "terminal" | "agent";

export interface ResolvedMention {
	rawToken: string;
	type: MentionType;
	identifier: string;
	resolvedPath?: string;
	content: string;
	error?: string;
}

export interface ExpandedPromptResult {
	originalPrompt: string;
	expandedPrompt: string;
	mentions: ResolvedMention[];
}
