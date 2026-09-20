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

	test("windowRect rides start/replace and can be refreshed by noteWindowRect", () => {
		const c = new ObservationController();
		const rect = { at: [708, 90] as [number, number], size: [1190, 968] as [number, number] };
		const g1 = c.start("0xA", { ...FRAME }, 10_000, rect);
		expect(c.get()!.windowRect).toEqual(rect);
		// Stale-generation writer is dropped, timer keeps ticking.
		expect(c.noteWindowRect(g1 + 1, rect, 10_050)).toBe(false);
		expect(c.get()!.capturedAt).toBe(10_000);
		// Current-generation writer refreshes rect + capturedAt.
		const rect2 = { at: [966, 90] as [number, number], size: [932, 968] as [number, number] };
		expect(c.noteWindowRect(g1, rect2, 10_060)).toBe(true);
		expect(c.get()!.windowRect).toEqual(rect2);
		expect(c.get()!.capturedAt).toBe(10_060);
		// replace carries a new rect; superseded snapshots can no longer write.
		const g2 = c.replace("0xB", { ...FRAME }, 10_100, rect);
		expect(c.get()!.windowRect).toEqual(rect);
		expect(c.noteWindowRect(g1, rect2, 10_110)).toBe(false);
		c.cancel();
		expect(c.noteWindowRect(g2, rect2, 10_120)).toBe(false);
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

describe("scroll-offset tracking on the snapshot (read-while-scrolling)", () => {
	const R0 = { at: [646, 90] as [number, number], size: [1252, 968] as [number, number] };
	test("start/replace accept an initial scroll offset", () => {
		const c = new ObservationController();
		const g1 = c.start("0xB", { ...FRAME, address: "0xB" }, 1000, R0, 880);
		expect(g1).toBe(1);
		expect(c.get()?.scrollY).toBe(880);
		const g2 = c.replace("0xB", { ...FRAME, address: "0xB" }, 1100, R0, 240);
		expect(g2).toBe(2);
		expect(c.get()?.scrollY).toBe(240);
	});

	test("noteScrollY updates the offset and re-asserts freshness for the current generation", () => {
		const c = new ObservationController();
		const g = c.start("0xB", null, 1000, R0);
		expect(c.noteScrollY(g, 776, 1200)).toBe(true);
		expect(c.get()?.scrollY).toBe(776);
		expect(c.get()?.capturedAt).toBe(1200);
	});

	test("stale generations and superseded snapshots ignore noteScrollY", () => {
		const c = new ObservationController();
		const g = c.start("0xB", null, 1000, R0);
		expect(c.noteScrollY(g + 1, 500, 1100)).toBe(false);
		expect(c.get()?.scrollY).toBeUndefined();
		c.cancel();
		expect(c.noteScrollY(g, 500, 1100)).toBe(false);
	});

	test("scroll motion between samples keeps identity fresh (address+rect unchanged)", () => {
		const c = new ObservationController();
		const g = c.start("0xB", { ...FRAME, address: "0xB" }, 1000, R0);
		c.noteScrollY(g, 400, 2000); // page slid, window did not
		const sel = c.select("0xB", 2500); // within the freshness horizon
		expect(sel.ok).toBe(true);
		expect((c.get() as any).scrollY).toBe(400);
		// scroll alone never ages identity: the change-based gate (pinned in
		// scroll-reading.test.ts) accepts the same address+rect at any age.
	});

	test("snapshots without a scroll offset stay valid (field is optional)", () => {
		const c = new ObservationController();
		c.start("0xB", null, 1000, R0);
		expect(c.select("0xB", 1100).ok).toBe(true);
		expect(c.get()?.scrollY).toBeUndefined();
	});
});
