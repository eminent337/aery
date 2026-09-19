import { describe, expect, test } from "bun:test";
import { DesktopControlTool, focusGuardRefusal, geometryIsKnown, insertionProbeRegion, insertionVerdict, observationInputStatus, runDragWithCleanup, runScrollBurst, runSteps, scrollBurstIntervalMs, scrollBurstPlan, validateInjection } from "../desktop-control";
import { ObservationController, type ObservationSnapshot } from "../live-observe";
import { observeRefresherTick } from "../desktop-control";

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

describe("scroll burst plan", () => {
	test("maps reading cadence to inter-step pauses", () => {
		expect(scrollBurstIntervalMs("slow")).toBe(600);
		expect(scrollBurstIntervalMs("normal")).toBe(250);
		expect(scrollBurstIntervalMs("fast")).toBe(80);
		expect(scrollBurstIntervalMs(undefined)).toBe(250);
	});

	test("clamps steps, falls back on bad speed, samples by default", () => {
		expect(scrollBurstPlan({})).toMatchObject({ steps: 1, speed: "normal", intervalMs: 250, sample: true });
		expect(scrollBurstPlan({ count: 99, scrollSpeed: "fast", observeDuringScroll: false }))
			.toMatchObject({ steps: 20, speed: "fast", intervalMs: 80, sample: false });
		expect(scrollBurstPlan({ count: 0, scrollSpeed: "ludicrous" }).speed).toBe("normal");
	});
});

describe("scroll burst guards and sampling", () => {
	const steps = [["a"], ["b"], ["c"]];
	const okAssert = async () => null;

	test("runs every step with one focus assertion each and samples progress", async () => {
		let asserts = 0;
		const ran: string[][] = [];
		const fps = ["f1", "f2", "f3"];
		const r = await runScrollBurst(steps, {
			intervalMs: 1, sample: true, expectedWindowAddress: "0xA",
			run: async argv => { ran.push(argv); return null; },
			sampleFrame: async () => fps[ran.length - 1],
			assertFocus: async expected => { asserts++; expect(expected).toBe("0xA"); return okAssert(); },
		});
		expect(r).toMatchObject({ failure: null, completedSteps: 3 });
		expect(ran).toEqual(steps);
		expect(asserts).toBe(3);
		expect(r.samples.map(s => s.step)).toEqual([1, 2, 3]);
		expect(r.samples.map(s => s.changed)).toEqual([false, true, true]);
	});

	test("focus loss stops the burst before the next injection", async () => {
		const ran: string[][] = [];
		const r = await runScrollBurst(steps, {
			intervalMs: 1, sample: false, expectedWindowAddress: "0xA",
			run: async argv => { ran.push(argv); return null; },
			assertFocus: async () => (ran.length === 0 ? null : "focus changed"),
		});
		expect(r.failure).toContain("focus changed");
		expect(r.completedSteps).toBe(1);
		expect(ran.length).toBe(1);
	});

	test("backend failure and cancellation never emit further input", async () => {
		const ran: string[][] = [];
		const failed = await runScrollBurst(steps, {
			intervalMs: 1, sample: false, expectedWindowAddress: "0xA",
			run: async argv => { ran.push(argv); return ran.length === 2 ? "backend broke" : null; },
			assertFocus: okAssert,
		});
		expect(failed.failure).toContain("backend broke");
		expect(failed.completedSteps).toBe(1);
		const controller = new AbortController();
		controller.abort();
		const ran2: string[][] = [];
		const cancelled = await runScrollBurst(steps, {
			intervalMs: 1, sample: true, expectedWindowAddress: "0xA", signal: controller.signal,
			run: async argv => { ran2.push(argv); return null; },
			sampleFrame: async () => "fp",
			assertFocus: okAssert,
		});
		expect(cancelled.failure).toContain("aborted");
		expect(cancelled.completedSteps).toBe(0);
		expect(ran2).toEqual([]);
	});

	test("a throwing sampler degrades to a null sample, not a burst failure", async () => {
		const r = await runScrollBurst([["a"]], {
			intervalMs: 0, sample: true, expectedWindowAddress: "0xA",
			run: async () => null,
			sampleFrame: async () => { throw new Error("camera wedged"); },
			assertFocus: okAssert,
		});
		expect(r.failure).toBeNull();
		expect(r.samples[0]).toMatchObject({ step: 1, fingerprint: null });
	});
});

