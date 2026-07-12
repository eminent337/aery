import type { EditorBuffer } from "../motions";
import {
	moveDown,
	moveLeft,
	moveRight,
	moveToBottom,
	moveToLineEnd,
	moveToLineStart,
	moveUp,
	moveWordBackward,
	moveWordForward,
} from "../motions";
import { deleteText, pasteText } from "../operators";
import type { VimState } from "../state";

export function handleNormalMode(
	buf: EditorBuffer,
	key: string,
	state: VimState,
): { buffer: EditorBuffer; transitionMode?: string } {
	// Parse numeric counts (e.g. 3dw)
	if (/^[1-9]$/.test(key) && state.count === null) {
		state.count = parseInt(key, 10);
		return { buffer: buf };
	} else if (/^[0-9]$/.test(key) && state.count !== null) {
		state.count = state.count * 10 + parseInt(key, 10);
		return { buffer: buf };
	}

	const count = state.count ?? 1;
	state.count = null; // Reset count for motion

	// Core motions
	if (key === "h" || key === "left") return { buffer: moveLeft(buf, count) };
	if (key === "l" || key === "right") return { buffer: moveRight(buf, count) };
	if (key === "k" || key === "up") return { buffer: moveUp(buf, count) };
	if (key === "j" || key === "down") return { buffer: moveDown(buf, count) };
	if (key === "0" || key === "home") return { buffer: moveToLineStart(buf) };
	if (key === "$") return { buffer: moveToLineEnd(buf) };
	if (key === "w") return { buffer: moveWordForward(buf, count) };
	if (key === "b") return { buffer: moveWordBackward(buf, count) };
	if (key === "g") {
		// Expecting gg
		return { buffer: buf }; // gg handled by single g tracker if needed, simple:
	}
	if (key === "G") return { buffer: moveToBottom(buf) };

	// Transitions to Insert mode
	if (key === "i") return { buffer: buf, transitionMode: "insert" };
	if (key === "a") return { buffer: moveRight(buf, 1), transitionMode: "insert" };

	// Transitions to Visual mode
	if (key === "v") return { buffer: buf, transitionMode: "visual" };
	if (key === "V") return { buffer: buf, transitionMode: "visual-line" };

	// operators (simple single-key deletions / pastes)
	if (key === "x") {
		const endCol = Math.min((buf.lines[buf.cursorLine]?.length ?? 0) - 1, buf.cursorCol + count - 1);
		const { buffer } = deleteText(buf, buf.cursorLine, buf.cursorCol, buf.cursorLine, endCol, state);
		return { buffer };
	}
	if (key === "p") return { buffer: pasteText(buf, state, true) };
	if (key === "P") return { buffer: pasteText(buf, state, false) };

	return { buffer: buf };
}
