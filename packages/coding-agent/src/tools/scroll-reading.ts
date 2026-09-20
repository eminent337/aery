/**
 * Scroll-aware reading primitives (Read-while-scrolling ferment, phase 1).
 *
 * Gap proven by the settle-only baseline (/tmp/scrollbase.json,
 * /tmp/scrollanim.json): a PageDown jumps scroll 0 → 880 instantly, mid-motion
 * frames OCR fine (38–69 words vs 52–62 settled), but ScrollBurstSample only
 * carries a fingerprint (no words) and rememberClickTargets is last-write-wins
 * with no scroll context — so nothing is readable WHILE the view moves and a
 * mid-motion read would silently poison settled targets.
 *
 * This module will own the scroll-aware layer:
 *  - viewport-space word box + scroll offset → stable document-space identity
 *  - merge per-frame words into scroll-tagged targets across a scroll
 *  - settle detection from the scroll-offset history
 *  - scroll-tagged target resolution (stale offsets never resolve blindly)
 *
 * Phase-1 pinning: every function throws until phase 2/3 implements it.
 * The pinning tests fail on these throws — the right reason — while the
 * change-based gate pin (same address+rect stays fresh at any age) passes.
 */
import type { OcrWordBox } from "./screen-ocr";
import type { ClickTarget } from "./desktop-control";
import type { ObservationController } from "./live-observe";

/** A click target tagged with where it was read: viewport box + scroll
 *  offset + stable document-space y (viewport y + scroll offset). */
export interface ScrollTaggedTarget extends ClickTarget {
	/** Scroll offset (px) of the frame this target was read from. */
	scrollY: number;
	/** Stable identity across frames: viewport y + scroll offset. */
	docY: number;
}

/** Match tolerance (px) when reconciling the same word across frames.
 *  Covers OCR box jitter (±few px); a full row height apart is distinct. */
export const SCROLL_MERGE_TOLERANCE_PX = 8;

/** Map a viewport-space word box to stable document space: the word's
 *  position when the page is scrolled to 0. X never changes with scroll. */
export function scrollWordToDocument(word: OcrWordBox, scrollY: number): OcrWordBox {
	return { ...word, y: Math.round(word.y + (Number.isFinite(scrollY) ? scrollY : 0)) };
}

/**
 * Merge one mid-motion frame's words into scroll-tagged targets.
 * Same text at the same document y (within tolerance) is ONE target moved
 * to the new viewport box; genuinely new text is added; targets that
 * scrolled out of view are dropped. Low-confidence (blurred) words are
 * carried, never confidence-filtered — thresholding is the caller's policy.
 */
export function mergeScrollTargets(
	prev: ScrollTaggedTarget[],
	words: OcrWordBox[],
	scrollY: number,
	_viewH: number,
): ScrollTaggedTarget[] {
	if (!Number.isFinite(scrollY)) return [...prev];
	const out: ScrollTaggedTarget[] = prev.map(t => ({ ...t }));
	for (const w of words) {
		if (!w.text || !Number.isFinite(w.x) || !Number.isFinite(w.y) || w.w <= 0 || w.h <= 0) continue;
		const docY = Math.round(w.y + scrollY);
		const hit = out.findIndex(
			t => t.text.toLowerCase() === w.text.toLowerCase() && Math.abs(t.docY - docY) <= SCROLL_MERGE_TOLERANCE_PX,
		);
		if (hit >= 0) {
			// same page row seen again: adopt the NEWEST viewport box so the
			// target stays clickable where it is right now; keep the best
			// confidence (a crisper settled reread upgrades a blurred pass).
			const t = out[hit];
			out[hit] = {
				...t, x: w.x, y: w.y, w: w.w, h: w.h, confidence: Math.max(t.confidence, w.confidence),
				scrollY, docY,
			};
		} else {
			out.push({ text: w.text, x: w.x, y: w.y, w: w.w, h: w.h, confidence: w.confidence, scrollY, docY });
		}
	}
	// drop targets scrolled out of view: recompute each target's viewport
	// position at the CURRENT offset (docY - scrollY) — a stale viewport y
	// would keep long-scrolled-past rows alive. A target seen in THIS frame
	// (same scrollY) always survives: mid-motion it may sit partially
	// outside the viewport and must not be dropped before its next reread.
	const visible: ScrollTaggedTarget[] = [];
	for (const t of out) {
		const vpY = t.docY - scrollY;
		const inView = vpY >= -SCROLL_MERGE_TOLERANCE_PX && vpY + t.h <= _viewH + SCROLL_MERGE_TOLERANCE_PX;
		if (inView || t.scrollY === scrollY) visible.push(t);
	}
	return visible;
}

