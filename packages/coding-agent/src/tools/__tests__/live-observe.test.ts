import { describe, expect, test } from "bun:test";
import {
	DEFAULT_OBSERVATION_MAX_AGE_MS,
	isObservationFresh,
	observationAgeMs,
	observationMatchesAddress,
	ObservationController,
	selectObservationForInput,
} from "../live-observe";
import type { ObservationSnapshot } from "../live-observe";

const FRAME = { kind: "window", atX: 708, atY: 90, physW: 1190, physH: 968, scaledW: 983, scaledH: 800, address: "0xA" } as const;
function snap(over: Partial<ObservationSnapshot> = {}, now = 10_000): ObservationSnapshot {
	return { generation: 1, address: "0xA", frame: { ...FRAME }, capturedAt: now, ...over };
}

describe("observation freshness and identity", () => {
	test("age is never negative", () => {
		expect(observationAgeMs(snap({}, 10_000), 9_000)).toBe(0);
		expect(observationAgeMs(snap({}, 10_000), 10_250)).toBe(250);
	});

	test("fresh means present, live, and within the horizon", () => {
		expect(isObservationFresh(snap({}, 10_000), 10_000 + DEFAULT_OBSERVATION_MAX_AGE_MS)).toBe(true);
		expect(isObservationFresh(snap({}, 10_000), 10_000 + DEFAULT_OBSERVATION_MAX_AGE_MS + 1)).toBe(false);
		expect(isObservationFresh(snap({ superseded: true }, 10_000), 10_000)).toBe(false);
		expect(isObservationFresh(undefined, 10_000)).toBe(false);
	});

	test("address match is exact and fails closed on missing", () => {
		expect(observationMatchesAddress(snap(), "0xA")).toBe(true);
		expect(observationMatchesAddress(snap(), "0xB")).toBe(false);
		expect(observationMatchesAddress(snap(), undefined)).toBe(false);
		expect(observationMatchesAddress(undefined, "0xA")).toBe(false);
	});
});

describe("selectObservationForInput gate", () => {
	test("accepts a fresh snapshot anchored to the active window", () => {
		const s = snap({}, 10_000);
		const sel = selectObservationForInput(s, "0xA", 10_500);
		expect(sel.ok).toBe(true);
		if (sel.ok) {
			expect(sel.snapshot).toBe(s);
			expect(sel.ageMs).toBe(500);
		}
	});

	test("refuses when missing, with an actionable reason", () => {
		const sel = selectObservationForInput(undefined, "0xA", 10_000);
		expect(sel).toMatchObject({ ok: false, reason: "missing" });
		if (!sel.ok) expect(sel.detail).toContain("live_eye");
	});

	test("refuses superseded generations even when fresh", () => {
		const sel = selectObservationForInput(snap({ superseded: true }, 10_000), "0xA", 10_000);
		expect(sel).toMatchObject({ ok: false, reason: "superseded" });
	});

	test("refuses stale snapshots", () => {
		const sel = selectObservationForInput(snap({}, 10_000), "0xA", 10_000 + DEFAULT_OBSERVATION_MAX_AGE_MS + 1);
		expect(sel).toMatchObject({ ok: false, reason: "stale" });
	});

	test("refuses wrong-address snapshots even when fresh", () => {
		const sel = selectObservationForInput(snap({}, 10_000), "0xB", 10_000);
		expect(sel).toMatchObject({ ok: false, reason: "address_mismatch" });
		if (!sel.ok) {
			expect(sel.detail).toContain("0xA");
			expect(sel.detail).toContain("0xB");
		}
	});

	test("a custom policy can relax the address requirement", () => {
		const sel = selectObservationForInput(snap({}, 10_000), "0xB", 10_000, { maxAgeMs: 1500, requireAddressMatch: false });
		expect(sel.ok).toBe(true);
	});
});

describe("ObservationController lifecycle", () => {
	test("start anchors an address; replacement supersedes the old snapshot", () => {
		const c = new ObservationController();
		const g1 = c.start("0xA", { ...FRAME });
		expect(c.running).toBe(true);
		const first = c.get()!;
		expect(first.generation).toBe(g1);
		const g2 = c.replace("0xB");
		expect(g2).toBeGreaterThan(g1);
		expect(first.superseded).toBe(true);
		expect(c.get()!.address).toBe("0xB");
		// Stale-generation writers are dropped.
		expect(c.noteFrame(g1, { ...FRAME, address: "0xA" })).toBe(false);
		expect(c.noteOcr(g1, "old")).toBe(false);
		expect(c.get()!.ocrText).toBeUndefined();
		// Current-generation writers land.
		expect(c.noteFrame(g2, { ...FRAME, address: "0xB" })).toBe(true);
		expect(c.noteOcr(g2, "new", 0.9)).toBe(true);
		expect(c.get()!.ocrText).toBe("new");
	});

	test("cancel supersedes the snapshot and stops refresh", () => {
		const c = new ObservationController();
		const g = c.start("0xA");
		expect(c.startAutoRefresh(g, 100, () => {})).toBe(true);
		c.cancel();
		expect(c.running).toBe(false);
		expect(c.noteFrame(g, { ...FRAME })).toBe(false);
		expect(c.select("0xA")).toMatchObject({ ok: false, reason: "superseded" });
	});

	test("select() binds freshness and identity to the live snapshot", () => {
		const c = new ObservationController();
		c.start("0xA", { ...FRAME }, 10_000);
		expect(c.select("0xA", 10_500).ok).toBe(true);
		expect(c.select("0xB", 10_500)).toMatchObject({ ok: false, reason: "address_mismatch" });
		expect(c.select("0xA", 10_000 + DEFAULT_OBSERVATION_MAX_AGE_MS + 1)).toMatchObject({ ok: false, reason: "stale" });
	});

	test("auto-refresh rejects bad intervals, stale generations, and self-stops when superseded", async () => {
		const c = new ObservationController();
		const g = c.start("0xA");
		expect(c.startAutoRefresh(g, 10, () => {})).toBe(false);
		expect(c.startAutoRefresh(g, 10_000, () => {})).toBe(false);
		expect(c.startAutoRefresh(g + 1, 100, () => {})).toBe(false);
		let ticks = 0;
		expect(c.startAutoRefresh(g, 60, gen => {
			ticks++;
			if (gen !== c.get()!.generation) throw new Error("stale generation ticked");
		})).toBe(true);
		await new Promise(r => setTimeout(r, 160));
		c.cancel();
		const seen = ticks;
		expect(seen).toBeGreaterThan(0);
		await new Promise(r => setTimeout(r, 160));
		expect(ticks).toBe(seen); // no ticks after cancel
	});
});
