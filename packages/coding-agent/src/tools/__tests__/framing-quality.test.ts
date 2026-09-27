import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ocrFrame } from "../screen-ocr";

/**
 * Ground-truth quality fixtures for the eye.
 *
 * Character count is a useless quality metric here — a read can carry 900
 * chars of other windows' prose and still have lost the dialog's button row.
 * That is exactly why xvfbRescueWanted gates on word-box COVERAGE rather than
 * char count. So every assertion here is per-PHRASE recall against a known
 * ground truth, never a character or word count.
 *
 * The two fixtures are the same pixels at two framings, captured from a real
 * live yad dialog (540x472) on a busy Hyprland desktop:
 *   dialog-sparse-540x472.png     the window-targeted capture (tight crop)
 *   desktop-sparse-1280x720.png   the fullscreen capture after the eye's
 *                                 1280x800 downscale
 *
 * They were captured from a real desktop on purpose. A synthetic
 * ImageMagick-rendered fixture was built first and REJECTED: black-on-white
 * synthetic text reads perfectly at both framings, so it cannot reproduce
 * the trap and would be a vacuous test that passes before and after any
 * change. Real antialiased font pixels are the only thing that shrinks below
 * psm 6's reliable floor.
 */
// NOTE the directory name: `ocr-fixtures`, NOT `fixtures`. graph.test.ts
// uses __dirname/fixtures as scratch space and calls
// fs.rmSync(fixtureDir, {recursive: true, force: true}) on cleanup, which
// deletes a sibling `fixtures/` directory wholesale. A committed fixture dir
// with that name is destroyed by an unrelated test run — which is exactly
// what happened, twice, before this was found.
const FIXTURES = path.join(import.meta.dir, "ocr-fixtures");
const CROP = path.join(FIXTURES, "dialog-sparse-540x472.png");
const DOWNSCALED = path.join(FIXTURES, "desktop-sparse-1280x720.png");

/** The phrases a correct read must recover. */
const GROUND_TRUTH = ["Confirm the action", "Continue", "Abort"];
/**
 * Read a fixture, failing LOUDLY and SPECIFICALLY if it is missing.
 *
 * This deliberately does NOT retry. An earlier version retried on an empty
 * reading on the theory that full-suite CPU contention was making tesseract
 * return nothing — that theory was wrong and the retry only hid the real
 * cause (graph.test.ts recursively deleting this directory, so tesseract was
 * being handed a nonexistent path and returning empty). A missing fixture
 * must fail as a missing fixture, not as a mystery quality regression.
 */
async function readFixture(p: string): Promise<string> {
	if (!fs.existsSync(p)) {
		throw new Error(
			`OCR fixture missing: ${p}\n` +
				`If this directory vanished, check whether another test rmSync'd it — ` +
				`graph.test.ts owns __dirname/fixtures as scratch space and this dir must stay named ocr-fixtures.`,
		);
	}
	return (await ocrFrame(p)).text;
}
/** Normalise the way the eye's own consumers do: case-fold, collapse space. */
const norm = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();

function found(reading: string): string[] {
	const h = norm(reading);
	return GROUND_TRUTH.filter(p => h.includes(norm(p)));
}

describe("eye framing quality (ground truth)", () => {
	test("a window-targeted capture recovers every ground-truth phrase", async () => {
		expect(found(await readFixture(CROP))).toEqual(GROUND_TRUTH);
	});

	test("the fullscreen downscale loses phrases the window capture keeps", async () => {
		// This is the defect the framing strategy fixes. It is asserted
		// explicitly so that if some future change accidentally makes the
		// fullscreen read good enough, the test tells us the fixture is
		// stale rather than silently reporting a false pass.
		const down = await readFixture(DOWNSCALED);
		const crop = await readFixture(CROP);
		expect(found(crop).length).toBe(3);
		expect(found(down).length).toBeLessThan(3);
	});

	test("the trap is fragmentation, not absence: the phrase is near-miss garbled, not missing", async () => {
		// Under the fullscreen downscale the dialog's own line came back as
		// "confirm th action" — a near-miss, not an omission. That matters
		// because a char-count assertion would score this as a PASS (the
		// characters are all there, just wrong) and a substring assertion on
		// "the action" is too brittle to pin. Assert the near-miss shape:
		// most of the phrase survives, so the defect is segmentation at
		// small scale rather than the region being unreadable.
		const h = norm(await readFixture(DOWNSCALED));
		expect(h).toContain("confirm");
		expect(h).toContain("action");
		expect(found(h)).not.toContain("Confirm the action");
	});
});
