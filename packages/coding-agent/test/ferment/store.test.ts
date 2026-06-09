import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type FermentEvent, FermentStore } from "../../src/ferment/store";
import type { Ferment } from "../../src/ferment/types";

const testDbDir = path.join("/tmp", `ferment-test-${Math.random().toString(36).slice(2)}`);

function makeFerment(overrides: Partial<Ferment> = {}): Ferment {
	return {
		name: overrides.name || "Test",
		scoping: overrides.scoping || ({} as any),
		id: `ferment-${Math.random().toString(36).slice(2)}`,
		status: "planned",
		worktree: { path: `/tmp/worktree-${Math.random().toString(36).slice(2)}` },
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	} as Ferment;
}

describe("FermentStore", () => {
	let store: FermentStore;
	let dbPath: string;

	beforeEach(() => {
		fs.mkdirSync(testDbDir, { recursive: true });
		dbPath = path.join(testDbDir, `test-${Math.random().toString(36).slice(2)}.db`);
		store = FermentStore.open(dbPath);
	});

	afterEach(() => {
		try {
			fs.rmSync(testDbDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	test("CRUD round-trip", () => {
		const ferment = makeFerment();

		// Create
		store.save(ferment);
		const loaded = store.get(ferment.id);
		expect(loaded).not.toBeNull();
		expect(loaded!.id).toBe(ferment.id);
		expect(loaded!.status).toBe(ferment.status);
		expect(loaded!.worktree.path).toBe(ferment.worktree.path);

		// Update
		ferment.status = "running";
		ferment.activePhaseId = "phase-1";
		store.save(ferment);
		const updated = store.get(ferment.id);
		expect(updated!.status).toBe("running");
		expect(updated!.activePhaseId).toBe("phase-1");

		// Delete
		store.delete(ferment.id);
		expect(store.get(ferment.id)).toBeNull();
	});

	test("atomic save with events", () => {
		const ferment = makeFerment();
		const events: FermentEvent[] = [
			{
				fermentId: ferment.id,
				eventType: "ferment.activated",
				eventData: { phaseId: "phase-1" },
			},
			{
				fermentId: ferment.id,
				eventType: "step.started",
				eventData: { stepId: "step-1" },
			},
		];

		store.save(ferment, events);

		const retrievedEvents = store.getEvents(ferment.id);
		expect(retrievedEvents).toHaveLength(2);
		expect(retrievedEvents[0].eventType).toBe("ferment.activated");
		expect(retrievedEvents[0].eventData).toEqual({ phaseId: "phase-1" });
		expect(retrievedEvents[1].eventType).toBe("step.started");
	});

	test("listByWorktree filtering", () => {
		const worktreePath = `/tmp/shared-worktree-${Math.random().toString(36).slice(2)}`;

		const f1 = makeFerment({ worktree: { path: worktreePath } });
		const f2 = makeFerment({ worktree: { path: "/tmp/other-worktree" } });
		const f3 = makeFerment({ worktree: { path: worktreePath } });

		store.save(f1);
		store.save(f2);
		store.save(f3);

		const listed = store.listByWorktree(worktreePath);
		expect(listed).toHaveLength(2);
		expect(listed.map(f => f.id).sort()).toEqual([f1.id, f3.id].sort());
	});

	test("isActive checks cache", () => {
		const ferment = makeFerment();
		expect(store.isActive(ferment.id)).toBe(false);

		store.save(ferment);
		expect(store.isActive(ferment.id)).toBe(true);

		store.delete(ferment.id);
		expect(store.isActive(ferment.id)).toBe(false);
	});
});
