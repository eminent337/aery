import { describe, expect, test } from "bun:test";
import { DesktopControlTool, focusGuardRefusal, insertionProbeRegion, insertionVerdict, runDragWithCleanup, runSteps, validateInjection } from "../desktop-control";

const FRAME = { scaledW: 1280, scaledH: 800, kind: "window", address: "win1" };
const DRAG = { action: "live_drag" as const, x: 10, y: 20, x2: 100, y2: 200 };
const SHIFT_DRAG = { ...DRAG, modifiers: ["shift"] as "shift"[], frame: FRAME, focusedAddress: "win1" };
const schema = new DesktopControlTool().parameters;
const NON_DRAG_ACTIONS = [
	"screenshot", "list_windows", "live_eye", "highlight", "focus_window", "close_window",
	"switch_workspace", "launch_app", "cursor_pos", "live_mode_on", "live_mode_off",
	"live_mode_status", "live_backend_probe", "live_move", "live_click", "live_type",
	"live_key", "live_scroll", "system_control", "xvfb_launch", "xvfb_screenshot",
	"xvfb_list_windows", "xvfb_click", "xvfb_type", "xvfb_key", "xvfb_close",
] as const;
const INVALID_MODIFIERS: unknown[] = [
	["ctrl"], ["alt"], ["super"], ["meta"], ["Shift"], ["shift", "ctrl"],
	["shift", "shift"], [""], [], [42], [null], "shift", null, true, {},
];

describe("desktop drag modifier schema safety", () => {
	test("ordinary drags remain valid without modifiers", () => {
		expect(schema.parse(DRAG).modifiers).toBeUndefined();
	});

	test("accepts only the Shift modifier", () => {
		expect(schema.parse({ ...DRAG, modifiers: ["shift"] }).modifiers).toEqual(["shift"]);
		expect(schema.safeParse({ ...DRAG, modifiers: [] }).success).toBe(false);
	});

	for (const modifiers of INVALID_MODIFIERS) {
		test(`rejects unsafe or malformed modifiers ${JSON.stringify(modifiers)}`, () => {
			expect(schema.safeParse({ ...DRAG, modifiers }).success).toBe(false);
		});
	}

	for (const action of NON_DRAG_ACTIONS) {
		test(`rejects modifier presence on ${action}, including an empty list`, () => {
			expect(schema.safeParse({ action }).success).toBe(true);
			for (const modifiers of [["shift"], []]) {
				expect(schema.safeParse({ action, modifiers }).success).toBe(false);
			}
		});
	}
});

describe("desktop drag runtime modifier safety", () => {
	test("accepts an in-bounds Shift drag without changing its start coordinates", () => {
		expect(validateInjection(SHIFT_DRAG)).toEqual({ ok: true, tx: 10, ty: 20 });
	});

	test("ordinary and absent-modified drags remain valid", () => {
		expect(validateInjection({ ...SHIFT_DRAG, modifiers: undefined }).ok).toBe(true);
	});

	for (const modifiers of INVALID_MODIFIERS) {
		test(`rejects raw modifiers ${JSON.stringify(modifiers)} even when schema parsing is bypassed`, () => {
			const params = { ...SHIFT_DRAG, modifiers };
			expect(validateInjection(params)).toMatchObject({ ok: false, code: "invalid_modifiers" });
		});
	}

	for (const action of NON_DRAG_ACTIONS) {
		test(`runtime validation refuses modifiers on ${action}`, () => {
			for (const modifiers of [["shift"] as "shift"[], []]) {
				expect(validateInjection({ ...SHIFT_DRAG, action, modifiers })).toMatchObject({
					ok: false, code: "invalid_modifiers",
				});
			}
		});
	}
});

