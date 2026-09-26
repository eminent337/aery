/** Capture/OCR child priority while a pointer glide is in flight.
 *
 *  Root cause this exists (cadence profiling, 4-core box at load ~3): hop
 *  spacing under concurrent capture load measured 78ms median against a ~17ms
 *  target — NOT from timer lateness (Bun timers stay accurate even under hot
 *  children; p50 ≈ 0ms) but from IPC round-trip inflation: un-niced convert /
 *  tesseract / grim / identify children starve BOTH the compositor (whose
 *  scheduling delays every movecursor ack) and the parent loop. Measured
 *  directly: RTT 1.45ms idle → 30–131ms under load, and the glide's spacing
 *  ≈ max(RTT, one frame). Renicing just our capture children to +15 restores
 *  perfect cadence under identical load: hop p50 125ms → 16.3ms, RTT → 0.55ms,
 *  timer lateness → ~0.
 *
 *  Mechanism: `nice -n 15 <cmd> <args>` argv wrapper (no shell — argument
 *  vectors pass through untouched; nice execvp's the target in place, so the
 *  child pid, timeout, and SIGKILL semantics are unchanged). Chosen over
 *  process.setpriority, which Bun does not implement.
 *
 *  Scope: a module-level flag armed ONLY around a live_move glide (and its
 *  concurrent same-turn captures), cleared in a finally with a 60s stuck-flag
 *  safety net. Allowlist = observation binaries; input injectors (ydotool,
 *  xdotool, wtype) and window-management dispatches never lose priority.
 *  Pacing math and the frozen glide contracts are untouched — this only
 *  changes OS scheduling of capture children.
 */
import { execFile } from "node:child_process";

const GLIDE_CAPTURE_NICE = 15;
const ARM_MAX_MS = 60_000;

let niceLevel = 0;
let armedAt = 0;

/** Arm (on=true) or disarm (on=false) capture niceness during a glide. */
export function setGlideCaptureNice(on: boolean): void {
	niceLevel = on ? GLIDE_CAPTURE_NICE : 0;
	armedAt = on ? Date.now() : 0;
}

/** Current niceness for capture children (0 = off). Auto-disarms if a code
 *  path ever fails to clear the flag (stuck-flag safety net). */
export function glideCaptureNice(): number {
	if (niceLevel > 0 && Date.now() - armedAt > ARM_MAX_MS) {
		niceLevel = 0;
		armedAt = 0;
	}
	return niceLevel;
}

/** Pure allowlist: observation/capture binaries lose priority during a glide;
 *  input injection and window dispatches never do. */
export function shouldNiceCapture(cmd: string, args: string[]): boolean {
	const bin = cmd.split("/").pop() ?? cmd;
	switch (bin) {
		case "grim":
		case "convert":
		case "magick":
		case "identify":
		case "tesseract":
		case "swaymsg":
		case "wlr-randr":
			return true;
		case "hyprctl":
			// `hyprctl dispatch` injects input / moves windows — keep priority.
			// Everything else (activewindow, cursorpos, monitors, clients) is
			// observation work a glide can afford to yield on.
			return args[0] !== "dispatch";
		default:
			return false;
	}
}

/** How a command should be spawned right now: passthrough, or wrapped in
 *  `nice -n <level>` when the glide flag is armed and the cmd is capture work.
 *  Pure decision — the exec layer just runs the plan. */
export function captureExecPlan(cmd: string, args: string[]): { bin: string; args: string[] } {
	const nice = glideCaptureNice();
	if (nice > 0 && shouldNiceCapture(cmd, args)) {
		return { bin: "nice", args: ["-n", String(nice), cmd, ...args] };
	}
	return { bin: cmd, args };
}

/** execFile honoring the glide-capture plan — drop-in replacement for
 *  promisified(execFile) (same resolve shape, same error with stdout/stderr). */
export function execFileNiced(
	cmd: string,
	args: string[],
	opts: { env?: NodeJS.ProcessEnv; timeout?: number; signal?: AbortSignal; maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
	const plan = captureExecPlan(cmd, args);
	return new Promise((resolve, reject) => {
		const child = execFile(plan.bin, plan.args, opts, (err, stdout, stderr) => {
			if (err) {
				const e = err as NodeJS.ErrnoException & { stdout?: unknown; stderr?: unknown };
				e.stdout = stdout;
				e.stderr = stderr;
				reject(e);
			} else {
				resolve({ stdout: String(stdout), stderr: String(stderr) });
			}
		});
		// Touch child so the spawn is acknowledged before we return; niceness
		// is already carried by the argv plan (nice execs in place).
		void child.pid;
	});
}