/**
 * True when the trailing scroll offsets are all equal (view stopped moving).
 * Non-finite offsets never count as settled — fail-closed.
 */
export function scrollSettled(offsets: number[], need = 3): boolean {
	const tail = offsets.slice(-need);
	if (tail.length < need) return false;
	return tail.every(v => Number.isFinite(v) && v === tail[0]);
}

/**
 * Resolve target text against scroll-tagged targets. With scrollY supplied,
 * only same-offset targets compete — a stale-offset target NEVER resolves
 * blindly (fail-closed: re-anchor instead of mis-aiming). Without scrollY,
 * best match wins (current global behavior, backward compatible).
 */
export function resolveScrollTarget(
	targets: ScrollTaggedTarget[],
	text: string,
	scrollY?: number,
): { x: number; y: number; box: ScrollTaggedTarget } | null {
	const q = text.trim().toLowerCase();
	if (!q) return null;
	let pool = targets;
	if (scrollY !== undefined) pool = pool.filter(t => t.scrollY === scrollY);
	const matches = pool.filter(t => t.text.toLowerCase().includes(q));
	if (matches.length === 0) return null;
	const best = matches.sort((a, b) => {
		const ea = a.text.toLowerCase() === q ? 0 : 1;
		const eb = b.text.toLowerCase() === q ? 0 : 1;
		if (ea !== eb) return ea - eb;
		if (a.text.length !== b.text.length) return a.text.length - b.text.length;
		return a.y - b.y || a.x - b.x;
	})[0];
	return { x: best.x + Math.round(best.w / 2), y: best.y + Math.round(best.h / 2), box: best };
}

/** --- Reading feed policy (phase 2) ------------------------------------ */

/** One mid-scroll reading: where the page is and (optionally) what was read. */
export interface ScrollReading {
	address: string;
	scrollY: number;
	ocrText?: string;
	ocrConfidence?: number;
}

/** PURE decision core for feeding ONE mid-scroll reading into the
 *  observation controller — the scroll analogue of observeRefresherTick.
 *  Rules (all fail-closed):
 *  - snapshot missing/superseded → stop (nothing to keep fresh)
 *  - generation mismatch → noop (a replace() re-anchors and restarts)
 *  - reading address ≠ snapshot address → noop (a mis-aimed read can never
 *    ride another window's identity)
 *  - non-finite scroll offset → noop (never invent data)
 *  - otherwise → note scrollY (+ OCR when supplied) and re-assert
 *    freshness: scroll moves content, not the window, so the reading
 *    stays anchored to the same scene.
 *  Desktop I/O stays outside — callers capture + probe, then feed here. */
export function scrollReadTick(
	generation: number,
	reading: ScrollReading,
	control: ObservationController,
	now = Date.now(),
): { action: "stop" | "noop" | "note"; notedScrollY?: number } {
	const snap = control.get();
	if (!snap || snap.superseded) return { action: "stop" };
	if (generation !== snap.generation) return { action: "noop" };
	if (reading.address !== snap.address) return { action: "noop" };
	if (!Number.isFinite(reading.scrollY)) return { action: "noop" };
	const noted = control.noteScrollY(generation, reading.scrollY, now);
	if (!noted) return { action: "noop" };
	if (reading.ocrText !== undefined) {
		control.noteOcr(generation, reading.ocrText, reading.ocrConfidence, now);
	}
	return { action: "note", notedScrollY: reading.scrollY };
}

/** --- Burst reader (phase 3): capture + OCR while the view moves ------- */

/** Reuse the proven scroll-burst cadence table (desktop-control). */
export function planScrollReadBurst(input: { count?: number; scrollSpeed?: string; observeDuringScroll?: boolean }): {
	steps: number;
	intervalMs: number;
	speed: "slow" | "normal" | "fast";
	sample: boolean;
} {
	const steps = Math.max(1, Math.min(input.count ?? 1, 20));
	const speed = input.scrollSpeed === "slow" || input.scrollSpeed === "fast" ? input.scrollSpeed : "normal";
	const intervalMs = speed === "slow" ? 600 : speed === "fast" ? 80 : 250;
	return { steps, intervalMs, speed, sample: input.observeDuringScroll ?? true };
}

