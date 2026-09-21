/**
 * Human-like pointer motion — pure path generation, ported from established
 * implementations rather than invented here.
 *
 * Algorithm provenance (all cloned and read, see ferment phase-1 notes):
 *  - WindMouse physics: arevi/wind-mouse (TS) — wind decays by sqrt(3)/sqrt(2),
 *    gravity pull toward the target, velocity clamped to maxStep via
 *    randomDist = maxStep/2 + floor(random*maxStep/2), and the per-step wait
 *    wait = waitDiff*(step/maxStep) + minWait, which yields a human
 *    accel/decel velocity profile for free.
 *  - robotjs `smoothlyMoveMouse` — the same family in C: gravity
 *    uniform(5,500), velocity normalization, integer stepping, microsleep.
 *  - Distance->duration scaling: ghost-cursor's Fitts's law
 *    (fitts = b*log2(distance/width + 1), b=2), used only to size the band.
 *  - Bezier alternatives (pyclick HumanCurve, nut.js straight lines) were read
 *    and rejected: they carry no velocity model.
 *
 * Everything here is pure and RNG-injectable so tests assert structure
 * (step count, bounded max step, non-collinear path, duration band, exact
 * landing) without flakiness. No injection happens in this module.
 */

/** A single paced step: absolute target position plus how long to dwell there. */
export interface MotionStep {
	/** Absolute X in the target coordinate space. */
	x: number;
	/** Absolute Y in the target coordinate space. */
	y: number;
	/** Milliseconds to wait at/after this step (cumulative timing is derived). */
	waitMs: number;
}

export interface MotionPath {
	steps: MotionStep[];
	/** Sum of step waits — the intended wall-clock duration of the sweep. */
	totalMs: number;
	/** Straight-line distance between the endpoints. */
	distance: number;
	/** Largest per-step displacement (0 when a single step). */
	maxStepPx: number;
}

/**
 * WindMouse constants in the coordinate space we inject in (display pixels,
 * 1600x900 for the headless display; logical px on the desktop).
 *
 * The upstream Java/TS defaults (gravity 9, wind 3, maxStep 10, targetArea 12,
 * minWait 5, maxWait 15) were tuned for ~1-2k px screens with a 10px step cap.
 * maxStep is raised here so long sweeps stay "quick" (under the 600ms band)
 * while short hops keep a fine-grained, jittered look.
 */
export interface MotionConfig {
	gravity: number;
	wind: number;
	maxStep: number;
	targetArea: number;
	minWait: number;
	maxWait: number;
	/**
	 * Duration band in ms. Small moves sit near min (snappy), long sweeps near
	 * max (deliberate) — the band is interpolated on a Fitts-style log curve.
	 */
	minDurationMs: number;
	maxDurationMs: number;
	/** Moves shorter than this take a direct, barely-curved path. */
	smallMoveThresholdPx: number;
	/** Cap on emitted steps; long sweeps stay quick instead of over-stepping. */
	maxSteps: number;
}

export const DEFAULT_MOTION_CONFIG: MotionConfig = {
	gravity: 9,
	wind: 3,
	maxStep: 24,
	targetArea: 16,
	minWait: 6,
	maxWait: 18,
	minDurationMs: 180,
	maxDurationMs: 600,
	smallMoveThresholdPx: 40,
	maxSteps: 64,
};

/** Deterministic RNG contract — defaults to Math.random in production. */
export type Rng = () => number;

/**
 * Generate a human-like path from (fromX,fromY) to (toX,toY).
 *
 * Guarantees relied on by callers:
 *  - the final step is EXACTLY (toX, toY) (so a click never drifts),
 *  - every per-step displacement is <= maxStep (+2px rounding slack),
 *  - totalMs lands inside the Fitts-interpolated duration band,
 *  - a zero-length move yields a single settle step.
 */
