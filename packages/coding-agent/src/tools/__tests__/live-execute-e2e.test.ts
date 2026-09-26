import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { glideCaptureNice } from "../capture-priority";
import { DesktopControlTool } from "../desktop-control";
import { setFrameMsForTesting } from "../live-input";

/** execute()-level E2E for eye-cursor concurrency, against a FAKE compositor.
 *
 *  Unit tests cover hyprGlidePaced / pairing / trajectory in isolation; this
 *  file drives the real DesktopControlTool.execute() path end-to-end — same
 *  module instance, same-turn Promise.all, real AbortSignal — while every
 *  external seam is faked so the standard battery never touches a desktop:
 *    • movecursor hops land on a fake Hyprland command socket (stateful: it
 *      records the pointer so the landing verify sees a genuine Δ0,0),
 *    • hyprctl / grim are PATH shims (window probe, cursor read, monitor
 *      scale/refresh, capture),
 *    • the cursor state file is shared between socket and shim, mirroring how
 *      the real compositor is the single source of truth for both.
 *  This is the class of coverage that let the trajectory regressions ship:
 *  unit tests passed while execute()-level behavior was broken.
 */

const WINDOW = { address: "0x1337dead", at: [100, 100] as [number, number], size: [900, 700] as [number, number] };

let root = "";
let shimDir = "";
let stateDir = "";
let server: net.Server | null = null;
let savedEnv: Record<string, string | undefined> = {};

const STATE_FILES: Record<string, string> = {
	"activewindow.json": JSON.stringify({
		address: WINDOW.address,
		title: "E2E Target",
		class: "e2etarget",
		workspace: { name: "1" },
		at: WINDOW.at,
		size: WINDOW.size,
		pid: 424242,
		xwayland: false,
	}),
	"clients.json": JSON.stringify([
		{
			address: WINDOW.address,
			title: "E2E Target",
			class: "e2etarget",
			workspace: { name: "1" },
			at: WINDOW.at,
			size: WINDOW.size,
			pid: 424242,
			xwayland: false,
			mapped: true,
			hidden: false,
			floating: false,
			monitor: 0,
		},
	]),
	// Text form feeds frameMs() (`WxH@rate`), JSON form feeds detectOutputScale.
	"monitors.json": JSON.stringify([
		{ id: 0, name: "DP-1", width: 1920, height: 1080, refreshRate: 60.049, scale: 1, x: 0, y: 0 },
	]),
	cursor: "300,300",
};

const HYPRCTL_SHIM = `#!/bin/sh
S="$FAKE_STATE_DIR"
case "$1" in
  activewindow) cat "$S/activewindow.json" 2>/dev/null || printf '{}';;
  clients) cat "$S/clients.json" 2>/dev/null || printf '[]';;
  monitors)
    if [ "$2" = "-j" ]; then cat "$S/monitors.json" 2>/dev/null || printf '[]'
    else printf 'Monitor DP-1 (ID 0):\\n\\t1920x1080@60.04900 at 0x0\\n'; fi;;
  cursorpos)
    xy=$(cat "$S/cursor" 2>/dev/null || printf '0,0')
    x=\${xy%,*}; y=\${xy#*,}
    printf '{"x":%s,"y":%s}' "$x" "$y";;
  dispatch)
    # dispatch movecursor X Y — the landing warp's coordinate space matches
    # the socket-dispatched hops, so convergence reads its own writes.
    if [ "$2" = "movecursor" ]; then printf '%s,%s' "$3" "$4" > "$S/cursor.tmp"; mv "$S/cursor.tmp" "$S/cursor"; fi
    exit 0;;
  *) exit 0;;
esac
`;

const GRIM_SHIM = `#!/bin/sh
geom=""; out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-g" ]; then geom="$a"; fi
  prev="$a"; out="$a"
done
if [ -n "$geom" ]; then
  box=\${geom##* }
  W=\${box%x*}; H=\${box#*x}
  convert "$FAKE_SCREEN" -resize "\${W}x\${H}!" "$out" >/dev/null 2>&1 || cp "$FAKE_SCREEN" "$out"
else
  cp "$FAKE_SCREEN" "$out"
fi
exit 0
`;

