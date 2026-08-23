import type { SessionEvent, UserMessageEvent } from "@aryee337/aery/session/event-log";
import { describe, expect, it, beforeEach } from "bun:test";
import * as path from "node:path";
import { EventStore } from "@aryee337/aery/session/event-store";
import { deriveMessages, findEvent, getToolCallEvents } from "@aryee337/aery/session/event-log";

let store: EventStore;
let testDir: string;

describe("event store", () => {
	beforeEach(() => {
		testDir = path.join("/tmp", "aery-events-test", Date.now().toString());
		store = new EventStore({ dir: testDir });
	});

	it("appends and reads events", async () => {
		const event: SessionEvent = {
			id: store.generateEventId(),
			type: "user/message",
			timestamp: Date.now(),
			sessionId: "sess-1",
			payload: { text: "hello" },
		};

		await store.append(event);
		const events = await store.readSession("sess-1");

		expect(events.length).toBe(1);
		expect(events[0]!.id).toBe(event.id);
		expect(events[0]!.type).toBe("user/message");
	});

	it("appends batches atomically", async () => {
		const events: SessionEvent[] = [
			{
				id: store.generateEventId(),
				type: "user/message",
				timestamp: Date.now(),
				sessionId: "sess-1",
				payload: { text: "msg1" },
			},
			{
				id: store.generateEventId(),
				type: "assistant/message",
				timestamp: Date.now(),
				sessionId: "sess-1",
				payload: { message: { content: "response" } },
			},
		];

		await store.appendBatch(events);
		const read = await store.readSession("sess-1");
		expect(read.length).toBe(2);
	});

	it("queries by type", async () => {
		const events: SessionEvent[] = [
			{
				id: store.generateEventId(),
				type: "user/message",
				timestamp: Date.now(),
				sessionId: "sess-1",
				payload: { text: "hi" },
			},
			{
				id: store.generateEventId(),
				type: "tool/call",
				timestamp: Date.now(),
				sessionId: "sess-1",
				payload: { callId: "c1", toolName: "bash", args: {} },
			},
			{
				id: store.generateEventId(),
				type: "tool/result",
				timestamp: Date.now(),
				sessionId: "sess-1",
				payload: { callId: "c1", toolName: "bash", content: "output", success: true },
			},
		];

		await store.appendBatch(events);
		const toolEvents = await store.query({ sessionId: "sess-1", types: ["tool/call", "tool/result"] });
		expect(toolEvents.length).toBe(2);
	});

	it("counts events per session", async () => {
		await store.append({
			id: store.generateEventId(),
			type: "user/message",
			timestamp: Date.now(),
			sessionId: "sess-1",
			payload: { text: "hi" },
		});
		await store.append({
			id: store.generateEventId(),
			type: "assistant/message",
			timestamp: Date.now(),
			sessionId: "sess-1",
			payload: { message: { content: "ok" } },
		});

		const count = await store.countSession("sess-1");
		expect(count).toBe(2);
	});

	it("deletes session events", async () => {
		await store.append({
			id: store.generateEventId(),
			type: "user/message",
			timestamp: Date.now(),
			sessionId: "sess-1",
			payload: { text: "hi" },
		});

		await store.deleteSession("sess-1");
		const events = await store.readSession("sess-1");
		expect(events.length).toBe(0);
	});

	it("lists sessions with events", async () => {
		await store.append({
			id: store.generateEventId(),
			type: "user/message",
			timestamp: Date.now(),
			sessionId: "sess-1",
			payload: { text: "hi" },
		});
		await store.append({
			id: store.generateEventId(),
			type: "user/message",
			timestamp: Date.now(),
			sessionId: "sess-2",
			payload: { text: "hi" },
		});

		const sessions = await store.listSessions();
		expect(sessions).toContain("sess-1");
		expect(sessions).toContain("sess-2");
	});
});

describe("deriveMessages", () => {
	it("derives user and assistant messages", () => {
		const events: SessionEvent[] = [
			{
				id: "1",
				type: "user/message",
				timestamp: 1000,
				sessionId: "s",
				payload: { text: "hello" },
			},
			{
				id: "2",
				type: "assistant/message",
				timestamp: 1001,
				sessionId: "s",
				payload: { message: { content: "hi there" } },
			},
		];

		const messages = deriveMessages(events);
		expect(messages.length).toBe(2);
		expect(messages[0]!.role).toBe("user");
		expect(messages[1]!.role).toBe("assistant");
	});

	it("derives tool results", () => {
		const events: SessionEvent[] = [
			{
				id: "1",
				type: "tool/result",
				timestamp: 1000,
				sessionId: "s",
				payload: { callId: "c1", toolName: "bash", content: "output", success: true },
			},
		];

		const messages = deriveMessages(events);
		expect(messages.length).toBe(1);
		expect(messages[0]!.role).toBe("toolResult");
	});

	it("derives tool errors", () => {
		const events: SessionEvent[] = [
			{
				id: "1",
				type: "tool/error",
				timestamp: 1000,
				sessionId: "s",
				payload: { callId: "c1", toolName: "bash", error: "failed" },
			},
		];

		const messages = deriveMessages(events);
		expect(messages.length).toBe(1);
		expect(messages[0]!.role).toBe("toolResult");
	});

	it("skips thinking and system events", () => {
		const events: SessionEvent[] = [
			{
				id: "1",
				type: "user/message",
				timestamp: 1000,
				sessionId: "s",
				payload: { text: "hi" },
			},
			{
				id: "2",
				type: "assistant/thinking",
				timestamp: 1001,
				sessionId: "s",
				payload: { text: "let me think..." },
			},
			{
				id: "3",
				type: "system/turn-start",
				timestamp: 1002,
				sessionId: "s",
				payload: {},
			},
		];

		const messages = deriveMessages(events);
		expect(messages.length).toBe(1);
		expect(messages[0]!.role).toBe("user");
	});
});

describe("findEvent", () => {
	it("finds event by id", () => {
		const events: SessionEvent[] = [
			{ id: "1", type: "user/message", timestamp: 1, sessionId: "s", payload: { text: "a" } },
			{ id: "2", type: "user/message", timestamp: 2, sessionId: "s", payload: { text: "b" } },
		];

		const found = findEvent(events, "2") as UserMessageEvent | undefined;
		expect(found).toBeDefined();
		expect(found!.payload.text).toBe("b");
	});

	it("returns undefined for missing id", () => {
		const events: SessionEvent[] = [
			{ id: "1", type: "user/message", timestamp: 1, sessionId: "s", payload: { text: "a" } },
		];

		const found = findEvent(events, "missing");
		expect(found).toBeUndefined();
	});
});

describe("getToolCallEvents", () => {
	it("gets call, result, and error for a tool call", () => {
		const events: SessionEvent[] = [
			{
				id: "1",
				type: "tool/call",
				timestamp: 1,
				sessionId: "s",
				payload: { callId: "c1", toolName: "bash", args: { command: "ls" } },
			},
			{
				id: "2",
				type: "tool/result",
				timestamp: 2,
				sessionId: "s",
				payload: { callId: "c1", toolName: "bash", content: "file.txt", success: true },
			},
		];

		const result = getToolCallEvents(events, "c1");
		expect(result.call).toBeDefined();
		expect(result.result).toBeDefined();
		expect(result.error).toBeUndefined();
		expect(result.call!.payload.toolName).toBe("bash");
	});
});
