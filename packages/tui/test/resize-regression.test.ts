import { describe, expect, it } from "bun:test";
import { type Component, TUI } from "@aryee337/aery-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Regression tests for terminal-resize corruption (duplicated rows / welcome
// UI, and text that stays stale-width until a manual repaint).
//
// Root cause: on a real resize the terminal rewraps/reflows the transcript it
// already holds and can move or clamp the hardware cursor (kitty clamps on
// shrink). The TUI's cursor-relative emitters (`#emitDiff`, `#emitAppendTail`,
// `#emitShrink`) position rows against the *previous* viewport top and
// hardware cursor row, which the reflow just invalidated. A frame that pairs
// a geometry change with changed content therefore used to fall through to
// `diff`, write rows onto the wrong screen lines, duplicate text (and image
// placements) and leave stale-width fragments behind.
//
// Fix: `#planRender` routes any such frame to absolute emitters only —
// `historyRebuild` when the transcript overflows (clear + repaint from the
// model is the only zero-cursor-relative reconciliation), `viewportRepaint`
// when it fits / under multiplexers / for parked readers.
//
// Headless xterm.js reflow happens to match the TUI's cursor prediction, so a
// plain end-state "no duplicate rows" assertion passes on the buggy baseline
// too (verified: end-state checks alone do not discriminate). These tests
// therefore also assert on the *emitter bytes* a geometry frame must produce
// (full clear+rebuild or an absolute `\x1b[H` repaint) and reject the
// relative-cursor `\x1b[nB` diff that only the buggy path emits.
//
// Second fix: a resize frame whose content *now* fits but whose transcript
// previously overflowed into native scrollback (`scrollbackHighWater > 0`)
// must rebuild (clear + replay) rather than repaint in place — an in-place
// repaint leaves the old-width rows committed in scrollback, which later
// reflows wrap into the stale-width "welcome boxes stacked at many widths"
// artifact (chat never shows it because overflowing frames already rebuild).
// Scrollback that never overflowed stays pristine and is preserved (no `3J`).

/** Plain rows, truncated to width (no wrapping) — models the welcome screen. */
class PlainList implements Component {
	#lines: string[];
	constructor(lines: string[]) {
		this.#lines = [...lines];
	}
	invalidate(): void {}
	render(width: number): string[] {
		return this.#lines.map(l => l.slice(0, width));
	}
	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}
}

/** Word-less wrap (chunk at width) — models long assistant replies. */
class WrappingList implements Component {
	#lines: string[];
	constructor(lines: string[]) {
		this.#lines = [...lines];
	}
	invalidate(): void {}
	render(width: number): string[] {
		const out: string[] = [];
		for (const l of this.#lines) {
			for (let i = 0; i < l.length; i += width) out.push(l.slice(i, i + width));
		}
		return out;
	}
	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
	await Bun.sleep(20);
	await term.flush();
}

/** Start recording raw terminal writes from now on; returns the recorder. */
function capture(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	(term as unknown as { write: (s: string) => void }).write = (data: string) => {
		writes.push(data);
		realWrite(data);
	};
	return writes;
}

/**
 * Multiplexer/termux env vars are read at render time by the TUI's routing
 * predicates, and the full suite leaks them across files in the shared
 * process. Clear them so these geometry tests deterministically exercise the
 * native-terminal path regardless of ambient environment.
 */
async function withCleanEnv<T>(run: () => T | Promise<T>): Promise<T> {
	const keys = ["TMUX", "STY", "ZELLIJ", "TERMUX_VERSION"] as const;
	const saved = new Map<string, string | undefined>();
	for (const key of keys) {
		saved.set(key, process.env[key]);
		delete process.env[key];
		(Bun.env as Record<string, string | undefined>)[key] = undefined;
	}
	try {
		return await run();
	} finally {
		for (const key of keys) {
			const value = saved.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
			(Bun.env as Record<string, string | undefined>)[key] = value;
		}
	}
}

function eachOnce(rows: string[], tag: string): void {
	const hits = rows.filter(r => r.includes(tag));
	expect(hits.length).toBe(1);
}

/** True when a frame is reflow-safe: clear+rebuild or absolute-home repaint. */
function isReflowSafeFrame(frame: string): boolean {
	return frame.includes("\x1b[2J") || frame.includes("\x1b[H\x1b[2K");
}

