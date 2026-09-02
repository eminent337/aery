import { beforeAll, describe, expect, it } from "bun:test";
import { StudioStateManager } from "@aryee337/aery/modes/components/studio/state";
import { AeryStudioOverlay } from "@aryee337/aery/modes/components/studio/studio-overlay";
import { initTheme } from "@aryee337/aery/modes/theme/theme";

/** Strip ANSI colors so assertions don't depend on terminal styling. */
function plain(rendered: string[]): string {
	return rendered.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
}

beforeAll(async () => {
	await initTheme();
});

describe("AeryStudioOverlay generate tab", () => {
	it("tabs to the generate tab and renders the media panel", () => {
		const studio = new AeryStudioOverlay(new StudioStateManager());

		// Start on the swarm tab (index 0); three Tabs reach generate (index 3).
		expect(studio.render(80).join("\n")).toContain("🎨 Generate");
		studio.handleInput("\t");
		studio.handleInput("\t");
		studio.handleInput("\t");

		const output = plain(studio.render(120));
		expect(output).toContain("✦ Aery Studio");
		expect(output).toContain("🎨 Generate");
		// Media panel: header + mode toggle + model line + empty queue hint.
		expect(output).toContain("[● Image]");
		expect(output).toContain("(  Video )");
		expect(output).toContain("model: auto (best free)");
		expect(output).toContain("(no jobs yet — type a prompt and press Enter)");

		studio.dispose();
	});

	it("toggles to video mode via the panel's key handling", () => {
		const studio = new AeryStudioOverlay(new StudioStateManager());
		for (let i = 0; i < 3; i++) studio.handleInput("\t");

		// The media panel's mode toggle: tab inside the generate tab flips the
		// mode between Image and Video (see panel header glyphs).
		studio.handleInput("\t");

		const output = plain(studio.render(120));
		expect(output).toContain("(  Image )");
		expect(output).toContain("[● Video]");
		studio.dispose();
	});

	it("does not trap the user on the generate tab: Shift+Tab returns to a view", () => {
		const studio = new AeryStudioOverlay(new StudioStateManager());
		for (let i = 0; i < 3; i++) studio.handleInput("\t");

		// Shift+Tab on the generate tab leaves back to the previous pane.
		studio.handleInput("\x1b[Z");
		const output = plain(studio.render(120));
		// No longer on generate: the media panel header is gone.
		expect(output).not.toContain("model: auto (best free)");
		studio.dispose();
	});
});
