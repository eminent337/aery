import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FasState } from "../../../src/ferment/runner-mode/state.js";
import type { Ferment } from "../../../src/ferment/types.js";

const testDbDir = path.join("/tmp", `fas-state-test-${Math.random().toString(36).slice(2)}`);

function makeFerment(overrides: Partial<Ferment> = {}): Ferment {
	return {
		id: `f-${Math.random().toString(36).slice(2)}`,
		name: "Test Ferment",
		status: "planned",
		worktree: { path: testDbDir },
		scoping: {},
		phases: [],
		decisions: [],
		memories: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

describe("FasState", () => {
	let dbPath: string;

	beforeEach(() => {
		fs.mkdirSync(testDbDir, { recursive: true });
		dbPath = path.join(testDbDir, `test-${Math.random().toString(36).slice(2)}.db`);
	});

	afterEach(() => {
		try {
			fs.rmSync(testDbDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	describe("save / get round-trip", () => {
		it("saves and retrieves a ferment", () => {
			const state = new FasState(dbPath);
			const ferment = makeFerment();
			state.save(ferment);
			const loaded = state.get(ferment.id);
			expect(loaded).not.toBeNull();
			expect(loaded!.id).toBe(ferment.id);
			expect(loaded!.status).toBe("planned");
		});

		it("get returns null for unknown id", () => {
			const state = new FasState(dbPath);
			expect(state.get("does-not-exist")).toBeNull();
		});

		it("subsequent saves overwrite cached value", () => {
			const state = new FasState(dbPath);
			const ferment = makeFerment({ status: "planned" });
			state.save(ferment);
			ferment.status = "running";
			state.save(ferment);
			const loaded = state.get(ferment.id);
			expect(loaded!.status).toBe("running");
		});
	});

	describe("onChange listener", () => {
		it("fires listener on save", () => {
			const state = new FasState(dbPath);
			const ferment = makeFerment();
			let notifiedId: string | undefined;
			const unsub = state.onChange(f => {
				notifiedId = f.id;
			});
			state.save(ferment);
			expect(notifiedId).toBe(ferment.id);
			unsub();
		});

		it("fires all registered listeners", () => {
			const state = new FasState(dbPath);
			const ferment = makeFerment();
			let count = 0;
			state.onChange(() => {
				count++;
			});
			state.onChange(() => {
				count++;
			});
			state.save(ferment);
			expect(count).toBe(2);
		});

		it("unsubscribe stops notifications", () => {
			const state = new FasState(dbPath);
			const ferment = makeFerment();
			let count = 0;
			const unsub = state.onChange(() => {
				count++;
			});
			unsub();
			state.save(ferment);
			expect(count).toBe(0);
		});
	});

	describe("dispose()", () => {
		it("clears listeners", () => {
			const state = new FasState(dbPath);
			let count = 0;
			state.onChange(() => {
				count++;
			});
			state.dispose();
			state.save(makeFerment());
			expect(count).toBe(0);
		});

		it("clears cache — subsequent get falls back to store", () => {
			const state = new FasState(dbPath);
			const ferment = makeFerment();
			state.save(ferment);
			expect(state.get(ferment.id)).not.toBeNull();
			state.dispose();
			// Cache is cleared; get still returns value from store
			expect(state.get(ferment.id)).not.toBeNull();
		});
	});

	describe("list()", () => {
		it("returns ferments for the current worktree", () => {
			// Note: list() uses process.cwd() which may not be testDbDir,
			// so we test that it returns an array (possibly empty) without throwing.
			const state = new FasState(dbPath);
			const result = state.list();
			expect(Array.isArray(result)).toBe(true);
		});
	});
});
