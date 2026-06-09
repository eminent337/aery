import { createHash } from "node:crypto";

export interface LoopGuardConfig {
	/** Consecutive identical calls needed to warn. Default: 3. */
	consecutiveThreshold?: number;
	/** N-gram size for pattern detection. Default: 2. */
	ngramSize?: number;
	/** Number of n-gram repetitions to trigger. Default: 6. */
	ngramThreshold?: number;
	/** Rolling window size. Default: 30. */
	windowSize?: number;
}

export type LoopGuardState = "ok" | "warn" | "terminate";

export interface LoopGuardResult {
	state: LoopGuardState;
	reason?: string;
}

interface ToolRecord {
	tool: string;
	args: string;
	isError: boolean;
	outputFingerprint: string;
}

const REASON_ARG_PREVIEW = 80;

export class LoopGuard {
	private readonly consecutiveThreshold: number;
	private readonly ngramSize: number;
	private readonly ngramThreshold: number;
	private readonly windowSize: number;

	private history: ToolRecord[] = [];
	private warned = false;
	private terminated = false;

	constructor(config: LoopGuardConfig = {}) {
		this.consecutiveThreshold = config.consecutiveThreshold ?? 3;
		this.ngramSize = config.ngramSize ?? 2;
		this.ngramThreshold = config.ngramThreshold ?? 6;
		this.windowSize = config.windowSize ?? 30;
	}

	/** Fingerprint the tail lines of output for exact matching. */
	private fingerprint(output: string): string {
		const tail = output.split("\n").slice(-20).join("\n");
		return createHash("sha256").update(tail).digest("hex").slice(0, 16);
	}

	/** Record a tool call and check for loops. Both record() and check() do the same thing. */
	record(tool: string, args: unknown, isError: boolean, output: string): LoopGuardResult {
		return this.#recordAndCheck(tool, args, isError, output);
	}

	check(tool: string, args: unknown, isError: boolean, output: string): LoopGuardResult {
		return this.#recordAndCheck(tool, args, isError, output);
	}

	#recordAndCheck(tool: string, args: unknown, isError: boolean, output: string): LoopGuardResult {
		const record: ToolRecord = {
			tool,
			args: JSON.stringify(args ?? {}).slice(0, REASON_ARG_PREVIEW),
			isError,
			outputFingerprint: this.fingerprint(output),
		};

		this.history.push(record);
		if (this.history.length > this.windowSize) {
			this.history.shift();
		}

		if (this.terminated) {
			return { state: "terminate", reason: "Tool use already halted by loop guard." };
		}

		// Check consecutive identical
		if (this.history.length >= this.consecutiveThreshold) {
			const recent = this.history.slice(-this.consecutiveThreshold);
			const allIdentical = recent.every(
				r =>
					r.tool === recent[0].tool &&
					r.args === recent[0].args &&
					r.isError === recent[0].isError &&
					r.outputFingerprint === recent[0].outputFingerprint,
			);
			if (allIdentical) {
				if (this.warned) {
					this.terminated = true;
					return { state: "terminate", reason: this.#formatTerminateReason() };
				}
				this.warned = true;
				return { state: "warn", reason: this.#formatWarnReason() };
			}
		}

		// Check n-gram repetition (exact: same tool+args+fingerprint)
		if (this.history.length >= this.ngramSize * this.ngramThreshold) {
			const ngram = this.history.slice(-this.ngramSize);
			const ngramKey = ngram.map(r => `${r.tool}|${r.args}|${r.outputFingerprint}`).join("::");
			let count = 0;
			for (let i = this.ngramSize; i <= this.history.length; i += this.ngramSize) {
				const slice = this.history.slice(i - this.ngramSize, i);
				const key = slice.map(r => `${r.tool}|${r.args}|${r.outputFingerprint}`).join("::");
				if (key === ngramKey) count++;
			}
			if (count >= this.ngramThreshold) {
				if (this.warned) {
					this.terminated = true;
					return { state: "terminate", reason: this.#formatTerminateReason() };
				}
				this.warned = true;
				return { state: "warn", reason: this.#formatWarnReason() };
			}
		}

		return { state: "ok" };
	}

	/** Readable description of the current repeating pattern. */
	getPattern(): string | null {
		if (this.history.length === 0) return null;
		const last = this.history[this.history.length - 1];
		return `${last.tool}(${last.args})`;
	}

	reset(): void {
		this.history = [];
		this.warned = false;
		this.terminated = false;
	}

	#formatWarnReason(): string {
		const pattern = this.getPattern();
		return (
			`Loop guard warning: repeating tool call pattern detected (${pattern}). ` +
			"Step back, summarize what isn't working, and try a substantively different approach."
		);
	}

	#formatTerminateReason(): string {
		return (
			"Loop guard halted tool use. Do not make any more tool calls. " +
			"Respond with plain text only: summarize what was attempted, what failed, " +
			"and what you would need to make progress."
		);
	}
}