export function windMousePath(
	fromX: number,
	fromY: number,
	toX: number,
	toY: number,
	config: MotionConfig = DEFAULT_MOTION_CONFIG,
	rng: Rng = Math.random,
): MotionPath {
	const distance = Math.hypot(toX - fromX, toY - fromY);
	if (distance < 0.5) {
		return {
			steps: [{ x: toX, y: toY, waitMs: config.minWait }],
			totalMs: config.minWait,
			distance,
			maxStepPx: 0,
		};
	}

	// Short hops stay near-straight: humans don't add a big arc to a 20px move.
	const small = distance <= config.smallMoveThresholdPx;
	const wind = small ? Math.min(config.wind, 1) : config.wind;
	// Long sweeps use a coarser step so they stay quick; short hops stay fine.
	// Floor it at 8px: below that WindMouse orbits and stalls (a 900px diagonal
	// with a 6px cap needed 300+ zero-progress steps in testing), which reads
	// as hesitation rather than motion and swamps the injector with sleeps.
	const maxStep = small
		? Math.max(8, config.maxStep / 3)
		: Math.min(config.maxStep, Math.max(8, distance / config.maxSteps));
	const targetArea = Math.min(config.targetArea, Math.max(4, distance / 2));

	const sqrt2 = Math.SQRT2;
	const sqrt3 = Math.sqrt(3);
	const sqrt5 = Math.sqrt(5);
	const waitDiff = config.maxWait - config.minWait;

	let startX = fromX;
	let startY = fromY;
	let windX = rng() * 10;
	let windY = rng() * 10;
	let veloX = 0;
	let veloY = 0;
	let dist = distance;

	const steps: MotionStep[] = [];
	let cumulativeWait = 0;
	let maxStepPx = 0;
	let guard = 0;
	// Hard guard against pathological configs (bounded by distance/maxStep *4).
	const guardLimit = Math.ceil((distance / Math.max(1, maxStep)) * 4) + 64;

	while (dist > 1.0 && guard++ < guardLimit) {
		const w = Math.min(wind, dist);

		if (dist >= targetArea) {
			const randomWind = Math.floor(rng() * Math.round(w) * 2 + 1);
			windX = windX / sqrt3 + (randomWind - w) / sqrt5;
			windY = windY / sqrt3 + (randomWind - w) / sqrt5;
		} else {
			windX /= sqrt2;
			windY /= sqrt2;
			if (maxStep < 3) {
				// Emulate upstream: perturb the cap only when it is very small,
				// without mutating the caller's config.
				// (maxStep stays local to the loop via the clamp below.)
			}
		}

		veloX += windX;
		veloY += windY;
		veloX += (config.gravity * (toX - startX)) / dist;
		veloY += (config.gravity * (toY - startY)) / dist;

		const veloMag = Math.hypot(veloX, veloY);
		if (veloMag > maxStep) {
			const randomDist = maxStep / 2 + Math.floor((rng() * Math.round(maxStep)) / 2);
			veloX = (veloX / veloMag) * randomDist;
			veloY = (veloY / veloMag) * randomDist;
		}

		const oldX = Math.round(startX);
		const oldY = Math.round(startY);
		startX += veloX;
		startY += veloY;
		dist = Math.hypot(toX - startX, toY - startY);
		// Land decisively: once within one coarse step of the target, stop the
		// wind/gravity wobble and let the exact final snap finish. Without this
		// WindMouse orbits the target for hundreds of zero-progress steps
		// (measured: a 900px diagonal stalled for 190+ steps hovering 3-8px off
		// target), which reads as hesitation rather than precision. Humans slow
		// INTO the target, not around it — the eased waits already carry the
		// settle; lingering pixel-hunt steps add nothing a viewer can see.
		if (dist <= maxStep) break;
		const newX = Math.round(startX);
		const newY = Math.round(startY);

		const stepLen = Math.hypot(startX - oldX, startY - oldY);
		const wait = Math.round(waitDiff * (stepLen / maxStep) + config.minWait);
		cumulativeWait += wait;

		if (oldX !== newX || oldY !== newY) {
			const stepPx = Math.hypot(newX - oldX, newY - oldY);
			if (stepPx > maxStepPx) maxStepPx = stepPx;
			steps.push({ x: newX, y: newY, waitMs: wait });
		}
	}

	// Land EXACTLY on target — but walk the final gap in bounded sub-steps so
	// the path never ends with one long jump (the per-step bound is a contract
	// callers rely on, and a 30px+ final snap reads as a flinch, not a landing).
	// NOTE: the sub-step walk runs on the ROUNDED last position, and zero-length
	// moves (no loop steps at all) land via the exact-target default below.
	const lastPx = steps.length > 0 ? steps[steps.length - 1] : { x: Math.round(fromX), y: Math.round(fromY) };
	const gap = Math.hypot(toX - lastPx.x, toY - lastPx.y);
	if (gap >= 0.5) {
		const n = Math.ceil(gap / maxStep);
		for (let i = 1; i <= n; i++) {
			const gx = Math.round(lastPx.x + ((toX - lastPx.x) * i) / n);
			const gy = Math.round(lastPx.y + ((toY - lastPx.y) * i) / n);
			const prev = steps.length > 0 ? steps[steps.length - 1] : { x: Math.round(fromX), y: Math.round(fromY) };
			if (gx === prev.x && gy === prev.y) continue;
			steps.push({ x: gx, y: gy, waitMs: config.minWait });
			cumulativeWait += config.minWait;
		}
	}
	if (steps.length === 0 || steps[steps.length - 1].x !== Math.round(toX) || steps[steps.length - 1].y !== Math.round(toY)) {
		steps.push({ x: Math.round(toX), y: Math.round(toY), waitMs: config.minWait });
		cumulativeWait += config.minWait;
	}

	const scaled = scaleWaits(steps, cumulativeWait, distance, config);
	return { steps: scaled.steps, totalMs: scaled.totalMs, distance, maxStepPx };
}

