import * as process from "node:process";
import { FermentStore } from "../store.js";
import type { Ferment } from "../types.js";

/**
 * State wrapper that adds caching, onChange notification, and lifecycle management
 * around the raw FermentStore.
 */
export class FasState {
	#store: FermentStore;
	#cache = new Map<string, Ferment>();
	#listeners = new Set<(ferment: Ferment) => void>();
	#lastSaved: Ferment | undefined;

	/**
	 * Opens (or creates) the underlying FermentStore.
	 * @param dbPath - Optional SQLite DB path. Defaults to the agent config path.
	 */
	constructor(dbPath?: string) {
		this.#store = FermentStore.open(dbPath);
	}

	/**
	 * Load a ferment by ID. Returns the in-memory cache when available,
	 * otherwise falls back to the store.
	 */
	get(id: string): Ferment | null {
		const cached = this.#cache.get(id);
		if (cached) return cached;
		return this.#store.get(id) as Ferment | null;
	}

	/**
	 * Persist a ferment to the store and update the cache.
	 * Notifies all registered `onChange` listeners.
	 */
	save(ferment: Ferment): void {
		// Cast through the store's internal Ferment interface (minimal shape)
		this.#store.save(ferment as Ferment);
		this.#cache.set(ferment.id, ferment);
		this.#lastSaved = ferment;
		this.#notify();
	}

	/**
	 * List all persisted ferments for the current worktree (process cwd).
	 */
	list(): Ferment[] {
		const worktreePath = process.cwd();
		const ferments = this.#store.listByWorktree(worktreePath) as Ferment[];
		// populate cache while collecting
		for (const f of ferments) {
			this.#cache.set(f.id, f);
		}
		return ferments;
	}

	/**
	 * Register a listener for ferment changes. Returns an unsubscribe function.
	 */
	onChange(cb: (ferment: Ferment) => void): () => void {
		this.#listeners.add(cb);
		return () => {
			this.#listeners.delete(cb);
		};
	}

	/**
	 * Clear all listeners and invalidate the cache.
	 */
	dispose(): void {
		this.#listeners.clear();
		this.#cache.clear();
	}

	#notify(): void {
		const last = this.#lastSaved;
		if (!last) return;
		for (const listener of this.#listeners) {
			listener(last);
		}
	}
}
