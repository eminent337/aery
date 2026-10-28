/**
 * Pure logic for the `live_eye` fast-glance action (desktop_control).
 * Kept free of side effects so it unit-tests without grim/hyprctl.
 */

/** Minimal shape of a Hyprland window used for eye targeting. */
export interface EyeWindow {
	at?: [number, number];
	size?: [number, number];
	title?: string;
	class?: string;
}

/** Physical-pixel crop rectangle on the full desktop. */
export interface EyeRegion {
	x: number;
	y: number;
	w: number;
	h: number;
}

/**
 * Resolve the grim geometry string for an eye glance.
 * Priority: explicit region > window at/size > undefined (fullscreen).
 * Zero/negative-size windows are ignored (treated as fullscreen fallback).
 */
export function buildEyeGeometry(region: EyeRegion | undefined, window: EyeWindow | undefined): string | undefined {
	if (region) return `${region.x},${region.y} ${region.w}x${region.h}`;
	if (window && window.size && window.size[0] > 0 && window.size[1] > 0) {
		const at = window.at ?? [0, 0];
		return `${at[0]},${at[1]} ${window.size[0]}x${window.size[1]}`;
	}
	return undefined;
}

/** Human-readable description of what the eye is looking at. */
export function describeEyeTarget(window: EyeWindow | undefined, geometry: string | undefined, target: string): string {
	if (window?.title) return `window "${window.title}" (${window.class ?? "unknown"})`;
	if (target === "fullscreen") return "fullscreen display";
	if (geometry) return `target "${target}" (${geometry})`;
	return `target "${target}" (fallback: fullscreen)`;
}

/**
 * Decide whether an opt-in `focusFirst` glance should read the focused
 * window's frame instead of the whole display.
 *
 * Why this exists (measured, not assumed): a fullscreen read captures the
 * whole 1920x1080 desktop and downscales it to 1280x800, so a 540x472
 * dialog is only ~7% of the canvas and its text lands below psm 6's reliable
 * floor — the button row comes back as a near-miss ("confirm th action").
 * Reading the SAME pixels cropped to the window keeps that text at native
 * scale: 3/3 phrases in ~0.5s versus 2/3 in ~3.0s.
 *
 * Deliberately conservative — it upgrades ONLY a bare `fullscreen` target,
 * and only when the window has a real, non-degenerate rect. Anything the
 * caller named explicitly (a region, a window query, an explicit
 * `active_window`) is left alone, and a window that cannot produce a crop
 * falls back to fullscreen rather than to a 0x0 frame. An explicit opt-in
 * must never change what the caller asked for beyond this one upgrade.
 */
export function shouldUseFocusedFrame(target: string, focusFirst: boolean = true, activeWindow?: EyeWindow): boolean {
	if (!focusFirst) return false;
	// Only the implicit default is upgradeable.
	if (target !== "fullscreen") return false;
	if (!activeWindow) return false;
	// A window that cannot be cropped must not become the frame.
	if (!activeWindow.size || activeWindow.size[0] <= 0 || activeWindow.size[1] <= 0) return false;
	return true;
}

/**
 * Runtime check for the ephemeral-eye marker in a tool result's details.
 * Unknown input tolerated — anything that isn't a marker object is false.
 */
export function eyeMarkPresent(details: unknown): boolean {
	if (!details || typeof details !== "object") return false;
	const marker = (details as { liveEye?: unknown }).liveEye;
	return typeof marker === "object" && marker !== null;
}