describe("Shift drag preserves frame and endpoint guardrails", () => {
	test("requires a remembered frame", () => {
		expect(validateInjection({ ...SHIFT_DRAG, frame: null })).toMatchObject({ ok: false, code: "no_frame" });
	});

	test("refuses a stale window frame", () => {
		expect(validateInjection({ ...SHIFT_DRAG, focusedAddress: "other" })).toMatchObject({
			ok: false, code: "frame_stale",
		});
	});

	for (const coordinate of ["x", "y", "x2", "y2"] as const) {
		test(`requires ${coordinate} even with Shift held`, () => {
			expect(validateInjection({ ...SHIFT_DRAG, [coordinate]: undefined })).toMatchObject({
				ok: false, code: coordinate.endsWith("2") ? "missing_xy2" : "missing_xy",
			});
		});

		for (const value of [-1, coordinate.startsWith("x") ? FRAME.scaledW : FRAME.scaledH]) {
			test(`refuses out-of-frame ${coordinate}=${value} with Shift`, () => {
				expect(validateInjection({ ...SHIFT_DRAG, [coordinate]: value })).toMatchObject({
					ok: false, code: "out_of_bounds",
				});
			});
		}
	}

	test("accepts the last in-bounds frame pixels as the drag endpoint", () => {
		expect(validateInjection({ ...SHIFT_DRAG, x2: FRAME.scaledW - 1, y2: FRAME.scaledH - 1 }).ok).toBe(true);
	});
});

describe("immediate focused-window guard", () => {
	test("allows an input batch only when the exact Hyprland address still matches", () => {
		expect(focusGuardRefusal("0xexpected", { address: "0xexpected", class: "brave-browser", title: "Bench" })).toBeNull();
	});

	test("reports expected and actual identity on mismatch", () => {
		const refusal = focusGuardRefusal("0xexpected", { address: "0xother", class: "kitty", title: "Aery" });
		expect(refusal).toContain("0xexpected");
		expect(refusal).toContain("0xother");
		expect(refusal).toContain("kitty");
	});

	test("fails closed when an expected address is absent", () => {
		expect(focusGuardRefusal(undefined, { address: "0xother", class: "brave-browser", title: "Bench" })).toContain("no expected");
	});

	test("refuses before spawning the next argv when focus changes", async () => {
		const refusal = "focus changed";
		const result = await runSteps([["this-command-must-not-run"]], 0, "0xexpected", async expected => {
			expect(expected).toBe("0xexpected");
			return refusal;
		});
		expect(result).toBe(refusal);
	});
});

describe("insertion probe region", () => {
	const frame = { atX: 700, atY: 90, physW: 1190, physH: 968 };

	test("spans the caret row without sampling beyond the captured window", () => {
		const r = insertionProbeRegion(frame, { x: 900, y: 300 });
		expect(r.x).toBe(700); // clamped to the window's left edge
		expect(r.y).toBe(280);
		expect(r.x + r.w).toBeLessThanOrEqual(frame.atX + frame.physW);
		expect(r.y + r.h).toBeLessThanOrEqual(frame.atY + frame.physH);
	});

	test("honours explicit padding and never returns a negative size", () => {
		const r = insertionProbeRegion(frame, { x: 701, y: 91 }, { left: 0, right: 0, above: 0, below: 0 });
		expect(r.w).toBe(0);
		expect(r.h).toBe(0);
		expect(r.x).toBe(701);
	});
});
describe("insertion verdict tri-state", () => {
	test("native or frame evidence confirms the insertion", () => {
		expect(insertionVerdict({ nativeSeen: true, frameSeen: false, rowLocated: true })).toBe(true);
		expect(insertionVerdict({ nativeSeen: false, frameSeen: true, rowLocated: false })).toBe(true);
	});

	test("a positively read row without the text is a real negative", () => {
		expect(insertionVerdict({ nativeSeen: false, frameSeen: false, rowLocated: true })).toBe(false);
	});

	test("an unlocalizable row reports unknown, never a false failure", () => {
		expect(insertionVerdict({ nativeSeen: false, frameSeen: false, rowLocated: false })).toBeNull();
	});
});

