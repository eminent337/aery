import type { TUI } from "@aryee337/aery-tui";
import { beforeAll, describe, expect, it, vi } from "bun:test";
import { BtwPanelComponent } from "../../../src/modes/components/btw-panel";
import { initTheme } from "../../../src/modes/theme/theme";

function createMockTui(): TUI {
	return {
		requestRender: vi.fn(),
	} as unknown as TUI;
}

describe("BtwPanelComponent scrolling", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("reports scrollability and clamps scrollOffset within valid bounds", () => {
		const tui = createMockTui();
		const panel = new BtwPanelComponent({ question: "How to refactor this?", tui });

		// Short answer (5 lines) <= 14 lines max
		panel.setAnswer("line 1\nline 2\nline 3\nline 4\nline 5");
		expect(panel.canScroll()).toBe(false);
		expect(panel.scrollBy(1)).toBe(false);
		expect(panel.scrollOffset).toBe(0);

		// Long answer (25 lines) > 14 lines max
		const longLines = Array.from({ length: 25 }, (_, i) => `Paragraph line number ${i + 1}`).join("\n");
		panel.setAnswer(longLines);
		expect(panel.canScroll()).toBe(true);
		expect(panel.totalContentLines).toBe(25);
		expect(panel.maxContentLines).toBe(14);

		// Scroll down by 5 lines
		const scrolledDown = panel.scrollBy(5);
		expect(scrolledDown).toBe(true);
		expect(panel.scrollOffset).toBe(5);
		expect(tui.requestRender).toHaveBeenCalled();

		// Scroll beyond maxOffset (25 - 14 = 11) clamps to 11
		panel.scrollBy(50);
		expect(panel.scrollOffset).toBe(11);

		// Scroll up beyond 0 clamps to 0
		panel.scrollBy(-100);
		expect(panel.scrollOffset).toBe(0);
	});

	it("renders scroll indicator and navigation hint in footer when scrollable", () => {
		const tui = createMockTui();
		const panel = new BtwPanelComponent({ question: "Explain algorithm", tui });

		const longLines = Array.from({ length: 20 }, (_, i) => `Step ${i + 1}: detailed explanation`).join("\n");
		panel.setAnswer(longLines);
		panel.markComplete();

		const rendered = panel.render(80).join("\n");

		// Should include scroll indicator for lines 1-14 of 20
		expect(rendered).toContain("[lines 1-14 of 20]");
		// Should include scroll hint in footer
		expect(rendered).toContain("↑/↓ scroll");
		expect(rendered).toContain("Esc dismiss · /btw promote");
	});

	it("renders footer without scroll hints when content fits within 14 lines", () => {
		const tui = createMockTui();
		const panel = new BtwPanelComponent({ question: "Short question", tui });

		panel.setAnswer("Just one short line.");
		panel.markComplete();

		const rendered = panel.render(80).join("\n");

		expect(rendered).not.toContain("↑/↓ scroll");
		expect(rendered).toContain("Esc dismiss · /btw promote");
	});
});
