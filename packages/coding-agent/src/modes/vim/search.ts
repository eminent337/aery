import type { EditorBuffer } from "./motions";
import type { VimState } from "./state";

export function executeSearch(
	buf: EditorBuffer,
	pattern: string,
	direction: "forward" | "backward",
	state: VimState,
): EditorBuffer {
	if (!pattern) return buf;
	state.searchPattern = pattern;
	state.searchDirection = direction;

	return repeatSearch(buf, state, direction === "forward");
}

export function repeatSearch(buf: EditorBuffer, state: VimState, forward = true): EditorBuffer {
	const pattern = state.searchPattern;
	if (!pattern) return buf;

	const isForward = state.searchDirection === "forward" ? forward : !forward;
	const regex = new RegExp(pattern, "i");

	const { cursorLine, cursorCol } = buf;
	const lines = buf.lines;

	if (isForward) {
		// Search forward from current position
		let startCol = cursorCol + 1;
		for (let offset = 0; offset <= lines.length; offset++) {
			const lineIdx = (cursorLine + offset) % lines.length;
			const text = lines[lineIdx] ?? "";
			const match = regex.exec(text.substring(startCol));
			if (match) {
				return { lines, cursorLine: lineIdx, cursorCol: startCol + match.index };
			}
			startCol = 0; // After first line, check from col 0
		}
	} else {
		// Search backward from current position
		let startCol = cursorCol - 1;
		for (let offset = 0; offset <= lines.length; offset++) {
			const lineIdx = (cursorLine - offset + lines.length) % lines.length;
			const text = lines[lineIdx] ?? "";
			const checkText = startCol >= 0 ? text.substring(0, startCol + 1) : "";
			if (checkText) {
				let matchIdx = -1;
				let match: RegExpExecArray | null = null;
				// Find last match in string
				regex.lastIndex = 0;
				while ((match = regex.exec(checkText)) !== null) {
					matchIdx = match.index;
					if (!regex.global) break; // Avoid infinite loop for non-global regex
				}
				if (matchIdx >= 0) {
					return { lines, cursorLine: lineIdx, cursorCol: matchIdx };
				}
			}
			const prevLineIdx = (lineIdx - 1 + lines.length) % lines.length;
			startCol = (lines[prevLineIdx]?.length ?? 0) - 1; // Prior line starts at end of line
		}
	}

	return buf; // No match found
}
