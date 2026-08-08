/**
 * Continual Harness State Management
 * 
 * Ported from Prime-Agent's refinement.ts to support persistent,
 * editable harness state for prompts, memories, skills, and subagents.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type {
	HarnessEntry,
	HarnessRefinementEvent,
	HarnessState,
	RefinementKind,
	RefinementResult,
} from "./types.js";

const HARNESS_STATE_DIR_NAME = "harness";
const HARNESS_STATE_FILE_NAME = "harness_state.json";
const REFINEMENT_HISTORY_FILE_NAME = "refinements.jsonl";
const CURRENT_SCHEMA = 1;

/**
 * Get the global harness state directory.
 */
export function getGlobalHarnessStateDir(agentDir: string): string {
	return join(agentDir, HARNESS_STATE_DIR_NAME);
}

/**
 * Get the local (session-specific) harness state directory.
 */
export function getLocalHarnessStateDir(sessionArtifactDir: string | undefined): string | undefined {
	return sessionArtifactDir ? join(sessionArtifactDir, HARNESS_STATE_DIR_NAME) : undefined;
}

/**
 * Get the path to the harness state file.
 */
export function getHarnessStatePath(harnessStateDir: string): string {
	return join(harnessStateDir, HARNESS_STATE_FILE_NAME);
}

/**
 * Get the path to the refinement history file.
 */
export function getRefinementHistoryPath(harnessStateDir: string): string {
	return join(harnessStateDir, REFINEMENT_HISTORY_FILE_NAME);
}

/**
 * Create an empty harness state.
 */
function emptyHarnessState(): HarnessState {
	return {
		schema: CURRENT_SCHEMA,
		entries: {
			prompt: {},
			memory: {},
			skill: {},
			subagent: {},
		},
		refinements: [],
	};
}

/**
 * Load harness state from disk.
 * Returns empty state if file doesn't exist or is corrupt.
 */
export function loadHarnessState(
	harnessStateDir: string,
	scope: "local" | "global" = "global",
): HarnessState {
	const statePath = getHarnessStatePath(harnessStateDir);
	
	if (!existsSync(statePath)) {
		return emptyHarnessState();
	}
	
	let parsed: Partial<HarnessState>;
	try {
		const raw = readFileSync(statePath, "utf8");
		if (typeof raw !== "string" || !raw.trim()) {
			return emptyHarnessState();
		}
		const obj = JSON.parse(raw);
		if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
			return emptyHarnessState();
		}
		parsed = obj as Partial<HarnessState>;
	} catch {
		// Corrupt state file - degrade to empty
		return emptyHarnessState();
	}
	
	const state = emptyHarnessState();
	state.schema = typeof parsed.schema === "number" ? parsed.schema : CURRENT_SCHEMA;
	
	for (const kind of Object.keys(state.entries) as RefinementKind[]) {
		const records = parsed.entries?.[kind];
		if (records && typeof records === "object") {
			for (const [id, rawEntry] of Object.entries(records)) {
				const entry = parseHarnessEntry(rawEntry);
				if (entry) {
					state.entries[kind][id] = {
						...entry,
						scope: normalizeScope(entry.scope, scope),
					};
				}
			}
		}
	}
	
	if (Array.isArray(parsed.refinements)) {
		state.refinements = parsed.refinements as HarnessRefinementEvent[];
	}
	
	return state;
}

/**
 * Save harness state to disk atomically.
 */
export async function saveHarnessState(harnessStateDir: string, state: HarnessState): Promise<string> {
	const statePath = getHarnessStatePath(harnessStateDir);
	mkdirSync(harnessStateDir, { recursive: true });
	// Write to temp file first, then rename for atomicity
	const tempPath = `${statePath}.${randomUUID()}.tmp`;
	writeFileSync(tempPath, JSON.stringify(state, null, 2), "utf8");
	try {
		// Rename atomically
		writeFileSync(statePath, readFileSync(tempPath), "utf8");
	} finally {
		// Clean up temp file
		try {
			await Bun.file(tempPath).delete();
		} catch {
			// Ignore cleanup errors
		}
	}
	return statePath;
}
 */
