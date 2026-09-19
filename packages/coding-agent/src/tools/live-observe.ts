/**
 * Continuous observation controller (Continuous visual control, phase-2).
 *
 * A bounded, session-scoped record of "what the eye last saw" for ONE exact
 * window address. It never injects input — it only tracks freshness metadata
 * so live_* actions can consume a fresh anchored reading or refuse safely.
 *
 * Design rules (from phase-1 D001/M001/M002):
 * - Anchored to the exact Hyprland client address; any address mismatch
 *   makes the snapshot unusable for input (fail-closed).
 * - Freshness is explicit (capturedAt + maxAgeMs); stale snapshots refuse.
 * - Replacement bumps the generation and supersedes the old snapshot so a
 *   focus change can never drive input from the previous window's frame.
 * - Cancellation supersedes the snapshot and stops any auto-refresh timer.
 * - Bounded: one snapshot only, one timer only, OCR text capped.
 */

import type { InputFrame } from "./live-input";

/** Cap so one OCR reading cannot grow the observation without bound. */
export const OBSERVATION_MAX_TEXT_CHARS = 8000;

/** Default freshness horizon: a reading older than this is stale for input. */
export const DEFAULT_OBSERVATION_MAX_AGE_MS = 1500;

export interface ObservationPolicy {
	/** Max age of a snapshot for it to be usable for input. */
	maxAgeMs: number;
	/** When true, the active window address must equal the snapshot address. */
	requireAddressMatch: boolean;
}

export const DEFAULT_OBSERVATION_POLICY: ObservationPolicy = {
	maxAgeMs: DEFAULT_OBSERVATION_MAX_AGE_MS,
	requireAddressMatch: true,
};

/** Rect of a focused window as the compositor probe reports it. */
export interface WindowRect {
	at: [number, number];
	size: [number, number];
}

export interface ObservationSnapshot {
	/** Generation that created this snapshot; bumped on start/replace. */
	generation: number;
	/** Exact window address this reading is anchored to. */
	address: string;
	/** Coordinate frame of the capture (null until the first frame lands). */
	frame: InputFrame | null;
	/** Wall-clock ms when the frame was captured. */
	capturedAt: number;
	/** Rect of the anchored WINDOW (not the capture crop) when the probe
	 *  reported one. Authoritative for change detection: a region glance on a
	 *  window yields a frame whose physW/physH is the crop, so the frame rect
	 *  alone cannot prove the window has not moved/resized. */
	windowRect?: WindowRect;
	/** Change digest of the capture (cheap fingerprint, optional). */
	digest?: string;
	/** Latest OCR text for this snapshot (capped, optional). */
	ocrText?: string;
	/** Wall-clock ms when the OCR text was read. */
	ocrAt?: number;
	/** Mean OCR confidence 0..1 when the reader reports it. */
	ocrConfidence?: number;
	/** True once superseded by replace()/cancel() — never usable. */
	superseded?: boolean;
}

export type ObservationRefusalReason = "missing" | "superseded" | "stale" | "address_mismatch";

export type ObservationSelection =
	| { ok: true; snapshot: ObservationSnapshot; ageMs: number }
	| { ok: false; reason: ObservationRefusalReason; ageMs: number | null; detail: string };

/** Age of a snapshot in ms; never negative. */
export function observationAgeMs(snapshot: ObservationSnapshot, now = Date.now()): number {
	return Math.max(0, now - snapshot.capturedAt);
}

/** True when the snapshot is live, un-superseded, and within maxAgeMs. */
export function isObservationFresh(
	snapshot: ObservationSnapshot | undefined,
	now = Date.now(),
	maxAgeMs = DEFAULT_OBSERVATION_MAX_AGE_MS,
): boolean {
	if (!snapshot || snapshot.superseded) return false;
	return observationAgeMs(snapshot, now) <= maxAgeMs;
}

/** True when the snapshot is anchored to exactly this window address. */
export function observationMatchesAddress(
	snapshot: ObservationSnapshot | undefined,
	activeAddress: string | undefined,
): boolean {
	if (!snapshot || !activeAddress) return false;
	return snapshot.address === activeAddress;
}

/**
 * Central selection gate for live input: return the snapshot only when it is
 * present, un-superseded, fresh, and (when required) anchored to the active
 * window. Otherwise return a fail-closed refusal with an actionable reason.
 */
export function selectObservationForInput(
	snapshot: ObservationSnapshot | undefined,
	activeAddress: string | undefined,
	now = Date.now(),
	policy: ObservationPolicy = DEFAULT_OBSERVATION_POLICY,
): ObservationSelection {
	if (!snapshot) {
		return { ok: false, reason: "missing", ageMs: null, detail: "No continuous observation yet — take a live_eye glance first." };
	}
	if (snapshot.superseded) {
		return {
			ok: false, reason: "superseded", ageMs: observationAgeMs(snapshot, now),
			detail: `Observation generation ${snapshot.generation} was superseded by a focus change or cancel — re-anchor before driving input.`,
		};
	}
	const ageMs = observationAgeMs(snapshot, now);
	if (ageMs > policy.maxAgeMs) {
		return {
			ok: false, reason: "stale", ageMs,
			detail: `Observation is ${ageMs}ms old (limit ${policy.maxAgeMs}ms) — refresh the glance before driving input.`,
		};
	}
	if (policy.requireAddressMatch && snapshot.address !== activeAddress) {
		return {
			ok: false, reason: "address_mismatch", ageMs,
			detail: `Observation is anchored to ${snapshot.address} but the active window is ${activeAddress ?? "none"} — re-anchor before driving input.`,
		};
	}
	return { ok: true, snapshot, ageMs };
}

