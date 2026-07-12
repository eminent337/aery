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
		yankText(buf, anchor.startLine, anchor.startCol, buf.cursorLine, buf.cursorCol, state);
		return { buffer: buf, transitionMode: "normal" };
	}

	// Delete selection
	if (key === "d" || key === "x") {
		const { buffer } = deleteText(buf, anchor.startLine, anchor.startCol, buf.cursorLine, buf.cursorCol, state);
		return { buffer, transitionMode: "normal" };
	}

	return { buffer: buf, anchor };
}
