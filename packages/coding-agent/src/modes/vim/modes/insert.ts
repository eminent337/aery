import type { EditorBuffer } from "../motions";

export function handleInsertMode(buf: EditorBuffer, key: string): { buffer: EditorBuffer; transitionMode?: string } {
	// Escape transitions back to Normal mode
	if (key === "escape") {
		// Back cursor up 1 character (standard Vim behavior on exiting insert mode)
		const col = Math.max(0, buf.cursorCol - 1);
		return { buffer: { ...buf, cursorCol: col }, transitionMode: "normal" };
	}

	const lines = [...buf.lines];
	let { cursorLine, cursorCol } = buf;
	const line = lines[cursorLine] ?? "";

	if (key === "enter" || key === "\n" || key === "\r") {
		const before = line.substring(0, cursorCol);
		const after = line.substring(cursorCol);
		lines[cursorLine] = before;
		lines.splice(cursorLine + 1, 0, after);
		cursorLine++;
		cursorCol = 0;
	} else if (key === "backspace") {
		if (cursorCol > 0) {
			lines[cursorLine] = line.substring(0, cursorCol - 1) + line.substring(cursorCol);
			cursorCol--;
		} else if (cursorLine > 0) {
			const prevLine = lines[cursorLine - 1] ?? "";
			cursorCol = prevLine.length;
			lines[cursorLine - 1] = prevLine + line;
			lines.splice(cursorLine, 1);
			cursorLine--;
		}
	} else if (key.length === 1) {
		lines[cursorLine] = line.substring(0, cursorCol) + key + line.substring(cursorCol);
		cursorCol++;
	}

	return { buffer: { lines, cursorLine, cursorCol } };
}
