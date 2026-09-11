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
export function buildEyeGeometry(
	region: EyeRegion | undefined,
	window: EyeWindow | undefined,
): string | undefined {
	if (region) return `${region.x},${region.y} ${region.w}x${region.h}`;
	if (window && window.size && window.size[0] > 0 && window.size[1] > 0) {
		const at = window.at ?? [0, 0];
		return `${at[0]},${at[1]} ${window.size[0]}x${window.size[1]}`;
	}
	return undefined;
}

/** Human-readable description of what the eye is looking at. */
export function describeEyeTarget(
	window: EyeWindow | undefined,
	geometry: string | undefined,
	target: string,
): string {
	if (window?.title) return `window "${window.title}" (${window.class ?? "unknown"})`;
	if (target === "fullscreen") return "fullscreen display";
	if (geometry) return `target "${target}" (${geometry})`;
	return `target "${target}" (fallback: fullscreen)`;
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
