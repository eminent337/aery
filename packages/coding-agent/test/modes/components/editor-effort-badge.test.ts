import { beforeAll, describe, expect, it, vi } from "bun:test";
import { CustomEditor } from "../../../src/modes/components/custom-editor";
import { getEditorTheme, initTheme } from "../../../src/modes/theme/theme";

describe("CustomEditor effort toggle and navigation keys", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("includes alt+e and shift+tab in thinking cycle action keys", () => {
		const editor = new CustomEditor(getEditorTheme());
		let cycleCount = 0;
		editor.onCycleThinkingLevel = () => {
			cycleCount++;
		};

		// Test shift+tab (standard)
		editor.handleInput("\x1b[Z"); // CSI Z = Shift+Tab
		expect(cycleCount).toBe(1);

		// Test alt+e
		editor.handleInput("\x1be"); // Esc + e = Alt+E
		expect(cycleCount).toBe(2);
	});

	it("intercepts navigation keys via onNavigationKey when active", () => {
		const editor = new CustomEditor(getEditorTheme());
		const navHandler = vi.fn((key: string) => key === "pageup" || key === "pagedown");
		editor.onNavigationKey = navHandler;

		// PageUp: "\x1b[5~"
		editor.handleInput("\x1b[5~");
		expect(navHandler).toHaveBeenCalledWith("pageup");

		// PageDown: "\x1b[6~"
		editor.handleInput("\x1b[6~");
		expect(navHandler).toHaveBeenCalledWith("pagedown");
	});

	it("sets top border with custom effort badge", () => {
		const editor = new CustomEditor(getEditorTheme());
		const badge = "[effort: high (alt+e)]";
		editor.setTopBorder({ content: badge, width: badge.length });

		// Verify top border is set on editor
		const lines = editor.render(80);
		expect(lines.some(line => line.includes("[effort: high (alt+e)]"))).toBe(true);

		// Clear top border
		editor.setTopBorder(undefined);
		const linesAfter = editor.render(80);
		expect(linesAfter.some(line => line.includes("[effort: high (alt+e)]"))).toBe(false);
	});
});
