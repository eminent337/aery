import { describe, expect, it } from "bun:test";
import { moveDown, moveLeft, moveRight, moveUp } from "../../src/modes/vim/motions";
import { deleteText, pasteText, yankText } from "../../src/modes/vim/operators";
import { executeSearch } from "../../src/modes/vim/search";
import { VimState } from "../../src/modes/vim/state";

describe("Vim Motions", () => {
	it("moves cursor left and right within bounds", () => {
		const buf = { lines: ["hello"], cursorLine: 0, cursorCol: 2 };
		const left = moveLeft(buf, 1);
		expect(left.cursorCol).toBe(1);

		const right = moveRight(buf, 1);
		expect(right.cursorCol).toBe(3);

		const rightOver = moveRight(buf, 10);
		expect(rightOver.cursorCol).toBe(4); // clamped to length - 1
	});

	it("moves cursor up and down within bounds", () => {
		const buf = { lines: ["hello", "world", "test"], cursorLine: 1, cursorCol: 2 };
		const up = moveUp(buf, 1);
		expect(up.cursorLine).toBe(0);

		const down = moveDown(buf, 1);
		expect(down.cursorLine).toBe(2);
	});
});

describe("Vim Deletions and Yanking", () => {
	it("deletes text on a single line and yanks to state", () => {
		const state = new VimState();
		const buf = { lines: ["hello world"], cursorLine: 0, cursorCol: 6 };
		const { buffer, content } = deleteText(buf, 0, 6, 0, 10, state);

		expect(buffer.lines[0]).toBe("hello ");
		expect(content).toBe("world");
		expect(state.getYanked().content).toBe("world");
	});

	it("yanks text and pastes it after cursor", () => {
		const state = new VimState();
		const buf = { lines: ["hello world"], cursorLine: 0, cursorCol: 0 };
		yankText(buf, 0, 0, 0, 4, state);

		expect(state.getYanked().content).toBe("hello");

		const pasted = pasteText(buf, state, true);
		expect(pasted.lines[0]).toBe("hhelloello world");
	});
});

describe("Vim Search", () => {
	it("finds next match forward", () => {
		const state = new VimState();
		const buf = { lines: ["apple", "banana", "cherry"], cursorLine: 0, cursorCol: 0 };
		const newBuf = executeSearch(buf, "nan", "forward", state);

		expect(newBuf.cursorLine).toBe(1);
		expect(newBuf.cursorCol).toBe(2); // start of 'nan' in banana
	});

	it("finds next match backward", () => {
		const state = new VimState();
		const buf = { lines: ["apple", "banana", "cherry"], cursorLine: 2, cursorCol: 0 };
		const newBuf = executeSearch(buf, "app", "backward", state);

		expect(newBuf.cursorLine).toBe(0);
		expect(newBuf.cursorCol).toBe(0);
	});
});
