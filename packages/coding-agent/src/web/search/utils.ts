/** Calculate age in seconds from an ISO date string. Returns undefined on invalid input. */
export function dateToAgeSeconds(dateStr: string | null | undefined): number | undefined {
	if (!dateStr) return undefined;
	try {
		const date = new Date(dateStr);
		if (Number.isNaN(date.getTime())) return undefined;
		return Math.floor((Date.now() - date.getTime()) / 1000);
	} catch {
		return undefined;
	}
}

/** Clamp a result count to [1, maxVal], returning defaultVal when value is absent or NaN. */
export function clampNumResults(value: number | undefined, defaultVal: number, maxVal: number): number {
	if (!value || Number.isNaN(value)) return defaultVal;
	return Math.min(maxVal, Math.max(1, value));
}

export function formatAge(ageSeconds: number | undefined): string | undefined {
	if (ageSeconds === undefined) return undefined;
	if (ageSeconds < 60) return `${ageSeconds}s ago`;
	if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m ago`;
	if (ageSeconds < 86400) return `${Math.floor(ageSeconds / 3600)}h ago`;
	if (ageSeconds < 604800) return `${Math.floor(ageSeconds / 86400)}d ago`;
	return `${Math.floor(ageSeconds / 2592000)}mo ago`;
}

export function truncateText(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

/** Maximum characters for a search answer before truncation.
 * Kept well below the ~32KB large-tool-result warning threshold
 * so the web_search tool stays under budget even with many sources. */
export const MAX_SEARCH_ANSWER_CHARS = 2_500;

export function formatCount(label: string, count: number): string {
	return `${count} ${label}${count === 1 ? "" : "s"}`;
}
