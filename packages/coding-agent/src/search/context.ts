/**
 * Search context — track searched files, regions, and symbols with confidence.
 *
 * Ported from jcode upstream (crates/jcode-app-core/src/tool/agentgrep.rs
 * AgentGrepHarnessContext, AgentGrepKnownRegion/File/Symbol). Remembers what
 * parts of the codebase have been searched, with confidence scores that
 * decay over time so fresh searches get priority.
 *
 * Aery's search/find tools are stateless — this context gives them memory
 * across calls within a session. Search tools can read the context to
 * boost unexplored areas and write results back to build up coverage.
 */

export type ConfidenceProfile = {
	/** Confidence that the body content is still valid (0-1). */
	body: number;
	/** Confidence that the file version hasn't changed (0-1). */
	currentVersion: number;
	/** Confidence that the entry should be pruned (0-1). Higher = more stale. */
	prune: number;
};

export type SourceStrength = "weak" | "normal" | "strong";

export interface KnownRegion {
	path: string;
	startLine: number;
	endLine: number;
	confidence: ConfidenceProfile;
	sourceStrength: SourceStrength;
	reasons: string[];
}

export interface KnownFile {
	path: string;
	confidence: ConfidenceProfile;
	sourceStrength: SourceStrength;
	reasons: string[];
}

export interface KnownSymbol {
	path: string;
	symbol: string;
	kind?: string;
	confidence: ConfidenceProfile;
	sourceStrength: SourceStrength;
	reasons: string[];
}

export interface SearchContextData {
	version: number;
	knownRegions: KnownRegion[];
	knownFiles: KnownFile[];
	knownSymbols: KnownSymbol[];
	focusFiles: string[];
}

const CONTEXT_VERSION = 1;

/**
 * Confidence decay: entries older than this (ms) start to lose confidence.
 */
const CONFIDENCE_HALF_LIFE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Per-session search context. Tracks what has been searched with confidence
 * scores that decay over time.
 */
export class SearchContext {
	#knownRegions: KnownRegion[] = [];
	#knownFiles: KnownFile[] = [];
	#knownSymbols: KnownSymbol[] = [];
	#focusFiles: string[] = [];
	#lastAccess = Date.now();

	/** Get all known files. */
	get knownFiles(): readonly KnownFile[] {
		return this.#knownFiles;
	}

	/** Get all known regions. */
	get knownRegions(): readonly KnownRegion[] {
		return this.#knownRegions;
	}

	/** Get all known symbols. */
	get knownSymbols(): readonly KnownSymbol[] {
		return this.#knownSymbols;
	}

	/** Get focus files (prioritized for search). */
	get focusFiles(): readonly string[] {
		return this.#focusFiles;
	}

