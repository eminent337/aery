/**
 * ProgressiveMemoryCoordinator manages turn-end observation extraction,
 * SQLite persistence, and startup prompt prelude generation.
 *
 * See file:///home/aryee/aery/ai_agent/docs/superpowers/specs/2026-11-08-progressive-memory-engine-design.md
 */

import * as path from "node:path";
import { ObservationDistiller, type ToolExecutionRecord } from "./observation-distiller";
import { ProgressiveMemoryStore } from "./progressive-memory-store";
import type { ObservationRecord } from "./types";

export interface ProgressiveMemoryCoordinatorOptions {
	cwd: string;
	sessionId: string;
	dbPath?: string;
	store?: ProgressiveMemoryStore;
	distiller?: ObservationDistiller;
}

export interface TurnEndData {
	entryId?: string | null;
	turnIndex: number;
	userPrompt?: string;
	assistantText?: string;
	assistantThinking?: string;
	toolExecutions?: ToolExecutionRecord[];
}

function formatRelativeAge(timestamp: number, now = Date.now()): string {
	const diffMs = Math.max(0, now - timestamp);
	const minutes = Math.floor(diffMs / 60000);
	if (minutes < 1) return "just now";
	const hours = Math.floor(minutes / 60);
	if (hours < 1) return `${minutes}m ago`;
	const days = Math.floor(hours / 24);
	if (days < 1) return `${hours}h ago`;
	return `${days}d ago`;
}

function formatTableSummary(summary: string): string {
	let cleaned = summary.replace(/\r?\n+/g, " ").trim();
	if (cleaned.length > 100) {
		cleaned = `${cleaned.slice(0, 97)}...`;
	}
	return cleaned.replace(/\|/g, "\\|");
}

export class ProgressiveMemoryCoordinator {
	readonly cwd: string;
	readonly sessionId: string;
	private readonly store: ProgressiveMemoryStore;
	private readonly distiller: ObservationDistiller;

	constructor(options: ProgressiveMemoryCoordinatorOptions) {
		this.cwd = options.cwd;
		this.sessionId = options.sessionId;

		if (options.store) {
			this.store = options.store;
		} else {
			const resolvedDbPath = options.dbPath ?? path.join(this.cwd, ".aery", "memory", "project-memory.db");
			this.store = new ProgressiveMemoryStore({ dbPath: resolvedDbPath });
		}

		this.distiller = options.distiller ?? new ObservationDistiller();
	}

	getStore(): ProgressiveMemoryStore {
		return this.store;
	}

	async onTurnEnd(turnData: TurnEndData): Promise<ObservationRecord[]> {
		if (this.store.isClosed) {
			return [];
		}

		const rawObservations = this.distiller.distillFromTurn({
			sessionId: this.sessionId,
			entryId: turnData.entryId,
			turnIndex: turnData.turnIndex,
			userPrompt: turnData.userPrompt,
			assistantText: turnData.assistantText,
			assistantThinking: turnData.assistantThinking,
			toolExecutions: turnData.toolExecutions,
		});

		const persisted: ObservationRecord[] = [];
		for (const params of rawObservations) {
			const record = this.store.insertObservation(params);
			persisted.push(record);
		}

		return persisted;
	}

	buildStartupPromptPrelude(maxItems = 5): string | null {
		if (this.store.isClosed) {
			return null;
		}

		const observations = this.store.listRecentObservations(maxItems);
		if (observations.length === 0) {
			return null;
		}

		const rows = observations.map(record => {
			const summary = formatTableSummary(record.summary);
			const age = formatRelativeAge(record.createdAt);
			return `| \`${record.id}\` | \`${record.category}\` | ${summary} | ${age} |`;
		});

		return [
			"### Recent Project Memory",
			"| ID | Type | Summary | Age |",
			"| :--- | :--- | :--- | :--- |",
			...rows,
			"",
			"*Note: Use `memory_recall(id)` or `memory_search(query)` if full historical context is needed.*",
		].join("\n");
	}

	close(): void {
		this.store.close();
	}
}
