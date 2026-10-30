import { beforeAll, describe, expect, it } from "bun:test";
import { HeaderBarComponent } from "../../../src/modes/components/header-bar";
import { initTheme } from "../../../src/modes/theme/theme";

describe("HeaderBarComponent", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("renders workspace, git branch, and model name", () => {
		const header = new HeaderBarComponent({
			cwd: "/home/user/project",
			branch: "feature/awesome",
			model: "claude-3-5-sonnet",
		});

		const lines = header.render(100);
		expect(lines.length).toBeGreaterThan(0);
		const fullText = lines.join("\n");
		expect(fullText).toContain("project");
		expect(fullText).toContain("feature/awesome");
		expect(fullText).toContain("claude-3-5-sonnet");
	});

	it("renders without git branch when branch is null", () => {
		const header = new HeaderBarComponent({
			cwd: "/home/user/project",
			branch: null,
			model: "gpt-4o",
		});

		const lines = header.render(80);
		const fullText = lines.join("\n");
		expect(fullText).toContain("project");
		expect(fullText).toContain("gpt-4o");
		expect(fullText).not.toContain("⎇");
	});

	it("updates branch and model dynamically", () => {
		const header = new HeaderBarComponent({
			cwd: "/home/user/project",
			branch: "main",
			model: "claude-3-opus",
		});

		let text = header.render(100).join("\n");
		expect(text).toContain("main");
		expect(text).toContain("claude-3-opus");

		header.setBranch("feat/new-ui");
		header.setModel("gemini-1.5-pro");

		text = header.render(100).join("\n");
		expect(text).toContain("feat/new-ui");
		expect(text).toContain("gemini-1.5-pro");
	});
});