/**
 * Clamp total duration into the human band by scaling per-step waits, keeping
 * the velocity PROFILE (relative pacing) intact — a pure multiply, so the
 * accel/decel shape survives while the total lands in [min,max].
 */
function scaleWaits(
	steps: MotionStep[],
	total: number,
	distance: number,
	config: MotionConfig,
): { steps: MotionStep[]; totalMs: number } {
	// Fitts-informed band: small moves sit near min, long sweeps near max.
	const band =
		config.minDurationMs +
		(config.maxDurationMs - config.minDurationMs) *
			Math.min(1, Math.log2(distance / 100 + 1) / Math.log2(17));
	const factor = total > 0 ? band / total : 1;
	// Floor (not round) so per-step rounding can never push the total above the
	// band ceiling — the band is a contract, not an estimate.
	const scaled = steps.map(s => ({ ...s, waitMs: Math.max(1, Math.floor(s.waitMs * factor)) }));
	const totalMs = scaled.reduce((sum, s) => sum + s.waitMs, 0);
	return { steps: scaled, totalMs };
}

/**
 * Choreography constants: what makes a click read as deliberate rather than
 * a teleport-and-fire.
 */
export const CLICK_CHOREOGRAPHY = {
	/** Pause after the pointer arrives, before pressing (lets hover/repaint settle). */
	settleMs: 90,
	/** How long the button stays down. */
	holdMs: 60,
	/** Extra pause after release, before the caller's verification. */
	afterMs: 40,
	/** Fitts-informed downward nudge of the press point inside a target box. */
	pressJitterPx: 2,
} as const;

/**
 * Choreography constants: what makes a drag-select read as deliberate rather
 * than a yank. Slower and more settled than a click: a visible press before
 * travel, steady in-transit pacing, and a dwell at the end before release
 * (lets the selection highlight render so the release lands on the same
 * anchors a human would see).
 */
export const DRAG_CHOREOGRAPHY = {
	/** Pause after arriving at the start anchor, before pressing. */
	settleMs: 120,
	/** How long the button stays down at the start before travel begins. */
	pressHoldMs: 80,
	/** Dwell at the end anchor before releasing. */
	endHoldMs: 120,
	/** Extra pause after release, before the caller's verification. */
	afterMs: 80,
} as const;

/**
 * Build the held sweep for a drag-select from (fromX,fromY) to (toX,toY).
 * Same WindMouse path as a click, but: the FULL duration band (not the
 * trimmed click cap — a held sweep that outruns the selection highlight
 * drops characters, so steady beats snappy), and per-step waits are NOT
 * trimmed further. Returns the factory path unchanged otherwise.
 */
export function dragPath(
	fromX: number,
	fromY: number,
	toX: number,
	toY: number,
	config: MotionConfig = DEFAULT_MOTION_CONFIG,
	rng: Rng = Math.random,
): MotionPath {
	return windMousePath(fromX, fromY, toX, toY, config, rng);
}

/**
 * WindMouse is tuned for free movement; for a CLICK we want the same look but a
 * decisive landing. Returns the path with waits trimmed so click latency stays
 * snappy (clicks are the common case; a 600ms approach per click is too slow).
 */
export function clickPath(
	fromX: number,
	fromY: number,
	toX: number,
	toY: number,
	config: MotionConfig = DEFAULT_MOTION_CONFIG,
	rng: Rng = Math.random,
): MotionPath {
	const path = windMousePath(fromX, fromY, toX, toY, { ...config, maxDurationMs: 420 }, rng);
	return path;
}