beforeAll(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "live-e2e-"));
	shimDir = path.join(root, "shim");
	stateDir = path.join(root, "state");
	fs.mkdirSync(shimDir, { recursive: true });
	fs.mkdirSync(stateDir, { recursive: true });
	for (const [name, content] of Object.entries(STATE_FILES)) fs.writeFileSync(path.join(stateDir, name), content);
	fs.writeFileSync(path.join(shimDir, "hyprctl"), HYPRCTL_SHIM, { mode: 0o755 });
	fs.writeFileSync(path.join(shimDir, "grim"), GRIM_SHIM, { mode: 0o755 });

	// Synthetic screen with readable text (OCR paths must have something).
	const screen = path.join(root, "screen.png");
	const bake = Bun.spawnSync([
		"convert",
		"-size",
		"1920x1080",
		"xc:#1c2333",
		"-font",
		"FreeSans",
		"-pointsize",
		"48",
		"-fill",
		"white",
		"-annotate",
		"+120+300",
		"FAKE TARGET WINDOW",
		screen,
	]);
	if (bake.exitCode !== 0) throw new Error(`screen bake failed: ${new TextDecoder().decode(bake.stderr)}`);

	// Fake Hyprland command socket: stateful movecursor → shared cursor file.
	const runtime = path.join(root, "runtime");
	const hyprDir = path.join(runtime, "hypr", "testsig");
	fs.mkdirSync(hyprDir, { recursive: true });
	const socketPath = path.join(hyprDir, ".socket.sock");
	server = net.createServer(socket => {
		socket.on("error", () => {});
		socket.on("data", chunk => {
			const cmd = chunk.toString("utf8");
			const m = /dispatch movecursor (-?\d+) (-?\d+)/.exec(cmd);
			if (m) {
				const tmp = path.join(stateDir, "cursor.tmp");
				fs.writeFileSync(tmp, `${m[1]},${m[2]}`);
				fs.renameSync(tmp, path.join(stateDir, "cursor"));
			}
			socket.end("ok");
		});
	});
	await new Promise<void>((resolve, reject) => {
		server!.once("error", reject);
		server!.listen(socketPath, () => resolve());
	});

	savedEnv = {
		PATH: process.env.PATH,
		HYPRLAND_INSTANCE_SIGNATURE: process.env.HYPRLAND_INSTANCE_SIGNATURE,
		XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
		FAKE_STATE_DIR: process.env.FAKE_STATE_DIR,
		FAKE_SCREEN: process.env.FAKE_SCREEN,
	};
	process.env.PATH = `${shimDir}:${process.env.PATH}`;
	process.env.HYPRLAND_INSTANCE_SIGNATURE = "testsig";
	process.env.XDG_RUNTIME_DIR = runtime;
	process.env.FAKE_STATE_DIR = stateDir;
	process.env.FAKE_SCREEN = screen;
}, 30000);

afterAll(async () => {
	// Refresher must die BEFORE env restore (its ticks spawn shim binaries).
	try {
		const tool = new DesktopControlTool(undefined);
		await tool.execute("cleanup-mode", { action: "live_mode_off" });
	} catch {
		/* mode may never have come on */
	}
	setFrameMsForTesting(null);
	if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	if (root) fs.rmSync(root, { recursive: true, force: true });
}, 30000);

const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
	r.content.find(c => c.type === "text")?.text ?? "";

