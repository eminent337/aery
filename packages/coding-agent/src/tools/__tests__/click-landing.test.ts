import { describe, expect, test } from "bun:test";
import { clickLandingNote, cursorVerifyNote } from "../desktop-control";

const AIM = { x: 100, y: 200 };

/**
 * These tests pin the REPORTING contract of the closed-loop `live_click`.
 *
 * The defect being fixed: `live_click` used to report `physical (x,y)` — the
 * point it intended — and nothing else, so a click that landed somewhere else
 * was indistinguishable from one that landed correctly. Every case below
 * asserts what the model is told, because that text is the entire point of the
 * change: a click must be able to admit where the pointer actually went.
 */
describe("clickLandingNote — cursor feedback on a click", () => {
	test("an unreadable cursor contributes no text (back-compat wording)", () => {
		// Platforms without read-back keep the historical message verbatim, so
		// a backend that cannot read the pointer never claims a verdict.
		expect(clickLandingNote(null, null, AIM)).toBe("");
		expect(clickLandingNote(null, { x: 100, y: 200 }, AIM)).toBe("");
	});

	test("a pre sample that read null contributes no correction count", () => {
		// corrections>0 with a null read is not a convergence we can attest to.
		expect(clickLandingNote({ read: null, corrections: 3 }, null, AIM)).toBe("");
	});

	test("reports OK when the pointer was steered onto the aim point", () => {
		const note = clickLandingNote({ read: AIM, corrections: 0 }, null, AIM);
		expect(note).toContain("Cursor verify OK");
		expect(note).not.toContain("MISMATCH");
	});

	test("reports MISMATCH when the pointer never reached the aim point", () => {
		// The whole defect: a click that landed elsewhere used to be reported
		// as if it hit. The mismatch must be visible in the text.
		const note = clickLandingNote({ read: { x: 640, y: 480 }, corrections: 0 }, { x: 640, y: 480 }, AIM);
		expect(note).toContain("MISMATCH");
		expect(note).toContain("read (640,480)");
	});

	test("does not repeat an identical post-press verdict", () => {
		// Two identical "OK"s are noise the model must parse for no
		// information — and a report that always carries two verdicts
		// teaches it to skim past them.
		const note = clickLandingNote({ read: AIM, corrections: 0 }, { x: 100, y: 200 }, AIM);
		expect(note.match(/Cursor verify/g) ?? []).toHaveLength(1);
	});

	test("a post-press sample that differs is reported, not corrected away", () => {
		// A control may capture the pointer. The sample is the honest
		// measurement, so the second verdict must disagree with the first
		// rather than be silently reconciled with it.
		const note = clickLandingNote({ read: AIM, corrections: 0 }, { x: 0, y: 0 }, AIM);
		expect(note).toContain("Cursor verify OK");
		expect(note).toContain("MISMATCH");
		expect(note).toContain("read (0,0)");
	});

	test("reports the post sample even when the pre sample could not be read", () => {
		// A null pre read carries no verdict, so the post sample is the only
		// evidence there is and must not be swallowed.
		const note = clickLandingNote({ read: null, corrections: 0 }, { x: 0, y: 0 }, AIM);
		expect(note).toContain("MISMATCH");
	});

	test("counts the corrections that were actually applied", () => {
		expect(clickLandingNote({ read: AIM, corrections: 1 }, null, AIM)).toContain("1 correction.");
		expect(clickLandingNote({ read: AIM, corrections: 2 }, null, AIM)).toContain("2 corrections.");
	});

	test("boundary is the same ≤2px tolerance as the shared verify note", () => {
		const inside = clickLandingNote({ read: { x: 102, y: 198 }, corrections: 0 }, null, AIM);
		expect(inside).toContain("Cursor verify OK");
		expect(inside).not.toContain("MISMATCH");
		const outside = clickLandingNote({ read: { x: 103, y: 200 }, corrections: 0 }, null, AIM);
		expect(outside).toContain("MISMATCH");
	});

	test("agrees with cursorVerifyNote, which it is built from", () => {
		// Guards against the two paths drifting apart.
		const read = { x: 55, y: 66 };
		expect(clickLandingNote({ read, corrections: 0 }, null, AIM)).toBe(cursorVerifyNote(AIM, read));
	});
});
