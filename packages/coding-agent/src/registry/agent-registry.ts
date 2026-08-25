/**
 * AgentRegistry - Process-global registry of agents (the main session plus
 * every subagent), keyed by stable id.
 *
 * Tracks each agent's status and (when live) its AgentSession so peers can be
 * addressed by id (`irc`, `task resume`, `history://`). Sessions are
 * registered explicitly at creation; finished agents stay registered as
 * `idle` (live) or `parked` (session disposed, ref + sessionFile retained for
 * revival) and are only removed on explicit release/teardown.
 */

import type { AgentSession } from "../session/agent-session";

export const MAIN_AGENT_ID = "Main";

/**
 * - `running`: a turn is in flight.
 * - `idle`: live AgentSession in memory, awaiting work. Finished agents are
 *   `idle`, not removed.
 * - `parked`: session disposed; AgentRef + sessionFile retained, revivable.
 * - `aborted`: hard-killed, terminal.
 */
export type AgentStatus = "running" | "idle" | "parked" | "aborted";
export type AgentKind = "main" | "sub";

export interface AgentRef {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	status: AgentStatus;
	/** Null exactly when parked/aborted. */
	session: AgentSession | null;
	sessionFile: string | null;
	createdAt: number;
	lastActivity: number;
}

export type RegistryEvent =
	| { type: "registered"; ref: AgentRef }
	| { type: "status_changed"; ref: AgentRef }
	| { type: "removed"; ref: AgentRef };

type RegistryListener = (event: RegistryEvent) => void;

export interface RegisterInput {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	session: AgentSession | null;
	sessionFile?: string | null;
	status?: AgentStatus;
}

export class AgentRegistry {
	static #global: AgentRegistry | undefined;

	static global(): AgentRegistry {
		if (!AgentRegistry.#global) {
			AgentRegistry.#global = new AgentRegistry();
		}
		return AgentRegistry.#global;
	}

	/** Reset the global registry. Test-only. */
	static resetGlobalForTests(): void {
		AgentRegistry.#global = new AgentRegistry();
	}

	readonly #refs = new Map<string, AgentRef>();
	readonly #listeners = new Set<RegistryListener>();

	register(input: RegisterInput): AgentRef {
		const now = Date.now();
		const ref: AgentRef = {
			id: input.id,
			displayName: input.displayName,
			kind: input.kind,
			parentId: input.parentId,
			status: input.status ?? "running",
			session: input.session,
			sessionFile: input.sessionFile ?? null,
			createdAt: now,
			lastActivity: now,
		};
		this.#refs.set(ref.id, ref);
		this.#emit({ type: "registered", ref });
		return ref;
	}

	setStatus(id: string, status: AgentStatus): void {
		const ref = this.#refs.get(id);
		if (!ref || ref.status === status) return;
		ref.status = status;
		ref.lastActivity = Date.now();
		this.#emit({ type: "status_changed", ref });
	}

	attachSession(id: string, session: AgentSession, sessionFile?: string | null): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		ref.session = session;
		if (sessionFile !== undefined) ref.sessionFile = sessionFile;
		ref.lastActivity = Date.now();
	}

	detachSession(id: string): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		ref.session = null;
	}

	unregister(id: string): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		this.#refs.delete(id);
		this.#emit({ type: "removed", ref });
	}

	get(id: string): AgentRef | undefined {
		if (this.#refs.has(id)) return this.#refs.get(id);
		const lower = id.toLowerCase();
		// 1. Exact case-insensitive match
		for (const [key, ref] of this.#refs) {
			if (key.toLowerCase() === lower) return ref;
		}
		// 2. Base name match without disambiguation suffix (e.g., "Beta" matches "Beta-2")
		// Prefer running/idle agents first, then most recently active
		const prefixMatches = [...this.#refs.values()]
			.filter(ref => {
				const refLower = ref.id.toLowerCase();
				return refLower === lower || refLower.startsWith(`${lower}-`);
			})
			.sort((a, b) => {
				const aLive = a.status === "running" || a.status === "idle" ? 1 : 0;
				const bLive = b.status === "running" || b.status === "idle" ? 1 : 0;
				if (aLive !== bLive) return bLive - aLive;
				return b.lastActivity - a.lastActivity;
			});
		if (prefixMatches.length > 0) {
			return prefixMatches[0];
		}
		return undefined;
	}

	list(): AgentRef[] {
		return [...this.#refs.values()];
	}

	/**
	 * Returns every alive agent (running | idle) except the caller.
	 * Flat namespace: every agent can see every other agent.
	 */
	listVisibleTo(id: string): AgentRef[] {
		return this.list().filter(ref => ref.id !== id && (ref.status === "running" || ref.status === "idle"));
	}

	onChange(listener: RegistryListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(event: RegistryEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch {
				// listeners must not break the dispatch loop
			}
		}
	}
}