// Every execution test supplies an inert runner; no subprocess or desktop input is used.
for (const backend of ["ydotool", "xdotool"] as const) {
	describe(`${backend} drag sequencing and cleanup`, () => {
		const start = ["fake-move", "10", "20"];
		const moves = [["fake-move", "50", "100"], ["fake-move", "100", "200"]];
		const options = { backend, shift: true, start, moves };
		const shiftDown = backend === "ydotool" ? ["ydotool", "key", "-d", "24", "42:1"] : ["xdotool", "keydown", "Shift_L"];
		const shiftUp = backend === "ydotool" ? ["ydotool", "key", "-d", "24", "42:0"] : ["xdotool", "keyup", "Shift_L"];
		const mouseDown = backend === "ydotool" ? ["ydotool", "click", "0x40"] : ["xdotool", "mousedown", "1"];
		const mouseUp = backend === "ydotool" ? ["ydotool", "click", "0x80"] : ["xdotool", "mouseup", "1"];
		const sequence = [start, shiftDown, mouseDown, ...moves, mouseUp, shiftUp];

		test("holds Shift before mouse down and through all waypoints, then releases mouse before Shift", async () => {
			const calls: string[][] = [];
			const result = await runDragWithCleanup(options, async argv => {
				calls.push([...argv]);
				return null;
			});
			expect(result).toBeNull();
			expect(calls).toEqual(sequence);
		});

		test("ordinary drag never sends Shift events", async () => {
			const calls: string[][] = [];
			expect(await runDragWithCleanup({ ...options, shift: false }, async argv => {
				calls.push([...argv]);
				return null;
			})).toBeNull();
			expect(calls).toEqual([start, mouseDown, ...moves, mouseUp]);
		});

		for (const failureMode of ["returned", "thrown"] as const) {
			for (const [stage, failAt] of [["start", 0], ["Shift down", 1], ["mouse down", 2], ["first move", 3], ["last move", 4]] as const) {
				test(`${failureMode} failure at ${stage} stops movement and releases every possibly held input`, async () => {
					const calls: string[][] = [];
					const result = await runDragWithCleanup(options, async argv => {
						calls.push([...argv]);
						if (calls.length - 1 === failAt) {
							if (failureMode === "thrown") throw new Error("injected failure");
							return "injected failure";
						}
						return null;
					});
					const cleanup = failAt === 0 ? [] : failAt === 1 ? [shiftUp] : [mouseUp, shiftUp];
					expect(result).toContain("injected failure");
					expect(calls).toEqual([...sequence.slice(0, failAt + 1), ...cleanup]);
				});
			}

			for (const failAt of [5, 6]) {
				test(`${failureMode} cleanup failure at ${failAt === 5 ? "mouse up" : "Shift up"} is surfaced without skipping other releases`, async () => {
					const calls: string[][] = [];
					const result = await runDragWithCleanup(options, async argv => {
						calls.push([...argv]);
						if (calls.length - 1 === failAt) {
							if (failureMode === "thrown") throw new Error("release failure");
							return "release failure";
						}
						return null;
					});
					expect(result).toContain("cleanup failed");
					expect(result).toContain("release failure");
					expect(result).toContain("may still be held");
					expect(calls).toEqual(sequence);
				});
			}
		}

		test("retains the movement failure and both independent cleanup failures", async () => {
			const calls: string[][] = [];
			const result = await runDragWithCleanup(options, async argv => {
				calls.push([...argv]);
				if (calls.length === 4) return "movement failure";
				if (calls.length === 5) return "mouse release failure";
				if (calls.length === 6) throw new Error("Shift release failure");
				return null;
			});
			expect(result).toContain("movement failure");
			expect(result).toContain("mouse release failure");
			expect(result).toContain("Shift release failure");
			expect(calls).toEqual([start, shiftDown, mouseDown, moves[0], mouseUp, shiftUp]);
		});

		test("a pre-aborted drag sends no input", async () => {
			const controller = new AbortController();
			controller.abort();
			const calls: string[][] = [];
			const result = await runDragWithCleanup(options, async argv => {
				calls.push([...argv]);
				return null;
			}, controller.signal);
			expect(result).toContain("aborted");
			expect(calls).toEqual([]);
		});

		for (const abortAt of [1, 2, 3, 4]) {
			test(`cancellation after input step ${abortAt} does not cancel cleanup`, async () => {
				const controller = new AbortController();
				const calls: string[][] = [];
				const result = await runDragWithCleanup(options, async argv => {
					calls.push([...argv]);
					if (calls.length - 1 === abortAt) controller.abort();
					return null;
				}, controller.signal);
				expect(result).toContain("aborted");
				expect(calls).toEqual([...sequence.slice(0, abortAt + 1), ...(abortAt === 1 ? [shiftUp] : [mouseUp, shiftUp])]);
			});
		}
	});
}