describe("resize regression: overflow + height grow + append stays single", () => {
	it("no duplicated rows; frame is an absolute emitter, never a relative diff", async () => {
		const term = new VirtualTerminal(40, 6, 4000);
		const tui = new TUI(term);
		const rows = (n: number) => Array.from({ length: n }, (_, i) => `row-${String(i).padStart(2, "0")}`);
		const list = new PlainList(rows(10));
		tui.addChild(list);
		try {
			tui.start();
			// start() can schedule more than one post-initial frame; drain them so
			// the captured window below contains only the resize frame.
			await settle(term);
			await settle(term);

			const writes = capture(term);
			// Streaming append coalesced with a height grow — the exact frame that
			// used to fall through to the cursor-relative `diff` emitter.
			list.setLines(rows(12));
			term.resize(40, 10);
			await settle(term);

			// Fix contract: the captured resize frame must be reflow-safe — a
			// clear + full rebuild (`\x1b[2J…`) for an overflowing transcript, or
			// an absolute home repaint (`\x1b[H\x1b[2K…`) when the growth was
			// committed before the geometry frame — never the relative cursor diff
			// (`\x1b[nB\r\n…`) the buggy path emitted.
			const frame = writes.join("");
			expect(isReflowSafeFrame(frame)).toBe(true);

			// End state: the visible viewport is exactly the model's bottom slice
			// at the new height (rows 2..11 here), each row exactly once. (Which
			// rows remain in headless xterm scrollback after a grow-reflow differs
			// by emitter route, so uniqueness is asserted on the viewport only.)
			const expectedVisible = rows(12).slice(-10); // last `height` rows
			const vp = term.getViewport();
			for (const t of expectedVisible) {
				eachOnce(vp, t);
			}
			expect(vp.filter(r => r.trim() !== "").length).toBe(10);
		} finally {
			tui.stop();
		}
	});
});

describe("resize regression: long line + width change re-renders fully", () => {
	it("every wrapped chunk of the long lines is present exactly once after width grow + append", async () => {
		const term = new VirtualTerminal(20, 8, 4000);
		const tui = new TUI(term);
		const longA = `A-${"a".repeat(58)}`; // 60 cols -> 3 rows at width 20
		const longB = `B-${"b".repeat(58)}`; // 60 cols -> 3 rows at width 20
		const longC = `C-${"c".repeat(38)}`; // 40 cols -> 1 row at width 45
		const list = new WrappingList([longA, longB]);
		tui.addChild(list);
		try {
			tui.start();
			await settle(term);

			const writes = capture(term);
			// Widen while the reply grows: reflow joins wrapped rows and the new
			// tail lands in the same frame.
			list.setLines([longA, longB, longC]);
			term.resize(45, 8);
			await settle(term);

			// New content fits on screen -> absolute in-place repaint from home,
			// not a relative diff (and no destructive scrollback clear).
			const frame = writes.join("");
			expect(frame).toContain("\x1b[H\x1b[2K");
			expect(frame).not.toContain("\x1b[3J");

			// The reflowed viewport must re-render the full lines at the new
			// width: concatenated rows carry each whole line contiguously.
			const vp = term.getViewport();
			const joined = vp.join("");
			expect(joined).toContain(longA);
			expect(joined).toContain(longB);
			expect(joined).toContain(longC);
			// Each wrapped first-chunk prefix appears exactly once (no dupes).
			for (const tag of ["A-aaaa", "B-bbbb", "C-cccc"]) {
				eachOnce(vp, tag);
			}
		} finally {
			tui.stop();
		}
	});
});

describe("resize regression: welcome-like content + grow + appended tip stays single", () => {
	it("height grow with a welcome line appended in the same frame does not duplicate rows", async () => {
		const term = new VirtualTerminal(60, 8, 4000);
		const tui = new TUI(term);
		const welcome = ["WELCOME", "", "  aery - terminal agent", "  line-A", "  line-B", "  line-C"];
		const list = new PlainList(welcome);
		tui.addChild(list);
		try {
			tui.start();
			await settle(term);

			const writes = capture(term);
			list.setLines([...welcome, "  new tip line"]);
			term.resize(60, 14);
			await settle(term);

			// Fits on screen at the new height -> absolute repaint, no clear.
			const frame = writes.join("");
			expect(frame).toContain("\x1b[H\x1b[2K");
			expect(frame).not.toContain("\x1b[3J");

			const vp = term.getViewport();
			eachOnce(vp, "WELCOME");
			eachOnce(vp, "line-A");
			eachOnce(vp, "new tip line");
		} finally {
			tui.stop();
		}
	});
});

