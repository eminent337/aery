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
	it("renders the media studio surface (header, media panel, footer)", () => {
		const studio = new AeryMediaStudioOverlay();
		const output = plain(studio.render(120));
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

	it("closes on Escape", () => {
		const studio = new AeryMediaStudioOverlay();
		let closed = 0;
		studio.onClose = () => {
			closed++;
		};
		studio.handleInput("\x1b");
		expect(closed).toBe(1);
		studio.dispose();
	});
});