describe("execute()-level eye-cursor concurrency (fake compositor)", () => {
	test("live_mode_on pre-authorizes live_move", async () => {
		const tool = new DesktopControlTool(undefined);
		const r = await tool.execute("mode", { action: "live_mode_on", preAuthorize: ["live_move"] });
		expect(r.details).toMatchObject({ liveMode: true });
		expect(textOf(r)).toContain("live_move");
	}, 30000);

	test("same-turn [screenshot + live_move]: mid-flight frames, exact landing", async () => {
		const tool = new DesktopControlTool(undefined);
		// Anchor the observation first (freshness gate needs a current frame).
		const anchor = await tool.execute("anchor", { action: "screenshot" });
		expect(textOf(anchor)).toContain("Captured screenshot");

		const t0 = performance.now();
		let shotDoneMs = -1;
		const shotP = tool.execute("eye", { action: "screenshot" }).then(r => {
			shotDoneMs = performance.now() - t0;
			return r;
		});
		const partials: Array<{ text: string; applied: number | undefined; total: number | undefined }> = [];
		const glideP = tool.execute(
			"glide",
			{
				action: "live_move",
				path: [
					{ x: 60, y: 60 },
					{ x: 460, y: 60 },
					{ x: 460, y: 260 },
				],
				pace: "natural",
			},
			undefined,
			p => {
				const d = (p.details ?? {}) as { glideProgress?: { applied: number; total: number } };
				partials.push({ text: textOf(p), applied: d.glideProgress?.applied, total: d.glideProgress?.total });
			},
		);
		const [shot, glide] = await Promise.all([shotP, glideP]);
		const glideMs = performance.now() - t0;

		// The eye returned WHILE the cursor was still moving.
		expect(textOf(shot)).toContain("Captured screenshot");
		expect(shotDoneMs).toBeGreaterThan(0);
		expect(shotDoneMs).toBeLessThan(glideMs);

		const gTxt = textOf(glide);
		const gDetails = (glide.details ?? {}) as { midFlightFrames?: string[] };
		expect(gTxt).toContain("Glided through 3 waypoints");
		expect(gTxt).toContain("Cursor verify OK (Δ0,0px");
		// Mid-flight observation: bounded captures, each a file on disk.
		const mid = gDetails.midFlightFrames ?? [];
		expect(mid.length).toBeGreaterThanOrEqual(1);
		expect(mid.length).toBeLessThanOrEqual(4);
		for (const p of mid) expect(fs.existsSync(p)).toBe(true);
		expect(gTxt).toMatch(/Captured \d+ mid-flight frames?\./);
		// Streaming progress partials: at least one, hop counts coherent.
		expect(partials.length).toBeGreaterThanOrEqual(1);
		let prevApplied = 0;
		for (const p of partials) {
			expect(p.text).toMatch(/^Gliding… \d+\/\d+ hops \(/);
			expect(typeof p.applied).toBe("number");
			expect(p.applied!).toBeGreaterThanOrEqual(prevApplied);
			expect(p.applied!).toBeLessThanOrEqual(p.total!);
			prevApplied = p.applied!;
		}
		// The glide disarms capture niceness on every exit path.
		expect(glideCaptureNice()).toBe(0);
	}, 120000);

	test("abort through execute(): applied < total, landing warp skipped, pointer partway", async () => {
		const tool = new DesktopControlTool(undefined);
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 400);
		const readCursor = (): [number, number] => {
			const [x, y] = fs.readFileSync(path.join(stateDir, "cursor"), "utf8").trim().split(",").map(Number);
			return [x, y];
		};
		const [startX, startY] = readCursor();

		const abortPartials: number[] = [];
		const r = await tool.execute(
			"abort-glide",
			{
				action: "live_move",
				path: [
					{ x: 80, y: 60 },
					{ x: 80, y: 600 },
				],
				pace: "natural",
			},
			ac.signal,
			p => {
				const d = (p.details ?? {}) as { glideProgress?: { applied: number } };
				if (d.glideProgress) abortPartials.push(d.glideProgress.applied);
			},
		);
		const details = (r.details ?? {}) as { aborted?: boolean; applied?: number; total?: number };
		const txt = textOf(r);

		expect(details.aborted).toBe(true);
		expect(typeof details.applied).toBe("number");
		expect(typeof details.total).toBe("number");
		expect(details.applied!).toBeLessThan(details.total!);
		expect(txt).toContain("cancel signal");
		expect(txt).toContain("focus re-asserted");
		expect(txt).toContain("landing warp skipped");
		// Progress streamed before the cancel landed — and never past total.
		expect(abortPartials.length).toBeGreaterThanOrEqual(1);
		expect(Math.max(...abortPartials)).toBeLessThan(details.total!);

		expect(glideCaptureNice()).toBe(0);
		// The pointer stopped short of the final waypoint: target is
		// physical (180,700) — frame origin (100,100) + waypoint (80,600) —
		// while an un-aborted run would have landed exactly there.
		const [endX, endY] = readCursor();
		expect(startX === endX && startY === endY).toBe(false);
		const landedOnTarget = Math.hypot(endX - 180, endY - 700) <= 2;
		expect(landedOnTarget).toBe(false);
	}, 120000);
});
