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
import { deleteLine, deleteText, pasteText, yankLine, yankText } from "../operators";
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

	// Handle pending operations (double key or operator-motion composition)
	if (state.pendingKey) {
		const pending = state.pendingKey;
		state.pendingKey = "";

		if (pending === "d" && key === "d") {
			return { buffer: deleteLine(buf, buf.cursorLine, state) };
		}
		if (pending === "y" && key === "y") {
			return { buffer: yankLine(buf, buf.cursorLine, state) };
		}
		if (pending === "c" && key === "c") {
			const cleared = deleteLine(buf, buf.cursorLine, state);
			return { buffer: cleared, transitionMode: "insert" };
		}
		if (pending === "g" && key === "g") {
			return { buffer: { ...buf, cursorLine: 0, cursorCol: 0 } };
		}

		// Try motion composition
		let motionBuf: EditorBuffer | null = null;
		if (key === "h" || key === "left") motionBuf = moveLeft(buf, count);
		else if (key === "l" || key === "right") motionBuf = moveRight(buf, count);
		else if (key === "k" || key === "up") motionBuf = moveUp(buf, count);
		else if (key === "j" || key === "down") motionBuf = moveDown(buf, count);
		else if (key === "0" || key === "home") motionBuf = moveToLineStart(buf);
		else if (key === "$") motionBuf = moveToLineEnd(buf);
		else if (key === "w") motionBuf = moveWordForward(buf, count);
		else if (key === "b") motionBuf = moveWordBackward(buf, count);
		else if (key === "G") motionBuf = moveToBottom(buf);

		if (motionBuf) {
			const toLine = motionBuf.cursorLine;
			let toCol = motionBuf.cursorCol;

			// Exclusive motions: exclude the target character/boundary
			if (key === "w" && toLine === buf.cursorLine && toCol > buf.cursorCol) {
				toCol--;
			}

			if (pending === "d") {
				const { buffer } = deleteText(buf, buf.cursorLine, buf.cursorCol, toLine, toCol, state);
				return { buffer };
			}
			if (pending === "y") {
				yankText(buf, buf.cursorLine, buf.cursorCol, toLine, toCol, state);
				return { buffer: buf };
			}
			if (pending === "c") {
				const { buffer } = deleteText(buf, buf.cursorLine, buf.cursorCol, toLine, toCol, state);
				return { buffer, transitionMode: "insert" };
			}
		}

		// Fall through if key was not a valid continuation
	}

	// Check if key starts a sequence
	if (key === "d" || key === "y" || key === "c" || key === "g") {
		state.pendingKey = key;
		return { buffer: buf };
	}

	// Core motions
	if (key === "h" || key === "left") return { buffer: moveLeft(buf, count) };
	if (key === "l" || key === "right") return { buffer: moveRight(buf, count) };
	if (key === "k" || key === "up") return { buffer: moveUp(buf, count) };
	if (key === "j" || key === "down") return { buffer: moveDown(buf, count) };
	if (key === "0" || key === "home") return { buffer: moveToLineStart(buf) };
	if (key === "$") return { buffer: moveToLineEnd(buf) };
	if (key === "w") return { buffer: moveWordForward(buf, count) };
	if (key === "b") return { buffer: moveWordBackward(buf, count) };
	if (key === "G") return { buffer: moveToBottom(buf) };

	// Transitions to Insert mode
	if (key === "i") return { buffer: buf, transitionMode: "insert" };
	if (key === "a") return { buffer: moveRight(buf, 1), transitionMode: "insert" };

	// Transitions to Visual mode
	if (key === "v") return { buffer: buf, transitionMode: "visual" };
	if (key === "V") return { buffer: buf, transitionMode: "visual-line" };

	// Operators (simple single-key deletions / pastes)
	if (key === "x") {
		const endCol = Math.min((buf.lines[buf.cursorLine]?.length ?? 0) - 1, buf.cursorCol + count - 1);
		const { buffer } = deleteText(buf, buf.cursorLine, buf.cursorCol, buf.cursorLine, endCol, state);
		return { buffer };
	}
	if (key === "p") return { buffer: pasteText(buf, state, true) };
	if (key === "P") return { buffer: pasteText(buf, state, false) };

	return { buffer: buf };
}
