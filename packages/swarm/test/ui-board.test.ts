import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "../src/store/board-store";
import { MemberRegistry } from "../src/store/member-registry";
import { SwarmBoardPanel } from "../src/ui/swarm-board-panel";

describe("SwarmBoardPanel", () => {
	it("renders roster, feed, and message detail", () => {
		const testDir = mkdtempSync(join(tmpdir(), "ui-board-"));
		const store = new BoardStore(testDir);
		const registry = new MemberRegistry(testDir);

		registry.addMember({
			name: "engineer-1",
			brief: "Build parser",
			state: "working",
			workspace: "share",
			lastSeqRead: 0,
			createdAt: new Date().toISOString(),
		});

		store.appendMessage({
			from: "coordinator",
			content: "@engineer-1 setup AST types",
		});

		const panel = new SwarmBoardPanel({ store, registry });
		const lines = panel.render(80, 24);

		expect(lines.length).toBeGreaterThan(0);
		expect(lines.some(l => l.includes("engineer-1"))).toBe(true);

		rmSync(testDir, { recursive: true, force: true });
	});

	it("supports message selection navigation with selectNext and selectPrev", () => {
		const testDir = mkdtempSync(join(tmpdir(), "ui-board-nav-"));
		const store = new BoardStore(testDir);
		const registry = new MemberRegistry(testDir);

		store.appendMessage({ from: "coordinator", content: "first message" });
		store.appendMessage({ from: "engineer-1", content: "second message" });

		const panel = new SwarmBoardPanel({ store, registry });
		let lines = panel.render(80, 24);
		expect(lines.some(l => l.includes("first message"))).toBe(true);

		panel.selectNext();
		lines = panel.render(80, 24);
		expect(lines.some(l => l.includes("second message"))).toBe(true);

		// Boundaries: cannot go beyond total - 1
		panel.selectNext();
		lines = panel.render(80, 24);
		expect(lines.some(l => l.includes("second message"))).toBe(true);

		panel.selectPrev();
		lines = panel.render(80, 24);
		expect(lines.some(l => l.includes("first message"))).toBe(true);

		// Boundaries: cannot go below 0
		panel.selectPrev();
		lines = panel.render(80, 24);
		expect(lines.some(l => l.includes("first message"))).toBe(true);

		rmSync(testDir, { recursive: true, force: true });
	});
});
