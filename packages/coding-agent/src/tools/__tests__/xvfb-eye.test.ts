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
