import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "../src/store/board-store";
import { MemberRegistry } from "../src/store/member-registry";

describe("BoardStore & MemberRegistry", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "swarm-test-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("appends messages with monotonic sequence numbers", () => {
		const store = new BoardStore(testDir);
		const msg1 = store.appendMessage({
			from: "coordinator",
			content: "@worker-1 first task",
		});
		const msg2 = store.appendMessage({
			from: "worker-1",
			content: "Working on it #progress",
		});

		expect(msg1.seq).toBe(1);
		expect(msg2.seq).toBe(2);
		expect(msg1.mentions).toEqual(["worker-1"]);

		const all = store.readMessages();
		expect(all).toHaveLength(2);
		expect(all[0].seq).toBe(1);
		expect(all[1].seq).toBe(2);
	});

	it("filters messages by sinceSeq, channel, and mentions", () => {
		const store = new BoardStore(testDir);
		store.appendMessage({ from: "coordinator", channel: "qa", content: "@tester please review" });
		store.appendMessage({ from: "worker-1", channel: "dev", content: "code pushed" });
		store.appendMessage({ from: "tester", channel: "qa", content: "all tests pass" });

		const qaMsgs = store.readMessages({ channel: "qa" });
		expect(qaMsgs).toHaveLength(2);

		const since2 = store.readMessages({ sinceSeq: 1 });
		expect(since2).toHaveLength(2);
		expect(since2[0].seq).toBe(2);

		const mentionsTester = store.readMessages({ mentionsOnlyFor: "tester" });
		expect(mentionsTester).toHaveLength(1);
		expect(mentionsTester[0].from).toBe("coordinator");
	});

	it("manages member state lifecycle in MemberRegistry", () => {
		const registry = new MemberRegistry(testDir);
		registry.addMember({
			name: "worker-1",
			brief: "Write tests",
			state: "waiting",
			workspace: "inherit",
			lastSeqRead: 0,
			createdAt: new Date().toISOString(),
		});

		expect(registry.getMember("worker-1")?.state).toBe("waiting");

		registry.updateMember("worker-1", { state: "working", lastSeqRead: 5 });
		const updated = registry.getMember("worker-1");
		expect(updated?.state).toBe("working");
		expect(updated?.lastSeqRead).toBe(5);

		const members = registry.listMembers();
		expect(members).toHaveLength(1);
	});
});
