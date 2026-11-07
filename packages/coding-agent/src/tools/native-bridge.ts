/**
 * Native Wayland, GNOME, and X11 Bridge Dispatcher for Aery.
 *
 * Interfaces with native Rust bridges (wlroots-bridge, gnome-portal-bridge, x11-bridge)
 * for sub-20ms direct Wayland socket pointer/keyboard injection, in-memory screencopy,
 * and foreign-toplevel window management.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let cachedWlrootsBridge: string | null | undefined = undefined;
let cachedGnomeBridge: string | null | undefined = undefined;
let cachedX11Bridge: string | null | undefined = undefined;

/**
 * Check if a file exists and is executable.
 */
function isExecutable(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolve a bridge binary by checking:
 * 1. Explicit env override
 * 2. Vendor directory in Aery
 * 3. System bundled directory (/usr/lib/claude-desktop-bin/resources)
 * 4. Standard system search paths
 */
function resolveBridgeBinary(
	binName: string,
	envVar: string,
	cached: string | null | undefined,
	setCache: (val: string | null) => void,
): string | null {
	if (cached !== undefined) return cached;

	if (process.env[envVar] && isExecutable(process.env[envVar]!)) {
		const found = path.resolve(process.env[envVar]!);
		setCache(found);
		return found;
	}

	const candidates = [
		path.join(process.cwd(), "vendor/bin", binName),
		path.join(process.cwd(), "resources", binName),
		`/usr/lib/claude-desktop-bin/resources/${binName}`,
		`/usr/local/bin/${binName}`,
		`/usr/bin/${binName}`,
	];

	for (const candidate of candidates) {
		if (isExecutable(candidate)) {
			setCache(candidate);
			return candidate;
		}
	}

	// Try finding in PATH
	const pathDirs = (process.env.PATH || "").split(path.delimiter);
	for (const dir of pathDirs) {
		const full = path.join(dir, binName);
		if (isExecutable(full)) {
			setCache(full);
			return full;
		}
	}

	setCache(null);
	return null;
}

export function resolveWlrootsBridge(): string | null {
	return resolveBridgeBinary("wlroots-bridge", "AERY_WLROOTS_BRIDGE", cachedWlrootsBridge, val => {
		cachedWlrootsBridge = val;
	});
}

export function resolveGnomeBridge(): string | null {
	return resolveBridgeBinary("gnome-portal-bridge", "AERY_GNOME_BRIDGE", cachedGnomeBridge, val => {
		cachedGnomeBridge = val;
	});
}

export function resolveX11Bridge(): string | null {
	return resolveBridgeBinary("x11-bridge", "AERY_X11_BRIDGE", cachedX11Bridge, val => {
		cachedX11Bridge = val;
	});
}

/**
 * Execute a bridge CLI command and parse its single JSON stdout line.
 */
export async function runBridgeJson<T = any>(bin: string, args: string[], timeoutMs = 15000): Promise<T> {
	if (!bin) throw new Error("Bridge binary path not provided");

	const { stdout } = await execFileAsync(bin, args, {
		encoding: "utf-8",
		timeout: timeoutMs,
		maxBuffer: 32 * 1024 * 1024,
		env: {
			...process.env,
		},
	});

	const trimmed = stdout.trim();
	if (!trimmed) {
		return null as unknown as T;
	}

	try {
		return JSON.parse(trimmed) as T;
	} catch {
		const preview = trimmed.length > 250 ? trimmed.slice(0, 250) + "..." : trimmed;
		throw new Error(`${path.basename(bin)} returned non-JSON output: ${preview}`);
	}
}

// ---------------------------------------------------------------------------
// Bridge Command Argument Builders
// ---------------------------------------------------------------------------

export function bridgePointerMoveArgs(x: number, y: number): string[] {
	return ["pointer-move", "--x", String(Math.round(x)), "--y", String(Math.round(y))];
}

export function bridgePointerClickArgs(
	x: number,
	y: number,
	button: "left" | "right" | "middle" = "left",
	count = 1,
	modifiers?: string[],
): string[] {
	const args = [
		"pointer-click",
		"--x",
		String(Math.round(x)),
		"--y",
		String(Math.round(y)),
		"--button",
		button,
		"--count",
		String(Math.max(1, count)),
	];
	if (modifiers && modifiers.length > 0) {
		for (const mod of modifiers) {
			args.push("--modifier", mod);
		}
	}
	return args;
}

export function bridgePointerScrollArgs(x: number, y: number, dx = 0, dy = 0): string[] {
	return [
		"pointer-scroll",
		"--x",
		String(Math.round(x)),
		"--y",
		String(Math.round(y)),
		"--dx",
		String(Math.round(dx)),
		"--dy",
		String(Math.round(dy)),
	];
}

export function bridgePointerDragArgs(fromX: number, fromY: number, toX: number, toY: number): string[] {
	return [
		"pointer-drag",
		"--from-x",
		String(Math.round(fromX)),
		"--from-y",
		String(Math.round(fromY)),
		"--to-x",
		String(Math.round(toX)),
		"--to-y",
		String(Math.round(toY)),
	];
}

export function bridgeKeySequenceArgs(keys: string, repeat = 1): string[] {
	const args = ["key-sequence", "--keys", keys];
	if (repeat > 1) {
		args.push("--repeat", String(repeat));
	}
	return args;
}

export function bridgeTypeTextArgs(text: string, delayMs?: number): string[] {
	const args = ["type", "--text", text];
	if (delayMs !== undefined) {
		args.push("--delay-ms", String(delayMs));
	}
	return args;
}

export function bridgeScreenshotArgs(display?: string): string[] {
	const args = ["screenshot"];
	if (display) {
		args.push("--display", display);
	}
	return args;
}

export function bridgeZoomArgs(x: number, y: number, w: number, h: number, display?: string): string[] {
	const args = [
		"zoom",
		"--x",
		String(Math.round(x)),
		"--y",
		String(Math.round(y)),
		"--w",
		String(Math.round(w)),
		"--h",
		String(Math.round(h)),
	];
	if (display) {
		args.push("--display", display);
	}
	return args;
}

export function bridgeWindowsArgs(): string[] {
	return ["windows"];
}

export function bridgeFrontmostAppArgs(): string[] {
	return ["frontmost-app"];
}

export function bridgeActivateWindowArgs(windowId: string): string[] {
	return ["activate-window", "--window", windowId];
}
