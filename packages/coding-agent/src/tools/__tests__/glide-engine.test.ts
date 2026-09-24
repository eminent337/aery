import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { convergeCursorLanding, cursorVerifyNote } from "../desktop-control";
import { hyprCommandSocketPath, hyprGlidePaced, xdoGlideScript } from "../live-input";

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
