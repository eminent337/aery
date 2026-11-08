/**
 * Core interfaces for the Progressive Memory subsystem.
 *
 * See file:///home/aryee/aery/ai_agent/docs/superpowers/specs/2026-11-08-progressive-memory-engine-design.md
 */

export type ObservationCategory = "decision" | "bugfix" | "discovery" | "feature";

export interface ObservationRecord {
	id: string;
	sessionId: string;
	entryId: string | null;
	turnIndex: number;
	category: ObservationCategory;
	title: string;
	summary: string;
	files: string[];
	context?: Record<string, unknown>;
	createdAt: number;
}

export interface InsertObservationParams {
	id?: string;
	sessionId: string;
	entryId?: string | null;
	turnIndex: number;
	category: ObservationCategory;
	title: string;
	summary: string;
	files?: string[];
	context?: Record<string, unknown>;
	createdAt?: number;
}

export interface SearchObservationsOptions {
	query: string;
	category?: ObservationCategory;
	limit?: number;
}
