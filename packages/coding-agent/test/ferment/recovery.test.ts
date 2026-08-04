import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { recoverStrandedFerments } from "../../src/ferment/recovery.js";
import { FermentStore } from "../../src/ferment/store.js";
import type { Ferment, Step } from "../../src/ferment/types.js";

const testDbDir = path.join("/tmp", `ferment-recovery-test-${Math.random().toString(36).slice(2)}`);

function makeSteps(...statuses: Array<Step["status"]>): Step[] {
	return statuses.map((status, i) => ({
		id: `step-${i + 1}`,
		index: i,
		description: `Step ${i + 1}`,
		status,
	}));
}

function makeFerment(overrides: Partial<Ferment> = {}): Ferment {
	return {
		name: "T",
		scoping: {},
		id: `ferment-${Math.random().toString(36).slice(2)}`,
		status: "running",
		worktree: { path: `/tmp/wt-${Math.random().toString(36).slice(2)}` },
		phases: [],
		decisions: [],
		memories: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	} as Ferment;
}

function makeStranded(): Ferment {
	return makeFerment({
		status: "running",
		activePhaseId: "phase-1",
		phases: [
			{
				id: "phase-1",
				index: 0,
				name: "P1",
				goal: "g",
				status: "active",
				steps: makeSteps("running"),
			},
		],
	});
}

describe("recoverStrandedFerments", () => {
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

	test("marks stranded running ferments paused and records crash_recovery position", () => {
		const ferment = makeFerment({
			activePhaseId: "phase-1",
			phases: [
				{
					id: "phase-1",
					index: 0,
					name: "P1",
					goal: "g",
					status: "active",
					steps: makeSteps("done", "running", "pending"),
				},
			],
		});
		store.save(ferment);

		recoverStrandedFerments(store);

		const recovered = store.get(ferment.id);
		expect(recovered?.status).toBe("paused");

		const events = store.getEvents(ferment.id);
		const crashEvt = events.find(e => e.eventType === "crash_recovery");
		expect(crashEvt).toBeDefined();
		expect((crashEvt!.eventData as Record<string, string>).phaseId).toBe("phase-1");
		expect((crashEvt!.eventData as Record<string, string>).stepId).toBe("step-2");
	});

	test("falls back to first pending step when no step is running", () => {
		const ferment = makeFerment({
			activePhaseId: "phase-1",
			phases: [
				{
					id: "phase-1",
					index: 0,
					name: "P1",
					goal: "g",
					status: "active",
					steps: makeSteps("done", "pending", "pending"),
				},
			],
		});
		store.save(ferment);

		recoverStrandedFerments(store);

		const events = store.getEvents(ferment.id);
		const crashEvt = events.find(e => e.eventType === "crash_recovery");
		expect((crashEvt!.eventData as Record<string, string>).stepId).toBe("step-2");
	});

	test("non-running ferments are left untouched", () => {
		const planned = makeFerment({ status: "planned" });
		store.save(planned);

		recoverStrandedFerments(store);

		expect(store.get(planned.id)?.status).toBe("planned");
	});

	test("one ferment failing to save does not abort recovery of the rest", () => {
		// Store two stranded ferments. The first save() throws (simulating a
		// corrupt row / disk failure); recovery must continue to the second.
		const failing = makeStranded();
		const healthy = makeStranded();
		store.save(failing);
		store.save(healthy);

		const failOnFirst = {
			listByStatus: (status: string) => (status === "running" ? [failing, healthy] : []),
			save: (ferment: Ferment) => {
				if (ferment.id === failing.id) {
					throw new Error("simulated save failure");
				}
				store.save(ferment);
			},
			getEvents: (id: string) => store.getEvents(id),
		} as unknown as FermentStore;

		recoverStrandedFerments(failOnFirst);

		// The loop continued past the failing save: the healthy ferment was
		// recovered, proving one bad row can't abort recovery of the rest.
		expect(store.get(healthy.id)?.status).toBe("paused");
	});
});
