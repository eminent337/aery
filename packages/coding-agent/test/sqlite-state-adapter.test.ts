import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SqliteStateAdapter } from "../src/connectors/sqlite-state-adapter.js";

describe("SqliteStateAdapter", () => {
	let adapter: SqliteStateAdapter;
	let testDbPath: string;

	beforeAll(() => {
		const testDir = path.join(process.cwd(), ".test-db");
		fs.mkdirSync(testDir, { recursive: true });
		testDbPath = path.join(testDir, "test.db");
		adapter = new SqliteStateAdapter(testDbPath);
	});

	afterAll(() => {
		const testDir = path.join(process.cwd(), ".test-db");
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	test("should set and get state", async () => {
		const threadId = "thread-123";
		const state = { foo: "bar", count: 1 };

		await adapter.set(threadId, state);

		const retrieved = await adapter.get(threadId);
		expect(retrieved).toEqual(state);
	});

	test("should update existing state", async () => {
		const threadId = "thread-123";
		const newState = { foo: "baz", count: 2 };

		await adapter.set(threadId, newState);

		const retrieved = await adapter.get(threadId);
		expect(retrieved).toEqual(newState);
	});

	test("should return null for non-existent thread", async () => {
		const retrieved = await adapter.get("non-existent");
		expect(retrieved).toBeNull();
	});

	test("should delete state", async () => {
		const threadId = "thread-123";
		await adapter.delete(threadId);

		const retrieved = await adapter.get(threadId);
		expect(retrieved).toBeNull();
	});
});
