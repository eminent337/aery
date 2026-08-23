/**
 * Event store — append-only persistence for session events.
 *
 * Each session has a `.events.jsonl` file where each line is a JSON-encoded
 * event. Events are immutable once written — no updates, no deletes.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Snowflake } from "@aryee337/aery-utils";
import type { SessionEvent } from "./event-log";

export interface EventStoreOptions {
	dir: string;
}

export interface EventQuery {
	types?: string[];
	sessionId?: string;
	afterTimestamp?: number;
	beforeTimestamp?: number;
	limit?: number;
}

export class EventStore {
	private readonly dir: string;

	constructor(options: EventStoreOptions) {
		this.dir = options.dir;
		this.ensureDir();
	}

	private ensureDir(): void {
		if (!fs.existsSync(this.dir)) {
			fs.mkdirSync(this.dir, { recursive: true });
		}
	}

	private getSessionFile(sessionId: string): string {
		return path.join(this.dir, `${sessionId}.events.jsonl`);
	}

	generateEventId(): string {
		return Snowflake.next();
	}

	async append(event: SessionEvent): Promise<void> {
		const file = this.getSessionFile(event.sessionId);
		const line = `${JSON.stringify(event)}\n`;
		await fsp.appendFile(file, line, "utf-8");
	}

	async appendBatch(events: SessionEvent[]): Promise<void> {
		if (events.length === 0) return;

		const bySession = new Map<string, SessionEvent[]>();
		for (const event of events) {
			const existing = bySession.get(event.sessionId) ?? [];
			existing.push(event);
			bySession.set(event.sessionId, existing);
		}

		for (const [sessionId, sessionEvents] of bySession) {
			const file = this.getSessionFile(sessionId);
			const lines = sessionEvents.map(e => `${JSON.stringify(e)}\n`).join("");
			await fsp.appendFile(file, lines, "utf-8");
		}
	}

	async readSession(sessionId: string): Promise<SessionEvent[]> {
		const file = this.getSessionFile(sessionId);
		if (!fs.existsSync(file)) return [];

		const content = await fsp.readFile(file, "utf-8");
		const events: SessionEvent[] = [];

		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				events.push(JSON.parse(line) as SessionEvent);
			} catch {
				// Skip corrupted lines
			}
		}

		return events;
	}

	async query(query: EventQuery): Promise<SessionEvent[]> {
		if (query.sessionId) {
			const sessionEvents = await this.readSession(query.sessionId);
			return this.filterEvents(sessionEvents, query);
		}

		const events: SessionEvent[] = [];
		const files = await fsp.readdir(this.dir);
		for (const file of files) {
			if (!file.endsWith(".events.jsonl")) continue;
			const sessionId = file.replace(".events.jsonl", "");
			const sessionEvents = await this.readSession(sessionId);
			events.push(...this.filterEvents(sessionEvents, query));
		}

		return events;
	}

	private filterEvents(events: SessionEvent[], query: EventQuery): SessionEvent[] {
		let filtered = events;

		if (query.types && query.types.length > 0) {
			filtered = filtered.filter(e => query.types!.includes(e.type));
		}
		if (query.afterTimestamp !== undefined) {
			filtered = filtered.filter(e => e.timestamp >= query.afterTimestamp!);
		}
		if (query.beforeTimestamp !== undefined) {
			filtered = filtered.filter(e => e.timestamp <= query.beforeTimestamp!);
		}
		if (query.limit !== undefined) {
			filtered = filtered.slice(0, query.limit);
		}

		return filtered;
	}

	async getLatestEvent(sessionId: string): Promise<SessionEvent | undefined> {
		const events = await this.readSession(sessionId);
		return events[events.length - 1];
	}

	async countSession(sessionId: string): Promise<number> {
		const file = this.getSessionFile(sessionId);
		if (!fs.existsSync(file)) return 0;

		const content = await fsp.readFile(file, "utf-8");
		return content.split("\n").filter(line => line.trim()).length;
	}

	async deleteSession(sessionId: string): Promise<void> {
		const file = this.getSessionFile(sessionId);
		if (fs.existsSync(file)) {
			await fsp.unlink(file);
		}
	}

	async listSessions(): Promise<string[]> {
		const files = await fsp.readdir(this.dir);
		return files.filter(f => f.endsWith(".events.jsonl")).map(f => f.replace(".events.jsonl", ""));
	}
}