describe("resize regression: previously-overflowed content that now fits rebuilds", () => {
	it("an append + height-grow into the fitting range clears the committed old-width rows", async () => {
		await withCleanEnv(async () => {
			const term = new VirtualTerminal(40, 6, 4000);
			const tui = new TUI(term);
			const rows = (n: number) => Array.from({ length: n }, (_, i) => `row-${String(i).padStart(2, "0")}`);
			const list = new PlainList(rows(10));
			tui.addChild(list);
			try {
				tui.start();
				// rows(10) in a 6-row viewport overflows: 4 rows were pushed into
				// native scrollback at the initial paint (scrollbackHighWater = 4).
				await settle(term);
				await settle(term);

				const writes = capture(term);
				// Content grows AND the viewport grows so the transcript now fits.
				// A repaint in place would leave rows 0..3 (old width) committed in
				// scrollback for later reflows to wrap into stale-width duplicates;
				// the resize rebuild must clear them (2J + 3J on a reflowing terminal).
				list.setLines(rows(14));
				term.resize(40, 20);
				await settle(term);

				const frame = writes.join("");
				expect(frame).toContain("\x1b[2J");
				expect(frame).toContain("\x1b[H\x1b[3J");

				// Rebuilt from the model: exactly the 14 rows, each once, no residue
				// from the initial 10-row overflow.
				const vp = term.getViewport();
				for (const t of rows(14)) {
					eachOnce(vp, t);
				}
				expect(vp.filter(r => r.trim() !== "").length).toBe(14);
			} finally {
				tui.stop();
			}
		});
	});

	it("never-overflowed content that now fits repaints in place and preserves scrollback", async () => {
		await withCleanEnv(async () => {
			const term = new VirtualTerminal(40, 6, 4000);
			const tui = new TUI(term);
			const rows = (n: number) => Array.from({ length: n }, (_, i) => `row-${String(i).padStart(2, "0")}`);
			const list = new PlainList(rows(4));
			tui.addChild(list);
			try {
				tui.start();
				// rows(4) in a 6-row viewport never overflows: scrollbackHighWater
				// stays 0, so any scrollback above is pristine pre-app shell history.
				await settle(term);
				await settle(term);

				const writes = capture(term);
				list.setLines(rows(8));
				term.resize(40, 12);
				await settle(term);

				// Pristine scrollback must be preserved: in-place absolute repaint,
				// no 2J, no destructive 3J.
				const frame = writes.join("");
				expect(frame).toContain("\x1b[H\x1b[2K");
				expect(frame).not.toContain("\x1b[2J");
				expect(frame).not.toContain("\x1b[3J");

				const vp = term.getViewport();
				for (const t of rows(8)) {
					eachOnce(vp, t);
				}
				expect(vp.filter(r => r.trim() !== "").length).toBe(8);
			} finally {
				tui.stop();
			}
		});
	});

	it("a content-unchanged resize that makes previously-overflowed content fit rebuilds (2J+3J)", async () => {
		await withCleanEnv(async () => {
			const term = new VirtualTerminal(40, 6, 4000);
			const tui = new TUI(term);
			const rows = (n: number) => Array.from({ length: n }, (_, i) => `row-${String(i).padStart(2, "0")}`);
			const list = new PlainList(rows(12));
			tui.addChild(list);
			try {
				tui.start();
				// rows(12) in a 6-row viewport overflows: 6 rows are committed into
				// native scrollback by the initial paint (scrollbackHighWater = 6).
				await settle(term);
				await settle(term);

				const writes = capture(term);
				// A PURE resize — no content mutation — is the dominant frame during
				// a real drag. It used to repaint in place (never emitting 3J), so
				// the committed rows survived at the old geometry and kitty-style
				// hosts reflowed them into stale-width copies that never clear on
				// their own. The content-change fits gate could not help: this frame
				// has no content change to pair with the geometry change.
				term.resize(40, 20);
				await settle(term);

				const frame = writes.join("");
				expect(frame).toContain("\x1b[2J");
				expect(frame).toContain("\x1b[H\x1b[3J");

				// Cleared + replayed from the model: each row exactly once across the
				// whole buffer (the scrollback rows were the residue that must go).
				const sb = term.getScrollBuffer();
				for (const t of rows(12)) {
					expect(sb.filter(l => l.includes(t)).length).toBe(1);
				}
				const vp = term.getViewport();
				expect(vp.filter(r => r.trim() !== "").length).toBe(12);
			} finally {
				tui.stop();
			}
		});
	});
});