	/**
	 * Record a file as searched with a confidence profile.
	 */
	recordFile(file: Omit<KnownFile, "confidence" | "sourceStrength" | "reasons"> & Partial<ConfidenceProfile>): void {
		const confidence: ConfidenceProfile = {
			body: file.body ?? 0.8,
			currentVersion: file.currentVersion ?? 0.9,
			prune: file.prune ?? 0.1,
		};
		this.#knownFiles.push({
			path: file.path,
			sourceStrength: "normal",
			reasons: [],
			confidence,
		});
	}

	/**
	 * Record a region as searched.
	 */
	recordRegion(
		region: Omit<KnownRegion, "confidence" | "sourceStrength" | "reasons"> & Partial<ConfidenceProfile>,
	): void {
		const confidence: ConfidenceProfile = {
			body: region.body ?? 0.7,
			currentVersion: region.currentVersion ?? 0.8,
			prune: region.prune ?? 0.2,
		};
		this.#knownRegions.push({
			path: region.path,
			startLine: region.startLine,
			endLine: region.endLine,
			sourceStrength: "normal",
			reasons: [],
			confidence,
		});
	}

	/**
	 * Record a symbol as searched.
	 */
	recordSymbol(
		symbol: Omit<KnownSymbol, "confidence" | "sourceStrength" | "reasons"> & Partial<ConfidenceProfile>,
	): void {
		const confidence: ConfidenceProfile = {
			body: symbol.body ?? 0.75,
			currentVersion: symbol.currentVersion ?? 0.85,
			prune: symbol.prune ?? 0.15,
		};
		this.#knownSymbols.push({
			path: symbol.path,
			symbol: symbol.symbol,
			kind: symbol.kind,
			sourceStrength: "normal",
			reasons: [],
			confidence,
		});
	}

	/**
	 * Add a focus file (prioritized for future searches).
	 */
	addFocusFile(path: string): void {
		if (!this.#focusFiles.includes(path)) {
			this.#focusFiles.push(path);
		}
	}

	/**
	 * Get the confidence for a specific file, or null if unknown.
	 */
	getFileConfidence(path: string): ConfidenceProfile | null {
		const file = this.#knownFiles.find(f => f.path === path);
		return file ? this.#decayConfidence(file.confidence) : null;
	}

	/**
	 * Get the confidence for a region, or null if unknown.
	 */
	getRegionConfidence(path: string, startLine: number, endLine: number): ConfidenceProfile | null {
		const region = this.#knownRegions.find(
			r => r.path === path && r.startLine === startLine && r.endLine === endLine,
		);
		return region ? this.#decayConfidence(region.confidence) : null;
	}

	/**
	 * Apply time decay to a confidence profile. Older entries lose confidence.
	 */
	#decayConfidence(profile: ConfidenceProfile): ConfidenceProfile {
		const elapsed = Date.now() - this.#lastAccess;
		const decay = Math.exp((-Math.LN2 * elapsed) / CONFIDENCE_HALF_LIFE_MS); // half-life decay
		return {
			body: profile.body * decay,
			currentVersion: profile.currentVersion * decay,
			prune: profile.prune + (1 - profile.prune) * (1 - decay),
		};
	}

	/**
	 * Prune entries that have fallen below the confidence threshold.
	 * Returns the number of pruned entries.
	 */
	prune(threshold = 0.2): number {
		const before = this.#knownFiles.length + this.#knownRegions.length + this.#knownSymbols.length;

		this.#knownFiles = this.#knownFiles.filter(f => {
			const decayed = this.#decayConfidence(f.confidence);
			return decayed.body > threshold && decayed.prune < 0.8;
		});

		this.#knownRegions = this.#knownRegions.filter(r => {
			const decayed = this.#decayConfidence(r.confidence);
			return decayed.body > threshold && decayed.prune < 0.8;
		});

		this.#knownSymbols = this.#knownSymbols.filter(s => {
			const decayed = this.#decayConfidence(s.confidence);
			return decayed.body > threshold && decayed.prune < 0.8;
		});

		const after = this.#knownFiles.length + this.#knownRegions.length + this.#knownSymbols.length;
		return before - after;
	}

	/**
	 * Reset the context (clear all tracked entries).
	 */
	clear(): void {
		this.#knownFiles = [];
		this.#knownRegions = [];
		this.#knownSymbols = [];
		this.#focusFiles = [];
		this.#lastAccess = Date.now();
	}

	/**
	 * Serialize to a JSON-compatible object.
	 */
	toJSON(): SearchContextData {
		return {
			version: CONTEXT_VERSION,
			knownRegions: this.#knownRegions,
			knownFiles: this.#knownFiles,
			knownSymbols: this.#knownSymbols,
			focusFiles: this.#focusFiles,
		};
	}

	/**
	 * Deserialize from a JSON object.
	 */
	static fromJSON(data: SearchContextData): SearchContext {
		const ctx = new SearchContext();
		if (data.version !== CONTEXT_VERSION) {
			throw new Error(`Unsupported search context version: ${data.version}`);
		}
		ctx.#knownFiles = data.knownFiles ?? [];
		ctx.#knownRegions = data.knownRegions ?? [];
		ctx.#knownSymbols = data.knownSymbols ?? [];
		ctx.#focusFiles = data.focusFiles ?? [];
		return ctx;
	}
}
