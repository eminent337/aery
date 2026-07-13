import type { EditorBuffer } from "./motions";
import type { VimState } from "./state";

export function deleteText(
	buf: EditorBuffer,
	fromLine: number,
	fromCol: number,
	toLine: number,
	toCol: number,
	state: VimState,
): { buffer: EditorBuffer; content: string } {
	let startLine = fromLine;
	let startCol = fromCol;
	let endLine = toLine;
	let endCol = toCol;

	if (startLine > endLine || (startLine === endLine && startCol > endCol)) {
		startLine = toLine;
		startCol = toCol;
		endLine = fromLine;
		endCol = fromCol;
	}

	const lines = [...buf.lines];
	let yanked = "";

	if (startLine === endLine) {
		const line = lines[startLine];
		yanked = line.substring(startCol, endCol + 1);
		lines[startLine] = line.substring(0, startCol) + line.substring(endCol + 1);
	} else {
		const startPart = lines[startLine].substring(startCol);
		const endPart = lines[endLine].substring(0, endCol + 1);
		const middleParts = lines.slice(startLine + 1, endLine);
		yanked = [startPart, ...middleParts, endPart].join("\n");

		lines[startLine] = lines[startLine].substring(0, startCol) + lines[endLine].substring(endCol + 1);
		lines.splice(startLine + 1, endLine - startLine);
	}

	state.setYanked(yanked, "char");
	return {
		buffer: { lines, cursorLine: startLine, cursorCol: startCol },
		content: yanked,
	};
}

export function yankText(
	buf: EditorBuffer,
	fromLine: number,
	fromCol: number,
	toLine: number,
	toCol: number,
	state: VimState,
): string {
	let startLine = fromLine;
	let startCol = fromCol;
	let endLine = toLine;
	let endCol = toCol;

	if (startLine > endLine || (startLine === endLine && startCol > endCol)) {
		startLine = toLine;
		startCol = toCol;
		endLine = fromLine;
		endCol = fromCol;
	}

	let yanked = "";
	if (startLine === endLine) {
		yanked = buf.lines[startLine].substring(startCol, endCol + 1);
	} else {
		const startPart = buf.lines[startLine].substring(startCol);
		const endPart = buf.lines[endLine].substring(0, endCol + 1);
		const middleParts = buf.lines.slice(startLine + 1, endLine);
		yanked = [startPart, ...middleParts, endPart].join("\n");
	}

	state.setYanked(yanked, "char");
	return yanked;
}

export function pasteText(buf: EditorBuffer, state: VimState, after = true): EditorBuffer {
	const reg = state.getYanked();
	if (!reg.content) return buf;

	const lines = [...buf.lines];
	let { cursorLine, cursorCol } = buf;

	if (reg.type === "line") {
		const pasteLines = reg.content.split("\n");
		const insertIdx = after ? cursorLine + 1 : cursorLine;
		lines.splice(insertIdx, 0, ...pasteLines);
		cursorLine = insertIdx;
		cursorCol = 0;
	} else {
		const line = lines[cursorLine] ?? "";
		const insertIdx = after ? cursorCol + 1 : cursorCol;
		lines[cursorLine] = line.substring(0, insertIdx) + reg.content + line.substring(insertIdx);
		cursorCol = insertIdx + reg.content.length - 1;
	}

	return { lines, cursorLine, cursorCol };
}

export function deleteLine(buf: EditorBuffer, lineIdx: number, state: VimState): EditorBuffer {
	const lines = [...buf.lines];
	const lineText = lines[lineIdx] ?? "";
	state.setYanked(lineText, "line");

	if (lines.length <= 1) {
		return { lines: [""], cursorLine: 0, cursorCol: 0 };
	}

	lines.splice(lineIdx, 1);
	const cursorLine = Math.min(lines.length - 1, lineIdx);
	const cursorCol = 0;
	return { lines, cursorLine, cursorCol };
}

export function yankLine(buf: EditorBuffer, lineIdx: number, state: VimState): EditorBuffer {
	const lineText = buf.lines[lineIdx] ?? "";
	state.setYanked(lineText, "line");
	return buf;
}
