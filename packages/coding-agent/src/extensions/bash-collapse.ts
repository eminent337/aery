/**
 * Collapse multi-line bash commands for single-line display in the TUI.
 * Replaces line breaks with a visual ⏎ marker so long compound commands
 * (pipes, chained statements) fit on one line in the execution header.
 */

/** ASCII-art replacement used when the terminal doesn't support Unicode. */
const FALLBACK_SEPARATOR = " $ ";

/** Unicode replacement for newlines within a command. */
const UNICODE_SEPARATOR = " ⏎ ";

/**
 * Collapse all consecutive newlines in a command string into a single visual
 * separator, making multi-line commands display as a single line.
 *
 * Returns the original string unchanged when there are no newlines or when
 * the input is empty.
 */
export function collapseCommand(command: string | undefined): string {
	const str = command ?? "";
	if (!str.includes("\n")) return str;
	// Use ASCII fallback when the terminal doesn't support Unicode (rare for
	// modern terminals, but checkable via TERM/LC_* env vars at call site).
	const sep = isUnicodeTerminal() ? UNICODE_SEPARATOR : FALLBACK_SEPARATOR;
	return str.replace(/\n+/g, sep);
}

/**
 * Quick check whether the terminal likely supports Unicode output.
 * Checks LC_ALL, LC_CTYPE, LANG for UTF-8 indicators. Defaults to true
 * when the check is inconclusive.
 */
function isUnicodeTerminal(): boolean {
	for (const key of ["LC_ALL", "LC_CTYPE", "LANG"] as const) {
		const val = process.env[key];
		if (typeof val === "string") {
			return /utf-?8/i.test(val);
		}
	}
	return true; // Most modern terminals support Unicode
}
