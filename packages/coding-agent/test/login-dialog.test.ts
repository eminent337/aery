import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { setKeybindings, type TUI } from "../src/tui/index.js";

describe("LoginDialogComponent", () => {
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("shows only the active prompt input when asking for multiple values", async () => {
		const dialog = new LoginDialogComponent(
			{ requestRender: () => {} } as TUI,
			"cloudflare-workers-ai",
			() => {},
			"Cloudflare Workers AI",
		);

		const apiKeyPromise = dialog.showPrompt("Enter API key:");
		dialog.handleInput("api-key");
		dialog.handleInput("\r");
		await expect(apiKeyPromise).resolves.toBe("api-key");

		const accountIdPromise = dialog.showPrompt("Enter Cloudflare account ID:");
		dialog.handleInput("account-id");

		const rendered = stripAnsi(dialog.render(80).join("\n"));
		expect(rendered.match(/account-id/g)).toHaveLength(1);
		expect(rendered).not.toContain("api-key");

		dialog.handleInput("\r");
		await expect(accountIdPromise).resolves.toBe("account-id");
	});
});
