/**
 * Dual-Layer Transcript Architecture.
 *
 * Ported from Google Antigravity (agy).
 * Maintains two synchronized JSONL logs:
 * 1. transcript.jsonl — Compact log with truncated_fields to guard the LLM context window.
 * 2. transcript_full.jsonl — Lossless, byte-exact record of every turn, tool output, and thinking block.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface TranscriptStep {
	step_index: number;
	source: "USER_EXPLICIT" | "MODEL" | "SYSTEM" | "TOOL";
	type: string;
	status: "DONE" | "ERROR" | "RUNNING" | "CANCELLED";
	created_at: string;
	content?: string;
	thinking?: string;
	tool_calls?: Array<{
		name: string;
		args: Record<string, unknown>;
	}>;
	truncated_fields?: string[];
	[key: string]: unknown;
}

export interface DualTranscriptOptions {
	dir: string;
	truncationThreshold?: number; // Characters threshold before truncation (default: 800)
}

export class DualTranscriptWriter {
	private readonly dir: string;
	private readonly truncationThreshold: number;
	private readonly compactPath: string;
	private readonly fullPath: string;
	private stepCount = 0;

	constructor(options: DualTranscriptOptions) {
		this.dir = options.dir;
		this.truncationThreshold = options.truncationThreshold ?? 800;
		this.compactPath = path.join(this.dir, "transcript.jsonl");
		this.fullPath = path.join(this.dir, "transcript_full.jsonl");
	}

	get paths() {
		return {
			compact: this.compactPath,
			full: this.fullPath,
		};
	}

	private async ensureDir(): Promise<void> {
		await fs.mkdir(this.dir, { recursive: true });
	}

	async appendStep(
		input: Omit<TranscriptStep, "step_index" | "created_at"> & {
			step_index?: number;
			created_at?: string;
		},
	): Promise<{ compactStep: TranscriptStep; fullStep: TranscriptStep }> {
		await this.ensureDir();

		const step_index = input.step_index ?? this.stepCount++;
		const created_at = input.created_at ?? new Date().toISOString();

		const fullStep: TranscriptStep = {
			...input,
			step_index,
			created_at,
		};

		// Build compact copy with truncated_fields if fields exceed threshold
		const compactStep: TranscriptStep = {
			...input,
			step_index,
			created_at,
		};

		const truncated: string[] = [];

		if (typeof compactStep.content === "string" && compactStep.content.length > this.truncationThreshold) {
			compactStep.content = `${compactStep.content.slice(0, this.truncationThreshold)}... [truncated]`;
			truncated.push("content");
		}

		if (typeof compactStep.thinking === "string" && compactStep.thinking.length > this.truncationThreshold) {
			compactStep.thinking = `${compactStep.thinking.slice(0, this.truncationThreshold)}... [truncated]`;
			truncated.push("thinking");
		}

		if (truncated.length > 0) {
			compactStep.truncated_fields = truncated;
		}

		// Write to both files
		await fs.appendFile(this.fullPath, `${JSON.stringify(fullStep)}\n`, "utf-8");
		await fs.appendFile(this.compactPath, `${JSON.stringify(compactStep)}\n`, "utf-8");

		return { compactStep, fullStep };
	}

	async readCompact(): Promise<TranscriptStep[]> {
		try {
			const data = await fs.readFile(this.compactPath, "utf-8");
			return data
				.split("\n")
				.filter(line => line.trim().length > 0)
				.map(line => JSON.parse(line) as TranscriptStep);
		} catch {
			return [];
		}
	}

	/**
	 * Reads an exact full step by index from transcript_full.jsonl
	 */
	async readFullStep(stepIndex: number): Promise<TranscriptStep | null> {
		try {
			const data = await fs.readFile(this.fullPath, "utf-8");
			const lines = data.split("\n").filter(line => line.trim().length > 0);
			for (const line of lines) {
				const parsed = JSON.parse(line) as TranscriptStep;
				if (parsed.step_index === stepIndex) {
					return parsed;
				}
			}
			return null;
		} catch {
			return null;
		}
	}

	async getStats(): Promise<{ compactBytes: number; fullBytes: number; savedBytes: number }> {
		try {
			const [compactStat, fullStat] = await Promise.all([fs.stat(this.compactPath), fs.stat(this.fullPath)]);
			return {
				compactBytes: compactStat.size,
				fullBytes: fullStat.size,
				savedBytes: Math.max(0, fullStat.size - compactStat.size),
			};
		} catch {
			return { compactBytes: 0, fullBytes: 0, savedBytes: 0 };
		}
	}
}
