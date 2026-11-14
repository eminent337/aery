import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { BoardMessage } from "../types";

export interface ReadOptions {
	sinceSeq?: number;
	channel?: string;
	mentionsOnlyFor?: string;
	limit?: number;
}

export class BoardStore {
	private readonly filePath: string;
	private currentSeq = 0;

	constructor(storageDir: string) {
		if (!existsSync(storageDir)) {
			mkdirSync(storageDir, { recursive: true });
		}
		this.filePath = join(storageDir, "board.jsonl");
		this.initSequence();
	}

	private initSequence(): void {
		if (!existsSync(this.filePath)) {
			this.currentSeq = 0;
			return;
		}
		const lines = readFileSync(this.filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0);
		if (lines.length > 0) {
			try {
				const last = JSON.parse(lines[lines.length - 1]);
				this.currentSeq = last.seq || 0;
			} catch {
				this.currentSeq = lines.length;
			}
		}
	}

	public appendMessage(params: {
		from: string;
		content: string;
		channel?: string;
		mentions?: string[];
	}): BoardMessage {
		this.currentSeq += 1;
		const extractedMentions = params.mentions ?? this.extractMentions(params.content);

		const msg: BoardMessage = {
			seq: this.currentSeq,
			timestamp: new Date().toISOString(),
			from: params.from,
			channel: params.channel ?? "general",
			mentions: extractedMentions,
			content: params.content,
		};

		appendFileSync(this.filePath, JSON.stringify(msg) + "\n", "utf-8");
		return msg;
	}

	public readMessages(options: ReadOptions = {}): BoardMessage[] {
		if (!existsSync(this.filePath)) return [];

		const lines = readFileSync(this.filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0);

		let messages: BoardMessage[] = [];
		for (const line of lines) {
			try {
				messages.push(JSON.parse(line));
			} catch {
				// skip malformed entries
			}
		}

		if (options.sinceSeq !== undefined) {
			messages = messages.filter((m) => m.seq > options.sinceSeq!);
		}

		if (options.channel) {
			messages = messages.filter((m) => m.channel === options.channel);
		}

		if (options.mentionsOnlyFor) {
			const target = options.mentionsOnlyFor;
			messages = messages.filter(
				(m) => m.mentions?.includes(target) || m.mentions?.includes("all") || m.mentions?.includes("swarm")
			);
		}

		if (options.limit && options.limit > 0) {
			messages = messages.slice(-options.limit);
		}

		return messages;
	}

	public getLatestSeq(): number {
		return this.currentSeq;
	}

	private extractMentions(text: string): string[] {
		const matches = text.match(/@([a-zA-Z0-9_-]+)/g);
		if (!matches) return [];
		return Array.from(new Set(matches.map((m) => m.slice(1))));
	}
}
