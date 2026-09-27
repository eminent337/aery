import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import {
	catmullRomArcSampler,
	convergeCursorLanding,
	cursorVerifyNote,
	livePathPace,
	livePathTrajectory,
} from "../desktop-control";
import {
	frameAlignedGap,
	hyprCommandSocketPath,
	hyprGlidePaced,
	parseFrameMs,
	xdoGlideScript,
} from "../live-input";

/** Reply the fake compositor sends for command `index`; a delayed reply keeps
 *  the client's socket open to model a compositor that stalls. */
type FakeReply = string | { delayMs: number; text: string };

interface FakeCompositor {
	/** Commands received, in arrival order. */
	received: string[];
	/** `performance.now()` at which each command arrived. */
	arrivals: number[];
	cleanup: () => Promise<void>;
}

/** Stand in for Hyprland's command socket: one connection per command, replied
 *  to and closed, exactly as the real compositor behaves (verified: it answers
 *  `ok` then FINs, and a second write on the same socket raises EPIPE). */
async function startFakeCompositor(handle: (index: number) => FakeReply): Promise<FakeCompositor> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hglide-"));
	const hyprDir = path.join(dir, "hypr", "testsig");
	fs.mkdirSync(hyprDir, { recursive: true });
	const socketPath = path.join(hyprDir, ".socket.sock");
	const received: string[] = [];
	const arrivals: number[] = [];
	const server = net.createServer(socket => {
		socket.on("error", () => {
			// the client may destroy the socket mid-reply; ignore
		});
		socket.on("data", chunk => {
			const index = received.length;
			received.push(chunk.toString("utf8"));
			arrivals.push(performance.now());
			const reply = handle(index);
			if (typeof reply === "string") socket.end(reply);
			else setTimeout(() => socket.end(reply.text), reply.delayMs);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => resolve());
	});
	const previous = {
		sig: process.env.HYPRLAND_INSTANCE_SIGNATURE,
		runtime: process.env.XDG_RUNTIME_DIR,
	};
	process.env.HYPRLAND_INSTANCE_SIGNATURE = "testsig";
	process.env.XDG_RUNTIME_DIR = dir;
	return {
		received,
		arrivals,
		cleanup: async () => {
			if (previous.sig === undefined) delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
			else process.env.HYPRLAND_INSTANCE_SIGNATURE = previous.sig;
			if (previous.runtime === undefined) delete process.env.XDG_RUNTIME_DIR;
			else process.env.XDG_RUNTIME_DIR = previous.runtime;
			await new Promise<void>(resolve => server.close(() => resolve()));
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

function hops(n: number, gapMs: number): Array<{ x: number; y: number; gapMs: number }> {
	return Array.from({ length: n }, (_, i) => ({ x: 100 + i, y: 200 + i, gapMs }));
}

describe("xdoGlideScript", () => {
	test("one sync move and its dwell per hop, rounded, trailing newline", () => {
		const script = xdoGlideScript([
			{ x: 1.4, y: 2.6, gapMs: 16 },
			{ x: 10, y: 20, gapMs: 0 },
		]);
		expect(script).toBe("mousemove --sync 1 3\nsleep 0.016\nmousemove --sync 10 20\n");
	});

	test("a zero dwell emits no sleep, so the process exits right away", () => {
		expect(xdoGlideScript([{ x: 5, y: 5, gapMs: 0 }])).toBe("mousemove --sync 5 5\n");
	});
});

describe("hyprCommandSocketPath", () => {
	test("is null without a compositor instance signature", () => {
		expect(hyprCommandSocketPath({ XDG_RUNTIME_DIR: "/run/user/9" })).toBeNull();
	});

	test("resolves under XDG_RUNTIME_DIR when advertised", () => {
		expect(hyprCommandSocketPath({ HYPRLAND_INSTANCE_SIGNATURE: "abc", XDG_RUNTIME_DIR: "/run/user/9" })).toBe(
			"/run/user/9/hypr/abc/.socket.sock",
		);
	});

	test("falls back to the uid runtime dir otherwise", () => {
		expect(hyprCommandSocketPath({ HYPRLAND_INSTANCE_SIGNATURE: "abc" })).toBe(
			`/run/user/${process.getuid?.() ?? 1000}/hypr/abc/.socket.sock`,
		);
	});
});

describe("hyprGlidePaced", () => {
	test("applies every hop exactly once and in order", async () => {
		const fake = await startFakeCompositor(() => "ok");
		cleanups.push(fake.cleanup);

		const result = await hyprGlidePaced(hops(3, 0));

		expect(result).toEqual({ ok: true, applied: 3 });
		expect(fake.received).toEqual([
			"dispatch movecursor 100 200",
			"dispatch movecursor 101 201",
			"dispatch movecursor 102 202",
		]);
	});

	test("a refusal fails the journey closed and stops sending", async () => {
		const fake = await startFakeCompositor(index => (index === 1 ? "Invalid dispatcher" : "ok"));
		cleanups.push(fake.cleanup);

		const result = await hyprGlidePaced(hops(5, 0));

		expect(result.ok).toBe(false);
		expect(result.applied).toBe(1);
		expect(result.error).toContain("hop 1 refused");
		expect(result.error).toContain("Invalid dispatcher");
		// hop 2..4 must never reach the compositor after a refusal
		expect(fake.received).toHaveLength(2);
	});

	test("an unreachable socket fails closed instead of hanging", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hgnone-"));
		const previous = process.env.XDG_RUNTIME_DIR;
		process.env.HYPRLAND_INSTANCE_SIGNATURE = "absent";
		process.env.XDG_RUNTIME_DIR = dir;
		cleanups.push(async () => {
			if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
			else process.env.XDG_RUNTIME_DIR = previous;
			fs.rmSync(dir, { recursive: true, force: true });
		});

		const result = await hyprGlidePaced(hops(2, 0), { timeoutMs: 1000 });

		expect(result.ok).toBe(false);
		expect(result.error).toContain("hop 0 failed");
		expect(result.applied).toBe(0);
	});

	test("spacing holds at the dwell and recovers after a stalled hop", async () => {
		const gapMs = 60;
		const stallMs = 150;
		// hop 1's reply is delayed, so its round trip overruns the dwell.
		const fake = await startFakeCompositor(index => (index === 1 ? { delayMs: stallMs, text: "ok" } : "ok"));
		cleanups.push(fake.cleanup);

		const result = await hyprGlidePaced(hops(6, gapMs));

		expect(result.ok).toBe(true);
		const spacing = fake.arrivals.slice(1).map((at, i) => at - fake.arrivals[i]!);
		// Steady state: the dwell alone, with the round trip spent inside it
		// rather than added on top (which would be dwell + spawn).
		expect(spacing[0]).toBeGreaterThan(gapMs - 30);
		expect(spacing[0]).toBeLessThan(gapMs + 60);
		// The stall shows up as one late hop...
		expect(spacing[1]).toBeGreaterThanOrEqual(stallMs - 30);
		// ...and the next hop waits a normal dwell again instead of bursting
		// onto the following one to catch up.
		expect(spacing[2]).toBeGreaterThan(gapMs * 0.5);
		expect(spacing[2]).toBeLessThan(gapMs + 60);
	});

	test("frame lock holds every hop to a frame boundary and never bursts", async () => {
		// 10ms requested dwell is sub-frame at 60Hz: the frame lock must stretch
		// it to one whole frame (never shorten it) and keep the cadence even.
		const gapMs = 10;
		const frame = 16.667;
		const fake = await startFakeCompositor(() => "ok");
		cleanups.push(fake.cleanup);

		const result = await hyprGlidePaced(hops(5, gapMs), { frameMs: frame });

		expect(result.ok).toBe(true);
		expect(result.applied).toBe(5);
		const spacing = fake.arrivals.slice(1).map((at, i) => at - fake.arrivals[i]!);
		// Every hop waits at least the requested dwell AND is pushed out to the
		// next frame boundary — so spacing lands near one frame, never below the
		// 10ms request and never a catch-up burst.
		for (const gap of spacing) {
			expect(gap).toBeGreaterThanOrEqual(gapMs - 5);
			expect(gap).toBeLessThan(frame + 90);
		}
		// Spacing must be CONSISTENT (frame-locked), not ragged 1-frame/2-frame
		// alternation: every gap within one frame of the others.
		const maxSpacing = Math.max(...spacing);
		expect(maxSpacing - Math.min(...spacing)).toBeLessThan(frame + 20);
	});
	test("the frame grid is anchored to the glide, not to the epoch", async () => {
		// Regression: rounding the next hop up to an ABSOLUTE multiple of
		// frameMs snapped to the epoch grid, where dispatch times are
		// arbitrarily aligned. A sub-millisecond timer overshoot therefore
		// crossed a boundary and cost a FULL extra frame on nearly every hop
		// (measured live: 1.94 frames/hop, 89% of hops over 1.6 frames).
		// Anchoring the grid at the first hop makes the cadence exact, and
		// lateness degrade gracefully instead of doubling.
		const frame = 16.667;
		const fake = await startFakeCompositor(() => "ok");
		cleanups.push(fake.cleanup);

		const result = await hyprGlidePaced(hops(12, frame), { frameMs: frame });

		expect(result.ok).toBe(true);
		expect(result.applied).toBe(12);
		const spacing = fake.arrivals.slice(1).map((at, i) => at - fake.arrivals[i]!);
		for (const gap of spacing) {
			// Never shorter than the requested dwell, and never a 2-frame stall.
			expect(gap).toBeGreaterThanOrEqual(frame - 5);
			// Never shorter than the requested dwell. The ceiling sits between
			// the two measured distributions (anchored ≈1.06 frames, epoch
			// ≈1.94) so it tolerates CI jitter yet still fails the old form.
			expect(gap).toBeLessThan(frame * 1.8);
		}
		// Most hops land near a single frame — the doubling is gone.
		const nearSingle = spacing.filter(g => g < frame * 1.5).length;
		expect(nearSingle).toBeGreaterThanOrEqual(spacing.length - 1);
	});
	test("an abort stops before the next hop and never shortens the in-flight dwell", async () => {
		const gapMs = 40;
		const fake = await startFakeCompositor(() => "ok");
		cleanups.push(fake.cleanup);
		const controller = new AbortController();
		const seen: number[] = [];

		const started = performance.now();
		const result = await hyprGlidePaced(hops(6, gapMs), {
			signal: controller.signal,
			onHop: applied => {
				seen.push(applied);
				// Cancel DURING hop 2's dwell: hop 2 was already dispatched, so
				// its full frame-locked pause must still elapse (never-shorter),
	// and hop 3 must never reach the compositor.
				if (applied === 2) controller.abort();
			},
		});
		const elapsed = performance.now() - started;

		expect(result.ok).toBe(false);
		expect(result.aborted).toBe(true);
		expect(result.error).toBe("aborted");
		expect(result.applied).toBe(2);
		expect(seen).toEqual([1, 2]);
		expect(fake.received).toHaveLength(2);
		// Bounded by ONE hop's cadence past hop 2's own dwell: both dispatched
		// dwells ran (never shortened), and no third dispatch/dwell happened.
		expect(elapsed).toBeGreaterThanOrEqual(gapMs * 2 - 15);
		expect(elapsed).toBeLessThan(gapMs * 3 + 120);
	});

	test("a signal aborted before the start dispatches nothing", async () => {
		const fake = await startFakeCompositor(() => "ok");
		cleanups.push(fake.cleanup);
		const controller = new AbortController();
		controller.abort();

		const result = await hyprGlidePaced(hops(3, 0), { signal: controller.signal });

		expect(result).toEqual({ ok: false, applied: 0, error: "aborted", aborted: true });
		expect(fake.received).toHaveLength(0);
	});

	test("onHop fires once per applied hop in order; a throwing observer never breaks the glide", async () => {
		const fake = await startFakeCompositor(() => "ok");
		cleanups.push(fake.cleanup);
		const seen: Array<[number, number]> = [];

		const result = await hyprGlidePaced(hops(4, 0), {
			onHop: (applied, total) => {
				seen.push([applied, total]);
				if (applied === 2) throw new Error("observer exploded");
			},
		});

		expect(result).toEqual({ ok: true, applied: 4 });
		expect(seen).toEqual([
			[1, 4],
			[2, 4],
			[3, 4],
			[4, 4],
		]);
	});

	test("slow observer work started in onHop never extends the glide wall clock", async () => {
		const gapMs = 30;
		const n = 5;
		const fake = await startFakeCompositor(() => "ok");
		cleanups.push(fake.cleanup);
		const controller = new AbortController();

		const started = performance.now();
		const result = await hyprGlidePaced(hops(n, gapMs), {
			signal: controller.signal,
			onHop: () => {
				// Models the mid-flight captureLiveFrame: slow async work that
	// is scheduled, never awaited inside the hop loop.
				void new Promise<string>(resolve => setTimeout(() => resolve("frame"), 400));
			},
		});
		const elapsed = performance.now() - started;

		expect(result.ok).toBe(true);
		expect(result.applied).toBe(n);
		// Dwell-bound: n×gap ± tolerance. If the observer were awaited (or the
		// signal path cost anything), the 400ms task would push this past it.
		expect(elapsed).toBeGreaterThanOrEqual(gapMs * n - 15);
		expect(elapsed).toBeLessThan(gapMs * n + 150);
	});
});

describe("convergeCursorLanding", () => {
	test("a landing already on target costs no correction", async () => {
		const moved: Array<{ x: number; y: number }> = [];
		const landing = await convergeCursorLanding(
			{ x: 100, y: 100 },
			{
				read: async () => ({ x: 100, y: 100 }),
				move: async p => {
					moved.push(p);
				},
			},
		);
		expect(landing).toEqual({ read: { x: 100, y: 100 }, corrections: 0 });
		expect(moved).toHaveLength(0);
	});

	test("nudges the residual out and reports an exact landing", async () => {
		let pos = { x: 103, y: 100 };
		const landing = await convergeCursorLanding(
			{ x: 100, y: 100 },
			{
				read: async () => pos,
				move: async p => {
					pos = p;
				},
			},
		);
		expect(landing).toEqual({ read: { x: 100, y: 100 }, corrections: 1 });
	});

	test("stops as soon as a correction makes no progress (never loops)", async () => {
		let reads = 0;
		const landing = await convergeCursorLanding(
			{ x: 100, y: 100 },
			{
				read: async () => {
					reads++;
					return { x: 102, y: 100 }; // a platform that simply will not move
				},
				move: async () => {
					// no-op: the pointer never changes
				},
			},
		);
		expect(landing.read).toEqual({ x: 102, y: 100 });
		expect(landing.corrections).toBe(1);
		expect(reads).toBe(2);
	});

	test("respects maxCorrections and reports the residue as a mismatch", async () => {
		let pos = { x: 107, y: 100 };
		const landing = await convergeCursorLanding(
			{ x: 100, y: 100 },
			{
				read: async () => pos,
				move: async () => {
					pos = { x: pos.x - 1, y: pos.y }; // still improving, but never far enough
				},
				maxCorrections: 2,
			},
		);
		expect(landing.corrections).toBe(2);
		expect(landing.read).toEqual({ x: 105, y: 100 });
		// Bounded corrections must never let a bad landing claim success.
		expect(cursorVerifyNote({ x: 100, y: 100 }, landing.read)).toContain("MISMATCH");
	});

	test("an unreadable cursor reports no verdict at all", async () => {
		const landing = await convergeCursorLanding(
			{ x: 1, y: 1 },
			{ read: async () => null, move: async () => {} },
		);
		expect(landing).toEqual({ read: null, corrections: 0 });
		expect(cursorVerifyNote({ x: 1, y: 1 }, landing.read)).toBe("");
	});
});

function worstEmittedHeadingChangeDeg(
	from: { x: number; y: number },
	hops: Array<{ x: number; y: number }>,
): { worstDegrees: number; comparablePairs: number } {
	const points = [{ x: Math.round(from.x), y: Math.round(from.y) }, ...hops];
	const legs = points.slice(0, -1).map((point, i) => {
		const next = points[i + 1]!;
		return { x: next.x - point.x, y: next.y - point.y };
	});
	let worstDegrees = 0;
	let comparablePairs = 0;
	for (let i = 0; i + 1 < legs.length; i++) {
		const a = legs[i]!;
		const b = legs[i + 1]!;
		if (Math.hypot(a.x, a.y) <= 1.5 || Math.hypot(b.x, b.y) <= 1.5) continue;
		comparablePairs++;
		const cross = a.x * b.y - a.y * b.x;
		const dot = a.x * b.x + a.y * b.y;
		const degrees = Math.abs(Math.atan2(cross, dot) * (180 / Math.PI));
		worstDegrees = Math.max(worstDegrees, degrees);
	}
	return { worstDegrees, comparablePairs };
}

describe("C2-continuous glide curve", () => {
	const controlPoints = [
		{ x: 0, y: 0 },
		{ x: 80, y: 20 },
		{ x: 150, y: 160 },
		{ x: 260, y: 130 },
		{ x: 360, y: 280 },
		{ x: 500, y: 220 },
	];

	test("passes through every control point and has strictly increasing arc lengths", () => {
		const curve = catmullRomArcSampler(controlPoints);

		expect(curve.controlArc).toHaveLength(controlPoints.length);
		expect(curve.controlArc[0]).toBe(0);
		for (const [k, arc] of curve.controlArc.entries()) {
			const point = curve.at(arc);
			const controlPoint = controlPoints[k]!;
			expect(Math.hypot(point.x - controlPoint.x, point.y - controlPoint.y)).toBeLessThan(1e-9);
		}
		for (let k = 1; k < curve.controlArc.length; k++) {
			expect(curve.controlArc[k]!).toBeGreaterThan(curve.controlArc[k - 1]!);
		}
		expect(curve.controlArc[curve.controlArc.length - 1]!).toBeCloseTo(curve.total, 9);
	});

	test("bows meaningfully away from the straight endpoint chord", () => {
		const curve = catmullRomArcSampler(controlPoints);
		const midpoint = curve.at(curve.total / 2);
		const first = controlPoints[0]!;
		const last = controlPoints[controlPoints.length - 1]!;
		const chordMidpoint = { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 };

		expect(Math.hypot(midpoint.x - chordMidpoint.x, midpoint.y - chordMidpoint.y)).toBeGreaterThan(10);
	});

	test("keeps headings continuous across four interior corners at every pace", () => {
		const from = controlPoints[0]!;
		const waypoints = controlPoints.slice(1);
		for (const pace of ["brisk", "natural", "deliberate"] as const) {
			const trajectory = livePathTrajectory(from, waypoints, { pace });
			const { worstDegrees, comparablePairs } = worstEmittedHeadingChangeDeg(from, trajectory);

			// Guard against a vacuous pass if rounding ever leaves no comparable legs.
			expect(comparablePairs).toBeGreaterThan(0);
			expect(worstDegrees).toBeLessThan(45);
		}
	});

	test("lands exactly on every rounded waypoint at every pace", () => {
		const from = { x: 0.49, y: 0.49 };
		const waypoints = [
			{ x: 80.49, y: 20.49 },
			{ x: 150.6, y: 160.6 },
			{ x: 260.49, y: 130.49 },
			{ x: 360.6, y: 280.6 },
			{ x: 500.49, y: 220.49 },
		];
		const rounded = [{ x: Math.round(from.x), y: Math.round(from.y) }, ...waypoints].map(point => ({
			x: Math.round(point.x),
			y: Math.round(point.y),
		}));

		for (const pace of ["brisk", "natural", "deliberate"] as const) {
			const trajectory = livePathTrajectory(from, waypoints, { pace });
			const landing = trajectory[trajectory.length - 1]!;
			expect({ x: landing.x, y: landing.y }).toEqual(rounded[rounded.length - 1]);
			for (const waypoint of rounded.slice(1, -1)) {
				expect(trajectory.some(hop => hop.x === waypoint.x && hop.y === waypoint.y)).toBe(true);
			}
		}
	});

	test("emits integer coordinates only", () => {
		const from = controlPoints[0]!;
		const waypoints = controlPoints.slice(1);
		for (const pace of ["brisk", "natural", "deliberate"] as const) {
			const trajectory = livePathTrajectory(from, waypoints, { pace });
			expect(trajectory.length).toBeGreaterThan(0);
			for (const hop of trajectory) {
				expect(Number.isInteger(hop.x)).toBe(true);
				expect(Number.isInteger(hop.y)).toBe(true);
			}
		}
	});
});

describe("frame-cadence pacing", () => {
	test("parses real refresh rates and rejects unusable output", () => {
		expect(parseFrameMs("1920x1080@60.04900 at 0x0")).toBeCloseTo(16.6531, 3);
		expect(parseFrameMs("3840x2160@144.00 at 0x0")).toBeCloseTo(6.9444, 3);
		expect(parseFrameMs("garbage")).toBeNull();
		expect(parseFrameMs("1920x1080@0 at 0x0")).toBeNull();
		expect(parseFrameMs("1920x1080@-60 at 0x0")).toBeNull();
	});

	test("aligns gaps to whole frames without shortening or epsilon drift", () => {
		const frame = 16.667;
		expect(frameAlignedGap(0, frame)).toBe(0);
		expect(frameAlignedGap(-5, frame)).toBe(0);
		expect(frameAlignedGap(24, 0)).toBe(24);
		expect(frameAlignedGap(24, -frame)).toBe(24);
		expect(frameAlignedGap(frame, frame)).toBe(frame);
		expect(frameAlignedGap(frame * 2, frame)).toBe(frame * 2);

		for (const frameMs of [16.65, 16.667, 6.94, 33.33, 8.33]) {
			for (let gapMs = 1; gapMs <= 200; gapMs++) {
				expect(frameAlignedGap(gapMs, frameMs)).toBeGreaterThanOrEqual(gapMs);
			}
		}
	});

	test("maps each real pace gap to its expected whole-frame dwell", () => {
		const frame = 16.653;
		const expectedFrames = { brisk: 1, natural: 1, deliberate: 2 } as const;
		for (const pace of ["brisk", "natural", "deliberate"] as const) {
			const requestedGap = livePathPace(pace).gapMs;
			expect(frameAlignedGap(requestedGap, frame)).toBeCloseTo(frame * expectedFrames[pace], 3);
		}
	});

	test("keeps the unaligned xdotool script compatible and frame-aligns only when asked", () => {
		const pacedHops = [{ x: 5, y: 5, gapMs: 24 }];
		expect(xdoGlideScript(pacedHops)).toBe("mousemove --sync 5 5\nsleep 0.024\n");
		expect(xdoGlideScript(pacedHops, 16.653)).toBe("mousemove --sync 5 5\nsleep 0.033\n");
	});
});
