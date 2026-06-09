import { describe, expect, it } from "bun:test";
import { ToolCard } from "../src/components/tool-card";

describe("ToolCard", () => {
	it("title bar contains tool name", () => {
		const card = new ToolCard({ tool: "read_file", status: "running" });
		expect(card.render(40)[0]).toContain("read_file");
	});

	it("collapsed renders exactly 2 lines (title + bottom bar)", () => {
		const card = new ToolCard({ tool: "bash", status: "done", collapsed: true });
		expect(card.render(40)).toHaveLength(2);
	});

	it("status icons match expected chars", () => {
		expect(new ToolCard({ tool: "t", status: "running" }).render(20)[0]).toMatch(/[◐◓◑◒]/);
		expect(new ToolCard({ tool: "t", status: "done" }).render(20)[0]).toContain("✓");
		expect(new ToolCard({ tool: "t", status: "error" }).render(20)[0]).toContain("✗");
	});

	it("setContent appears in expanded render", () => {
		const card = new ToolCard({ tool: "bash", status: "done" });
		card.setContent(["output line"]);
		expect(card.render(40).join("\n")).toContain("output line");
	});

	it("invalidate resets cache", () => {
		const card = new ToolCard({ tool: "t", status: "done" });
		card.setContent(["a"]);
		const first = card.render(20);
		card.invalidate();
		expect(card.render(20)).toEqual(first);
	});
});
