import type { EditorBuffer } from "../motions";
import { moveDown, moveLeft, moveRight, moveUp } from "../motions";
import { deleteText, yankText } from "../operators";
import type { VimState } from "../state";

export interface VisualRange {
	startLine: number;
	startCol: number;
}

export function handleVisualMode(
	buf: EditorBuffer,
	key: string,
	anchor: VisualRange,
	state: VimState,
): { buffer: EditorBuffer; transitionMode?: string; anchor?: VisualRange } {
	// Move selection cursor
	if (key === "h" || key === "left") return { buffer: moveLeft(buf, 1), anchor };
	if (key === "l" || key === "right") return { buffer: moveRight(buf, 1), anchor };
	if (key === "k" || key === "up") return { buffer: moveUp(buf, 1), anchor };
	if (key === "j" || key === "down") return { buffer: moveDown(buf, 1), anchor };

	// Escape back to Normal Mode
	if (key === "escape") {
		return { buffer: buf, transitionMode: "normal" };
	}

	// Yank selection
	if (key === "y") {
		if (state.mode === "visual-line") {
			const start = Math.min(anchor.startLine, buf.cursorLine);
			const end = Math.max(anchor.startLine, buf.cursorLine);
			const yankedLines = buf.lines.slice(start, end + 1).join("\n");
			state.setYanked(yankedLines, "line");
		} else {
			yankText(buf, anchor.startLine, anchor.startCol, buf.cursorLine, buf.cursorCol, state);
		}
		return { buffer: buf, transitionMode: "normal" };
	}

	// Delete selection
	if (key === "d" || key === "x") {
		if (state.mode === "visual-line") {
			const start = Math.min(anchor.startLine, buf.cursorLine);
			const end = Math.max(anchor.startLine, buf.cursorLine);
			const yankedLines = buf.lines.slice(start, end + 1).join("\n");
			state.setYanked(yankedLines, "line");

			const lines = [...buf.lines];
			lines.splice(start, end - start + 1);
			if (lines.length === 0) lines.push("");
			const cursorLine = Math.min(lines.length - 1, start);
			return { buffer: { lines, cursorLine, cursorCol: 0 }, transitionMode: "normal" };
		} else {
			const { buffer } = deleteText(buf, anchor.startLine, anchor.startCol, buf.cursorLine, buf.cursorCol, state);
			return { buffer, transitionMode: "normal" };
		}
	}

	return { buffer: buf, anchor };
}