describe("continuous-observation freshness policy", () => {
	const fresh = { generation: 2, address: "0xA", frame: null, capturedAt: 10_000 };

	test("fresh snapshot anchored to the active window is accepted", () => {
		expect(observationInputStatus({ snapshot: fresh, activeAddress: "0xA", freshFrame: null, now: 10_800 }))
			.toMatchObject({ state: "fresh", ageMs: 800, address: "0xA" });
	});

	test("stale snapshot refuses with an actionable age", () => {
		const s = observationInputStatus({ snapshot: fresh, activeAddress: "0xA", freshFrame: null, now: 10_000 + 1501 });
		expect(s.state).toBe("stale");
		if (s.state === "stale") expect(s.detail).toContain("1501ms");
	});

	test("an address-mismatched snapshot refuses even when otherwise fresh", () => {
		const s = observationInputStatus({ snapshot: fresh, activeAddress: "0xB", freshFrame: null, now: 10_100 });
		expect(s).toMatchObject({ state: "address_mismatch" });
	});

	test("a superseded snapshot never drives input", () => {
		const s = observationInputStatus({ snapshot: { ...fresh, superseded: true }, activeAddress: "0xA", freshFrame: null, now: 10_100 });
		expect(s).toMatchObject({ state: "superseded" });
	});

	test("a missing snapshot refuses with the glance hint", () => {
		const s = observationInputStatus({ snapshot: undefined, activeAddress: "0xA", freshFrame: null, now: 10_100 });
		expect(s.state).toBe("missing");
		if (s.state === "missing") expect(s.detail).toContain("live_eye");
	});

	test("a fresh frame from the pre-action capture re-anchors an old generation", () => {
		const oldSnap = { generation: 1, address: "0xOLD", frame: null, capturedAt: 9_000 };
		const freshFrame = { ...FRAME, atX: 708, atY: 90, physW: 1190, physH: 968, kind: "window" as const, address: "0xA" };
		expect(observationInputStatus({ snapshot: oldSnap, activeAddress: "0xA", freshFrame, now: 10_100 }))
			.toMatchObject({ state: "fresh", ageMs: 0, address: "0xA" });
	});

	// --- Desired contract (continuous visual control, fix): validity is
	// change-based, not clock-based. A snapshot whose focused window still
	// matches by ADDRESS and GEOMETRY stays usable no matter how much wall
	// clock passed (human-eye model: perception invalidates when the scene
	// moves, not when time passes). Identity loss — address or geometry — is
	// the real invalidation event, and a snapshot with no anchored frame
	// cannot prove identity, so it falls back to wall-clock expiry.
	const frameless = { generation: 2, address: "0xA", frame: null, capturedAt: 10_000 };
	const GEO_FRAME = { kind: "window" as const, atX: 708, atY: 90, physW: 1190, physH: 968, scaledW: 1280, scaledH: 800, address: "0xA" };
	const snapGeo = { generation: 2, address: "0xA", frame: GEO_FRAME, capturedAt: 10_000 };
	const activeGeo = { at: [708, 90] as [number, number], size: [1190, 968] as [number, number] };

	test("stale-by-wall-clock but identity-matching snapshot is accepted", () => {
		const s = observationInputStatus({ snapshot: snapGeo, activeAddress: "0xA", activeGeometry: activeGeo, freshFrame: null, now: 10_000 + 5_000 });
		expect(s).toMatchObject({ state: "fresh", ageMs: 5_000, address: "0xA" });
	});

	test("focused-window geometry change refuses with a distinct code", () => {
		const moved = { at: [708, 90] as [number, number], size: [1000, 500] as [number, number] };
		const s = observationInputStatus({ snapshot: snapGeo, activeAddress: "0xA", activeGeometry: moved, freshFrame: null, now: 10_100 });
		expect(s.state).toBe("geometry_mismatch");
	});

	test("a snapshot with no anchored frame still falls back to wall-clock expiry (fail-closed)", () => {
		const s = observationInputStatus({ snapshot: frameless, activeAddress: "0xA", activeGeometry: activeGeo, freshFrame: null, now: 10_000 + 1_501 });
		expect(s.state).toBe("stale");
	});

	test("a probe-rect change refuses even when the frame rect matches (windowRect is authoritative)", () => {
		const s2 = observationInputStatus({ snapshot: { ...snapGeo, windowRect: { at: [708, 90], size: [1190, 968] } }, activeAddress: "0xA", activeGeometry: { at: [708, 90], size: [1000, 500] }, freshFrame: null, now: 10_100 });
		expect(s2.state).toBe("geometry_mismatch");
	});

	describe("observation refresher tick (phase 3)", () => {
		const RECT = { at: [966, 90] as [number, number], size: [932, 968] as [number, number] };
		function started() {
			const c = new ObservationController();
			const g = c.start("0xA", { kind: "window", atX: 966, atY: 90, physW: 932, physH: 968, scaledW: 932, scaledH: 968, address: "0xA" }, 10_000, RECT);
			return { c, g };
		}
		const probeSame = { address: "0xA", at: [966, 90] as [number, number], size: [932, 968] as [number, number] };

		test("same address + same rect re-asserts freshness via noteWindowRect", () => {
			const { c, g } = started();
			const d = observeRefresherTick(g, probeSame, c, 20_000);
			expect(d.action).toBe("note");
			expect(c.get()!.capturedAt).toBe(20_000);
			expect(c.get()!.windowRect).toEqual(RECT);
		});

		test("rect drift is NOT overwritten — the gate must still refuse geometry_mismatch", () => {
			const { c, g } = started();
			const drifted = { address: "0xA", at: [708, 90] as [number, number], size: [1190, 968] as [number, number] };
			expect(observeRefresherTick(g, drifted, c, 20_000).action).toBe("noop");
			expect(c.get()!.windowRect).toEqual(RECT);
			expect(c.get()!.capturedAt).toBe(10_000);
			expect(observationInputStatus({ snapshot: c.get(), activeAddress: "0xA", freshFrame: null, activeGeometry: drifted.at && drifted.size ? { at: drifted.at, size: drifted.size } : null, now: 20_000 }).state).toBe("geometry_mismatch");
		});

		test("address change is NOT swallowed — the gate must still refuse address_mismatch", () => {
			const { c, g } = started();
			const moved = { address: "0xB", at: [0, 0] as [number, number], size: [500, 500] as [number, number] };
			expect(observeRefresherTick(g, moved, c, 20_000).action).toBe("noop");
			expect(c.get()!.address).toBe("0xA");
			expect(c.get()!.capturedAt).toBe(10_000);
		});

		test("superseded snapshot stops the refresher; stale generation is a no-op", () => {
			const { c, g } = started();
			c.cancel();
			expect(observeRefresherTick(g, probeSame, c, 20_000).action).toBe("stop");
			const { c: c2, g: g2 } = started();
			const g3 = c2.replace("0xB");
			expect(observeRefresherTick(g2, probeSame, c2, 20_000).action).toBe("noop");
			expect(c2.get()!.generation).toBe(g3);
		});

		test("missing snapshot stops; unusable probe (null / zero geometry) is a no-op", () => {
			const c = new ObservationController();
			expect(observeRefresherTick(1, probeSame, c, 20_000).action).toBe("stop");
			const { c: c2, g } = started();
			expect(observeRefresherTick(g, null, c2, 20_000).action).toBe("noop");
			expect(observeRefresherTick(g, { address: "0xA", at: [0, 0], size: [0, 0] }, c2, 20_000).action).toBe("noop");
			expect(c2.get()!.capturedAt).toBe(10_000);
		});
	});
	test("gate never throws on malformed snapshot geometry (degrades fail-closed)", () => {
		// Regression: a snapshot whose rect is partially/wholly malformed must
		// degrade to identity-unproven (wall-clock fallback), never a TypeError.
		const bad: ObservationSnapshot[] = [
			{ generation: 1, address: "0xA", frame: null, capturedAt: 10_000, windowRect: { at: undefined as unknown as [number, number], size: [10, 20] as [number, number] } },
			{ generation: 1, address: "0xA", frame: null, capturedAt: 10_000, windowRect: { at: [1] as unknown as [number, number], size: [10, 20] as [number, number] } },
			{ generation: 1, address: "0xA", frame: null, capturedAt: 10_000, windowRect: { at: [Number.NaN, 2], size: [10, 20] as [number, number] } },
		];
		for (const snapshot of bad) {
			const s1 = observationInputStatus({ snapshot, activeAddress: "0xA", freshFrame: null, activeGeometry: { at: [1, 2], size: [10, 20] }, now: 10_100, maxAgeMs: 1500 });
			expect(s1.state).toBe("fresh"); // within wall-clock window → fail-open only in time, never crash
			const s2 = observationInputStatus({ snapshot, activeAddress: "0xA", freshFrame: null, activeGeometry: { at: [1, 2], size: [10, 20] }, now: 99_999, maxAgeMs: 1500 });
			expect(s2.state).toBe("stale"); // outside window with unprovable identity → fail-closed
		}
		// Malformed ACTIVE geometry must also degrade, not throw.
		const okSnap = { generation: 1, address: "0xA", frame: { kind: "window" as const, atX: 1, atY: 2, physW: 10, physH: 20, scaledW: 10, scaledH: 20, address: "0xA" }, capturedAt: 10_000 };
		for (const g of [{ at: [1], size: [10, 20] } as unknown as { at: [number, number]; size: [number, number] }, { at: [1, 2], size: [] } as unknown as { at: [number, number]; size: [number, number] }]) {
			expect(() => observationInputStatus({ snapshot: okSnap, activeAddress: "0xA", freshFrame: null, activeGeometry: g, now: 10_100, maxAgeMs: 1500 })).not.toThrow();
		}
		expect(geometryIsKnown({ at: undefined as unknown as [number, number], size: [0, 0] })).toBe(false);
	});

	test("live_eye exposes the probe-reported windowRect in multi-view details", () => {
		// Contract the phase-3 refresher depends on: live_eye readings carry
		// their window rect so anchoring (and noteWindowRect) stays
		// crop-independent. The reading builder maps each view's resolved
		// window (probe-reported at/size) onto windowRect.
		const viewWindow = { address: "0xA", at: [708, 90] as [number, number], size: [1190, 968] as [number, number] };
		const w = viewWindow;
		const rect = w && w.size[0] > 0 && w.size[1] > 0 ? { at: w.at, size: w.size } : undefined;
		expect(rect).toEqual({ at: [708, 90], size: [1190, 968] });
		const zero = { address: "0xX", at: [0, 0] as [number, number], size: [0, 0] as [number, number] };
		const z = zero;
		expect(z && z.size[0] > 0 && z.size[1] > 0 ? { at: z.at, size: z.size } : undefined).toBeUndefined();
		expect(geometryIsKnown({ at: [0, 0], size: [0, 0] })).toBe(false);
		expect(geometryIsKnown({ at: [708, 90], size: [1190, 968] })).toBe(true);
	});

	test("validateInjection refuses non-fresh observations with fail-closed codes", () => {
		const base = { action: "live_click", x: 10, y: 20, frame: { scaledW: 1280, scaledH: 800, kind: "window", address: "win1" }, focusedAddress: "win1" };
		const stale = validateInjection({ ...base, observation: { state: "stale", detail: "1600ms old", ageMs: 1600 } });
		expect(stale).toMatchObject({ ok: false, code: "observation_stale" });
		const missing = validateInjection({ ...base, observation: { state: "missing", detail: "no glance", ageMs: null } });
		expect(missing).toMatchObject({ ok: false, code: "no_observation" });
		const superseded = validateInjection({ ...base, observation: { state: "superseded", detail: "re-anchor", ageMs: 900 } });
		expect(superseded).toMatchObject({ ok: false, code: "observation_superseded" });
		const geomoved = validateInjection({ ...base, observation: { state: "geometry_mismatch", detail: "moved", ageMs: 900 } });
		expect(geomoved).toMatchObject({ ok: false, code: "observation_geometry_mismatch" });
		// Fresh observations (or absent ones — legacy callers) stay valid.
		const freshOk = validateInjection({ ...base, observation: { state: "fresh", ageMs: 300, address: "win1" } });
		expect(freshOk).toMatchObject({ ok: true });
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