export function mergeHarnessStates(
	globalState: HarnessState,
	localState?: HarnessState,
): HarnessState {
	const merged = emptyHarnessState();
	merged.schema = Math.max(globalState.schema, localState?.schema ?? 1);
	
	for (const kind of Object.keys(merged.entries) as RefinementKind[]) {
		// Start with global entries
		for (const [id, entry] of Object.entries(globalState.entries[kind])) {
			merged.entries[kind][id] = { ...entry, scope: "global" };
		}
		
		// Add local entries with scope prefix if conflict
		if (localState) {
			for (const [id, entry] of Object.entries(localState.entries[kind])) {
				const scopedId = merged.entries[kind][id] ? `${entry.scope || "local"}:${id}` : id;
				merged.entries[kind][scopedId] = { ...entry, scope: "local" };
			}
		}
	}
	
	// Merge refinement events (global first, then local)
	merged.refinements = [
		...globalState.refinements,
		...(localState?.refinements ?? []),
	];
	
	return merged;
}

/**
 * Append a refinement result to the global history.
 */
export function appendGlobalRefinement(
	harnessStateDir: string,
	result: RefinementResult,
): string {
	const historyPath = getRefinementHistoryPath(harnessStateDir);
	mkdirSync(harnessStateDir, { recursive: true });
	appendFileSync(historyPath, `${JSON.stringify(result)}\n`, "utf8");
	return historyPath;
}

/**
 * Load global refinement history from disk.
 */
export function loadGlobalRefinementHistory(
	harnessStateDir: string,
): RefinementResult[] {
	const historyPath = getRefinementHistoryPath(harnessStateDir);
	
	if (!existsSync(historyPath)) {
		return [];
	}
	
	const results: RefinementResult[] = [];
	try {
		const content = readFileSync(historyPath, "utf8");
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed);
				if (isRefinementResult(parsed)) {
					results.push(withDefaultScope(parsed, "global"));
				}
			} catch {
				// Skip malformed lines
			}
		}
	} catch {
		// Return empty if file can't be read
	}
	
	return results;
}

/**
 * Merge global and session refinement history, deduplicating by ID.
 * Session entries win on conflict.
 */
export function mergeRefinementHistory(
	global: RefinementResult[],
	session: RefinementResult[],
): RefinementResult[] {
	const byId = new Map<string, RefinementResult>();
	
	for (const result of global) {
		byId.set(result.id, result);
	}
	
	for (const result of session) {
		const existing = byId.get(result.id);
		byId.set(result.id, {
			...result,
			scope: result.scope || !existing?.scope ? result.scope : existing.scope,
		});
	}
	
	return [...byId.values()];
}

/**
 * Validate that an object is a HarnessEntry.
 */
function parseHarnessEntry(raw: unknown): HarnessEntry | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	
	const entry = raw as Record<string, unknown>;
	
	// Required fields
	if (typeof entry.id !== "string") return undefined;
	if (typeof entry.kind !== "string") return undefined;
	if (typeof entry.title !== "string") return undefined;
	if (typeof entry.content !== "string") return undefined;
	if (typeof entry.source !== "string") return undefined;
	if (typeof entry.created_at !== "string") return undefined;
	if (typeof entry.updated_at !== "string") return undefined;
	if (typeof entry.version !== "number") return undefined;
	
	return {
		id: entry.id as string,
		kind: entry.kind as RefinementKind,
		title: entry.title as string,
		content: entry.content as string,
		path: (typeof entry.path === "string" ? entry.path : "") as string,
		scope: normalizeScope(entry.scope as string | undefined, "global"),
		reference: (typeof entry.reference === "object" && entry.reference !== null && !Array.isArray(entry.reference)) 
			? entry.reference as Record<string, unknown>
			: {},
		arguments: (typeof entry.arguments === "object" && entry.arguments !== null && !Array.isArray(entry.arguments))
			? entry.arguments as Record<string, unknown>
			: {},
		metadata: (typeof entry.metadata === "object" && entry.metadata !== null && !Array.isArray(entry.metadata))
			? entry.metadata as Record<string, unknown>
			: {},
		source: entry.source as string,
		created_at: entry.created_at as string,
		updated_at: entry.updated_at as string,
		version: entry.version as number,
	};
}

/**
 * Normalize scope value.
 */
function normalizeScope(value: string | undefined, fallback: "local" | "global"): "local" | "global" {
	return value === "global" || value === "local" ? value : fallback;
}

/**
 * Check if an object is a RefinementResult.
 */
function isRefinementResult(data: unknown): data is RefinementResult {
	return (
		typeof data === "object" &&
		data !== null &&
		"id" in data &&
		"appliedEdits" in data &&
		"summary" in data &&
		"rationale" in data &&
		"expectedOutcome" in data &&
		"harnessStatePath" in data
	);
}

/**
 * Ensure RefinementResult has a default scope.
 */
function withDefaultScope(result: RefinementResult, scope: "local" | "global"): RefinementResult {
	return {
		...result,
		scope: result.scope || scope,
	};
}
