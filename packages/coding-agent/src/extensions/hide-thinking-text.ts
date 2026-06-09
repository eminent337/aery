/**
 * Handle inline `<think>...</think>` tags that some models (DeepSeek, QwQ)
 * embed in text content blocks rather than using native `thinking` content blocks.
 *
 * Architecture:
 * - `filterTaggableText()` strips `<think>` tags for display.
 *   When `hideThinking = true`, the entire thinking block is removed.
 *   When `hideThinking = false` (default), only the raw `<think>`/`</think>`
 *   tags are removed — the content remains visible as regular text.
 * - The original message (with tags) is always preserved in session storage;
 *   the transform is only applied at render time in the TUI component.
 * - No ANSI codes are embedded since the downstream Markdown component
 *   manages its own styling.
 */

/** Returns true when the text contains at least one <think> tag or </think> tag. */
export function containsThinkTags(text: string): boolean {
	return text.includes("<think>") || text.includes("</think>");
}

/**
 * Transform text for display by removing `<think>...</think>` tags.
 *
 * - `hideThinking = true`: strip the entire thinking block (tags + content).
 * - `hideThinking = false` (default): strip only the raw `<think>`/`</think>`
 *   markers — the thinking content remains visible as regular text.
 *
 * Returns the original text unchanged when there are no `<think>` tags.
 */
export function filterTaggableText(text: string, hideThinking = false): string {
	if (!containsThinkTags(text)) return text;

	if (hideThinking) {
		return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
	}

	// Strip only the tags, keeping the content visible
	return text.replace(/<\/?think>/g, "");
}
