export interface EditorBuffer {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}

export function moveLeft(buf: EditorBuffer, count = 1): EditorBuffer {
	const col = Math.max(0, buf.cursorCol - count);
	return { ...buf, cursorCol: col };
}

export function moveRight(buf: EditorBuffer, count = 1): EditorBuffer {
	const lineLen = buf.lines[buf.cursorLine]?.length ?? 0;
	const col = Math.min(Math.max(0, lineLen - 1), buf.cursorCol + count);
	return { ...buf, cursorCol: col };
}

export function moveUp(buf: EditorBuffer, count = 1): EditorBuffer {
	const line = Math.max(0, buf.cursorLine - count);
	const lineLen = buf.lines[line]?.length ?? 0;
	const col = Math.min(Math.max(0, lineLen - 1), buf.cursorCol);
	return { ...buf, cursorLine: line, cursorCol: col };
}

export function moveDown(buf: EditorBuffer, count = 1): EditorBuffer {
	const line = Math.min(buf.lines.length - 1, buf.cursorLine + count);
	const lineLen = buf.lines[line]?.length ?? 0;
	const col = Math.min(Math.max(0, lineLen - 1), buf.cursorCol);
	return { ...buf, cursorLine: line, cursorCol: col };
}

export function moveToLineStart(buf: EditorBuffer): EditorBuffer {
	return { ...buf, cursorCol: 0 };
}

export function moveToLineEnd(buf: EditorBuffer): EditorBuffer {
	const lineLen = buf.lines[buf.cursorLine]?.length ?? 0;
	return { ...buf, cursorCol: Math.max(0, lineLen - 1) };
}

export function moveWordForward(buf: EditorBuffer, count = 1): EditorBuffer {
	let { cursorLine, cursorCol } = buf;
	for (let c = 0; c < count; c++) {
		const line = buf.lines[cursorLine] ?? "";
		// Skip non-whitespace to find boundary
		let idx = cursorCol;
		while (idx < line.length && !/\s/.test(line[idx])) idx++;
		// Skip whitespace to find next word start
		while (idx < line.length && /\s/.test(line[idx])) idx++;
		if (idx < line.length) {
			cursorCol = idx;
		} else if (cursorLine < buf.lines.length - 1) {
			cursorLine++;
			cursorCol = 0;
			// Skip leading spaces on next line
			const nextLine = buf.lines[cursorLine] ?? "";
			let nIdx = 0;
			while (nIdx < nextLine.length && /\s/.test(nextLine[nIdx])) nIdx++;
			cursorCol = nIdx;
		}
	}
	return { ...buf, cursorLine, cursorCol };
}

export function moveWordBackward(buf: EditorBuffer, count = 1): EditorBuffer {
	let { cursorLine, cursorCol } = buf;
	for (let c = 0; c < count; c++) {
		if (cursorCol > 0) {
			const line = buf.lines[cursorLine] ?? "";
			let idx = cursorCol - 1;
			// Skip whitespace backward
			while (idx > 0 && /\s/.test(line[idx])) idx--;
			// Find start of current/previous word
			while (idx > 0 && !/\s/.test(line[idx - 1])) idx--;
			cursorCol = idx;
		} else if (cursorLine > 0) {
			cursorLine--;
			const prevLine = buf.lines[cursorLine] ?? "";
			cursorCol = Math.max(0, prevLine.length - 1);
			let idx = cursorCol;
			while (idx > 0 && /\s/.test(prevLine[idx])) idx--;
			while (idx > 0 && !/\s/.test(prevLine[idx - 1])) idx--;
			cursorCol = idx;
		}
	}
	return { ...buf, cursorLine, cursorCol };
}

export function moveToTop(buf: EditorBuffer): EditorBuffer {
	return { ...buf, cursorLine: 0, cursorCol: 0 };
}

export function moveToBottom(buf: EditorBuffer): EditorBuffer {
	const lastLineIdx = buf.lines.length - 1;
	const lastLineLen = buf.lines[lastLineIdx]?.length ?? 0;
	return { ...buf, cursorLine: lastLineIdx, cursorCol: Math.max(0, lastLineLen - 1) };
}
