import { describe, expect, test } from "bun:test";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(exec);

/** Pins for headlessEyeRead — the xvfb eye's read path. Contract mirrors
 *  live_eye: downscale once, OCR, clickTargets in frame px, fullscreen frame
 *  anchored at origin, no silent empty reading when the frame has text.
 *  These tests need no Xvfb: they run against synthetic root captures. */

const IMG = "/tmp/aerys-xvfb-eye-pin.png";
const BLANK = "/tmp/aerys-xvfb-eye-blank.png";

async function synth(): Promise<void> {
	// 1600x900 "root capture" with big black-on-white words (OCR-friendly).
	await run(
		`convert -size 1600x900 xc:white -font FreeSans -pointsize 72 -fill black -annotate +120+300 "APPROVE LAUNCH SETTINGS" -annotate +120+600 "STATUS ONLINE" ${IMG}`,
	);
	await run(`convert -size 1600x900 xc:white ${BLANK}`);
}

describe("headlessEyeRead (xvfb eye)", () => {
	test("reads text and words from a synthetic root capture", async () => {
		await synth();
		const { headlessEyeRead } = await import("../desktop-control");
		const r = await headlessEyeRead({ rawPath: IMG, physW: 1600, physH: 900 });
		expect(r.ocrError).toBeUndefined();
		expect(r.text.length).toBeGreaterThan(10);
		expect(r.words).toBeGreaterThan(3);
		expect(r.emptyRoot).toBe(false);
	});

	test("clickTargets include a placed word at its on-image position", async () => {
		await synth();
		const { headlessEyeRead } = await import("../desktop-control");
		const r = await headlessEyeRead({ rawPath: IMG, physW: 1600, physH: 900 });
		const approve = r.targets.filter(t => /approve/i.test(t.text));
		expect(approve.length).toBeGreaterThan(0);
		// Word was annotated at +120+300 PHYSICAL px; targets are SCALED-frame
		// px (1600→1280 = ×0.8 ⇒ expect ≈96,240). Slack covers glyph bearing
		// and OCR box drift; a wildly wrong box fails here.
		const t = approve[0];
		expect(Math.abs(t.x - 96)).toBeLessThan(60);
		expect(Math.abs(t.y - 240)).toBeLessThan(60);
	});

	test("every target confidence is a 0..1 fraction (canonical scale)", async () => {
		await synth();
		const { headlessEyeRead } = await import("../desktop-control");
		const r = await headlessEyeRead({ rawPath: IMG, physW: 1600, physH: 900 });
		expect(r.targets.length).toBeGreaterThan(0);
		for (const t of r.targets) {
			expect(t.confidence).toBeGreaterThanOrEqual(0);
			expect(t.confidence).toBeLessThanOrEqual(1);
		}
	});

	test("frame is a fullscreen frame anchored at the origin with real geometry", async () => {
		await synth();
		const { headlessEyeRead } = await import("../desktop-control");
		const r = await headlessEyeRead({ rawPath: IMG, physW: 1600, physH: 900 });
		expect(r.frame.kind).toBe("fullscreen");
		expect(r.frame.atX).toBe(0);
		expect(r.frame.atY).toBe(0);
		expect(r.frame.physW).toBe(1600);
		expect(r.frame.physH).toBe(900);
		expect(r.frame.scaledW).toBeLessThanOrEqual(1280); // default cap
		expect(r.frame.scaledH).toBeLessThanOrEqual(800);
	});

	test("honors maxWidth cap for the scaled frame", async () => {
		await synth();
		const { headlessEyeRead } = await import("../desktop-control");
		const r = await headlessEyeRead({ rawPath: IMG, physW: 1600, physH: 900, maxWidth: 640 });
		expect(r.frame.scaledW).toBeLessThanOrEqual(640);
	});

	test("blank capture is flagged emptyRoot with no crash and no fake text", async () => {
		await synth();
		const { headlessEyeRead } = await import("../desktop-control");
		const r = await headlessEyeRead({ rawPath: BLANK, physW: 1600, physH: 900 });
		expect(r.emptyRoot).toBe(true);
		expect(r.text).toBe("");
		expect(r.targets).toEqual([]);
	});
});

describe("headlessEyeRead segmentation rescue (content crop)", () => {
	const DIALOG = "/tmp/aerys-xvfb-eye-dialog.png";

	/** A small dialog on a big blank desktop — the exact shape that made
	 *  tesseract's --psm 6 block layout drop the button row entirely. */
	async function synthDialog(): Promise<void> {
		await run(
			`convert -size 1600x900 xc:white -fill black -draw "rectangle 20,20 540,260" -fill white -font FreeSans -pointsize 22 -annotate +40+60 "Headless approval required" -font FreeSans -pointsize 20 -annotate +70+230 "Approve" -annotate +230+230 "Deny" ${DIALOG}`,
		);
	}

	test("reads a small dialog's buttons off a large blank canvas", async () => {
		await synthDialog();
		const { headlessEyeRead } = await import("../desktop-control");
		const r = await headlessEyeRead({ rawPath: DIALOG, physW: 1600, physH: 900 });
		// Regression: the button row used to vanish (only the body text read).
		expect(r.text).toMatch(/Headless approval required/);
		expect(r.text).toMatch(/Approve/);
		expect(r.text).toMatch(/Deny/);
	});

	test("rescued words land in full-frame coords, not crop coords", async () => {
		await synthDialog();
		const { headlessEyeRead } = await import("../desktop-control");
		const r = await headlessEyeRead({ rawPath: DIALOG, physW: 1600, physH: 900 });
		const b = r.targets.find(t => /Approve/i.test(t.text));
		expect(b).toBeDefined();
		// On the full capture "Approve" sits near x≈70..150, y≈222..236; the
		// crop offset must be folded back so the box is nowhere near the crop
		// origin (which would be a few px in from the frame edge).
		expect(b!.x).toBeGreaterThan(40);
		expect(b!.y).toBeGreaterThan(150);
	});

	test("dense full-canvas captures are untouched by the rescue path", async () => {
		// The rescue only fires on a sparse read; a well-filled capture must
		// still read exactly as before (no crop, no coordinate folding).
		await synth();
		const { headlessEyeRead } = await import("../desktop-control");
		const r = await headlessEyeRead({ rawPath: IMG, physW: 1600, physH: 900 });
		expect(r.text).toContain("APPROVE LAUNCH SETTINGS");
		expect(r.text).toContain("STATUS ONLINE");
	});
});