/**
 * Session-scoped controller holding at most ONE live snapshot. All desktop
 * I/O stays outside: callers feed frames/OCR in via noteFrame()/noteOcr()
 * (from the eye/watch capture path in step-2); the controller owns only
 * generation lifecycle, freshness, and the fail-closed selection gate.
 */
export class ObservationController {
	private generation = 0;
	private current: ObservationSnapshot | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;

	/** Start (or restart) observation anchored to an exact window address.
	 *  windowRect is the anchored WINDOW's rect (probe-reported), the
	 *  authoritative identity for change detection — see ObservationSnapshot. */
	start(address: string, frame: InputFrame | null = null, now = Date.now(), windowRect?: WindowRect): number {
		this.stopTimer();
		this.generation += 1;
		this.current = { generation: this.generation, address, frame, capturedAt: now, ...(windowRect ? { windowRect } : {}) };
		return this.generation;
	}

	/** Latest snapshot (no freshness check — use select()/isStale() first). */
	get(): ObservationSnapshot | undefined {
		return this.current;
	}

	get running(): boolean {
		return this.current !== undefined && !this.current.superseded;
	}

	/** Feed a fresh frame for the CURRENT generation; ignores stale writers. */
	noteFrame(generation: number, frame: InputFrame, digest?: string, now = Date.now()): boolean {
		if (!this.current || this.current.superseded || generation !== this.generation) return false;
		this.current.frame = frame;
		this.current.capturedAt = now;
		if (digest !== undefined) this.current.digest = digest;
		return true;
	}

	/** Attach OCR text to the CURRENT generation (capped); ignores stale writers. */
	noteOcr(generation: number, text: string, confidence?: number, now = Date.now()): boolean {
		if (!this.current || this.current.superseded || generation !== this.generation) return false;
		this.current.ocrText = text.length > OBSERVATION_MAX_TEXT_CHARS ? text.slice(0, OBSERVATION_MAX_TEXT_CHARS) : text;
		this.current.ocrAt = now;
		if (confidence !== undefined) this.current.ocrConfidence = confidence;
		return true;
	}

	/**
	 * Atomically re-anchor to a new window address (focus change). The old
	 * snapshot is superseded so it can never drive input again.
	 */
	replace(address: string, frame: InputFrame | null = null, now = Date.now(), windowRect?: WindowRect): number {
		if (this.current) this.current.superseded = true;
		this.stopTimer();
		this.generation += 1;
		this.current = { generation: this.generation, address, frame, capturedAt: now, ...(windowRect ? { windowRect } : {}) };
		return this.generation;
	}

	/** Refresh the anchored window's rect for the CURRENT generation (cheap
	 *  probe data, no capture); ignores stale writers. */
	noteWindowRect(generation: number, windowRect: WindowRect, now = Date.now()): boolean {
		if (!this.current || this.current.superseded || generation !== this.generation) return false;
		this.current.windowRect = windowRect;
		this.current.capturedAt = now;
		return true;
	}

	/** True when there is no usable snapshot (missing/superseded/stale). */
	isStale(now = Date.now(), maxAgeMs = DEFAULT_OBSERVATION_MAX_AGE_MS): boolean {
		return !isObservationFresh(this.current, now, maxAgeMs);
	}

	/** Fail-closed gate bound to this controller's snapshot. */
	select(
		activeAddress: string | undefined,
		now = Date.now(),
		policy: ObservationPolicy = DEFAULT_OBSERVATION_POLICY,
	): ObservationSelection {
		return selectObservationForInput(this.current, activeAddress, now, policy);
	}

	/** Cancel observation: supersede the snapshot and stop auto-refresh. */
	cancel(): void {
		if (this.current) this.current.superseded = true;
		this.stopTimer();
	}

	/**
	 * Bounded auto-refresh driver: at most one timer; the callback performs
	 * one capture cycle and feeds it back via noteFrame/noteOcr. The timer
	 * carries the generation so a replace()/cancel() mid-flight cannot
	 * resurrect a superseded snapshot.
	 */
	startAutoRefresh(generation: number, intervalMs: number, onTick: (generation: number) => void): boolean {
		if (generation !== this.generation || !this.current || this.current.superseded) return false;
		if (!Number.isFinite(intervalMs) || intervalMs < 50 || intervalMs > 5000) return false;
		this.stopTimer();
		this.timer = setInterval(() => {
			if (generation !== this.generation || !this.current || this.current.superseded) {
				this.stopTimer();
				return;
			}
			onTick(generation);
		}, intervalMs);
		return true;
	}

	private stopTimer(): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}
}