/** Quality verdict for ONE mid-motion frame: enough real words, confident
 *  enough to be crisp rather than motion-smeared, and (when a settled
 *  baseline vocabulary is supplied) some overlap with known page text —
 *  blur garbles glyphs, so a frame full of long low-confidence junk is
 *  untrustworthy. Trust gates USE of a reading, never safety: focus/
 *  identity guards are separate and always enforced. */
export interface ScrollFrameQuality {
	wordCount: number;
	/** Fraction of words present in the settled baseline vocabulary (1 when no baseline). */
	overlap: number;
	trustworthy: boolean;
}

export function scrollFrameQuality(
	words: Array<Pick<OcrWordBox, "text" | "confidence">>,
	baseline?: Set<string>,
): ScrollFrameQuality {
	const wordCount = words.length;
	let overlap = 1;
	if (baseline && baseline.size > 0 && wordCount > 0) {
		const hit = words.filter(w => baseline.has(w.text.toLowerCase())).length;
		overlap = hit / wordCount;
	}
	// Crisp text on this bench reads ≥3 words; smear collapses to junk.
	const enoughWords = wordCount >= 3;
	const conf = wordCount > 0 ? words.reduce((s, w) => s + w.confidence, 0) / wordCount : 0;
	const crisp = conf >= 0.5;
	const coherent = baseline && baseline.size > 0 && wordCount > 0 ? overlap >= 0.3 : true;
	return { wordCount, overlap, trustworthy: enoughWords && crisp && coherent };
}

/** Injected I/O for runScrollReadBurst — all desktop contact is injectable,
 *  so the loop itself stays pure and unit-testable. */
export interface ScrollReadBurstIO {
	intervalMs: number;
	sample: boolean;
	expectedWindowAddress: string;
	signal?: AbortSignal;
	control: ObservationController;
	assertFocus: (expected: string | undefined) => Promise<string | null>;
	run: (argv: string[]) => Promise<string | null>;
	/** Capture one frame DURING motion: returns the page's scroll offset at
	 *  capture time + the capture timestamp. */
	captureFrame: () => Promise<{ scrollY: number; at: number; path: string }>;
	/** OCR + quality-score one captured frame. */
	ocrFrame: (path: string) => Promise<{ words: OcrWordBox[]; quality: ScrollFrameQuality }>;
}

export interface ScrollReadBurstResult {
	failure: string | null;
	completedSteps: number;
	readings: Array<{ scrollY: number; at: number; path: string; quality: ScrollFrameQuality }>;
	targets: ScrollTaggedTarget[];
}

/** Scroll burst that READS: per guarded step, inject one scroll command,
 *  capture + OCR mid-motion, feed scrollReadTick, and merge the frame's
 *  words into scroll-tagged targets. Untrustworthy frames are recorded but
 *  NOT merged (blur never poisons the target map). Focus loss aborts before
 *  the next injection — same contract as runScrollBurst. */
export async function runScrollReadBurst(
	steps: string[][],
	io: ScrollReadBurstIO,
): Promise<ScrollReadBurstResult> {
	const readings: ScrollReadBurstResult["readings"] = [];
	let targets: ScrollTaggedTarget[] = [];
	let completedSteps = 0;
	for (let i = 0; i < steps.length; i++) {
		if (io.signal?.aborted) return { failure: `Scroll-read burst aborted before step ${i + 1}.`, completedSteps, readings, targets };
		const focusError = await io.assertFocus(io.expectedWindowAddress);
		if (focusError) return { failure: focusError, completedSteps, readings, targets };
		const stepFailure = await io.run(steps[i]);
		if (stepFailure) return { failure: stepFailure, completedSteps, readings, targets };
		completedSteps++;
		if (io.sample) {
			try {
				const frame = await io.captureFrame();
				const { words, quality } = await io.ocrFrame(frame.path);
				readings.push({ scrollY: frame.scrollY, at: frame.at, path: frame.path, quality });
				if (quality.trustworthy) {
					scrollReadTick(io.control.get()?.generation ?? -1, { address: io.expectedWindowAddress, scrollY: frame.scrollY }, io.control, frame.at);
					targets = mergeScrollTargets(targets, words, frame.scrollY, 880);
				}
			} catch {
				// a capture/OCR hiccup must never kill the burst
			}
		}
		if (i < steps.length - 1 && io.intervalMs > 0) {
			await new Promise(r => setTimeout(r, io.intervalMs));
		}
	}
	return { failure: null, completedSteps, readings, targets };
}