describe("xvfbContentCrop (trim geometry)", () => {
	test("finds content bounds and returns a padded crop", async () => {
		const BIG = "/tmp/aerys-xvfb-crop-big.png";
		const { exec } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const runLocal = promisify(exec);
		await runLocal(
			`convert -size 1600x900 xc:white -fill black -draw "rectangle 100,400 400,500" ${BIG}`,
		);
		const { xvfbContentCrop } = await import("../desktop-control");
		const c = await xvfbContentCrop(BIG);
		expect(c).not.toBeNull();
		expect(c!.x).toBe(100);
		expect(c!.y).toBe(400);
		// Inclusive draw bounds: 100..400 is 300 or 301 px wide depending on
		// how IM rounds the rectangle's last row/column.
		expect(c!.w).toBeGreaterThanOrEqual(300);
		expect(c!.w).toBeLessThanOrEqual(301);
		expect(c!.h).toBeGreaterThanOrEqual(100);
		expect(c!.h).toBeLessThanOrEqual(101);
		expect(c!.pad).toBeGreaterThan(0);
	});

	test("declines to crop when content already fills the canvas", async () => {
		const FULL = "/tmp/aerys-xvfb-crop-full.png";
		const { exec } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const runLocal = promisify(exec);
		await runLocal(`convert -size 1600x900 xc:white -fill black -draw "rectangle 0,0 1599,899" ${FULL}`);
		const { xvfbContentCrop } = await import("../desktop-control");
		expect(await xvfbContentCrop(FULL)).toBeNull();
	});

	test("an all-blank canvas yields no crop", async () => {
		await synth();
		const { xvfbContentCrop } = await import("../desktop-control");
		expect(await xvfbContentCrop(BLANK)).toBeNull();
	});
});

describe("xvfbCompositeWindows (ARGB fallback)", () => {
	test("stacked windows become readable with fullscreen-origin coordinates", async () => {
		// Black "root capture" (what bare Xvfb yields: no compositor) plus a
		// small white window crop pasted onto it by the composite path.
		const ROOT = "/tmp/aerys-xvfb-composite-root.png";
		const WIN = "/tmp/aerys-xvfb-composite-win.png";
		const { exec } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const runLocal = promisify(exec);
		// A white 520x260 window with OCR-friendly words at its local origin.
		await runLocal(
			`convert -size 520x260 xc:white -font FreeSans -pointsize 48 -fill black -annotate +30+90 "STACKED OK" ${WIN}`,
		);
		// Sanity: the window crop itself reads.
		const { headlessEyeRead, xvfbCompositeWindows, xvfbFrameToDisplay } = await import("../desktop-control");
		const winRead = await headlessEyeRead({ rawPath: WIN, physW: 520, physH: 260 });
		expect(winRead.emptyRoot).toBe(false);
		expect(winRead.text).toMatch(/STACKED/);
		// The composite helper pastes the window at its absolute position;
		// here we verify the parts that need no X server: null when no
		// window contributes, and fullscreen-origin mapping is untouched.
		const none = await xvfbCompositeWindows(ROOT, []);
		expect(none).toBeNull();
		// Fullscreen-origin mapping: scaled (640x360 of 1600x900) → display.
		const [dx, dy] = xvfbFrameToDisplay(320, 180, { physW: 1600, physH: 900, scaledW: 640, scaledH: 360 });
		expect(dx).toBe(800);
		expect(dy).toBe(450);
	});
});

describe("xvfbRescueWanted (coverage gate)", () => {
	test("clustered words on a big canvas want the rescue (the yad trap)", async () => {
		const { xvfbRescueWanted } = await import("../desktop-control");
		// The yad form after typing: rows at y≈250..300 on a 1280x720 canvas —
		// ~28 chars read fine yet the button row vanished. Coverage, not
		// character count, is the trap.
		const words = [
			{ x: 180, y: 240, w: 300, h: 20 },
			{ x: 520, y: 240, w: 260, h: 20 },
			{ x: 180, y: 280, w: 200, h: 18 },
		];
		expect(xvfbRescueWanted(words, 1280, 720)).toBe(true);
	});

	test("words spread across the canvas are dense (no rescue)", async () => {
		const { xvfbRescueWanted } = await import("../desktop-control");
		const words = [
			{ x: 100, y: 100, w: 200, h: 24 },
			{ x: 1000, y: 120, w: 180, h: 24 },
			{ x: 120, y: 560, w: 240, h: 24 },
			{ x: 980, y: 600, w: 200, h: 24 },
		];
		expect(xvfbRescueWanted(words, 1280, 720)).toBe(false);
	});

	test("an empty read always wants the rescue", async () => {
		const { xvfbRescueWanted } = await import("../desktop-control");
		expect(xvfbRescueWanted([], 1280, 720)).toBe(true);
	});
});
