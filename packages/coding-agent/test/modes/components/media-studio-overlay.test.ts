import { beforeAll, describe, expect, it } from "bun:test";
import { AeryMediaStudioOverlay } from "@aryee337/aery/modes/components/studio/media-studio-overlay";
import { initTheme } from "@aryee337/aery/modes/theme/theme";

/** Strip ANSI colors so assertions don't depend on terminal styling. */
function plain(rendered: string[]): string {
	return rendered.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
}

beforeAll(async () => {
	await initTheme();
});

describe("AeryMediaStudioOverlay", () => {
	it("fills the terminal height exactly like /hub (not a bottom panel)", () => {
		const studio = new AeryMediaStudioOverlay();
		const lines = studio.render(120);

		const termHeight = process.stdout.rows || 40;
		expect(lines.length).toBe(termHeight);

		const output = plain(lines);
		expect(output).toContain("✦ Aery Media Studio");
		expect(output).toContain("[● Image]");
		expect(output).toContain("(  Video )");
		expect(output).toContain("model: auto (best free)");
		expect(output).toContain("[enter] render");
		studio.dispose();
	});

	it("toggles Image/Video mode with Tab", () => {
		const studio = new AeryMediaStudioOverlay();
		studio.handleInput("\t");
		const output = plain(studio.render(120));
		expect(output).toContain("(  Image )");
		expect(output).toContain("[● Video]");
		studio.dispose();
	});

	it("closes on Escape when picker is not open", () => {
		const studio = new AeryMediaStudioOverlay();
		let closed = 0;
		studio.onClose = () => {
			closed++;
		};
		studio.handleInput("\x1b");
		expect(closed).toBe(1);
		studio.dispose();
	});

	it("cancels the model picker on Escape without closing studio", () => {
		const studio = new AeryMediaStudioOverlay();
		let closed = 0;
		studio.onClose = () => {
			closed++;
		};

		// Open picker with alt+m
		studio.handleInput("\x1bm");
		// Press Escape to cancel picker
		studio.handleInput("\x1b");

		// Studio should still be open!
		expect(closed).toBe(0);

		// Pressing Escape again closes studio
		studio.handleInput("\x1b");
		expect(closed).toBe(1);
		studio.dispose();
	});
});
