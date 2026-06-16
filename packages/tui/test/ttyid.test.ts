import { afterEach, describe, expect, it } from "bun:test";
import { getTerminalId } from "@aryee337/aery-tui/ttyid";

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const terminalEnvKeys = [
	"ZELLIJ_PANE_ID",
	"ZELLIJ_SESSION_NAME",
	"TMUX_PANE",
	"WEZTERM_PANE",
	"KITTY_WINDOW_ID",
	"TERM_SESSION_ID",
	"WT_SESSION",
] as const;
const originalTerminalEnv = Object.fromEntries(terminalEnvKeys.map(key => [key, process.env[key]]));

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
	} else {
		// @ts-expect-error - Fallback cleanup
		delete target[key];
	}
}

function setTerminalEnv(env: Partial<Record<(typeof terminalEnvKeys)[number], string | undefined>>): void {
	for (const key of terminalEnvKeys) {
		if (key in env) {
			const value = env[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		} else {
			delete process.env[key];
		}
	}
}

describe("getTerminalId", () => {
	afterEach(() => {
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		setTerminalEnv(originalTerminalEnv);
	});

	it("returns tmux pane when no TTY path is available", () => {
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		setTerminalEnv({ TMUX_PANE: "%7", TERM_SESSION_ID: "abc" });

		expect(getTerminalId()).toBe("tmux-%7");
	});

	it("prefers ZELLIJ_PANE_ID over TMUX_PANE", () => {
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		setTerminalEnv({ ZELLIJ_PANE_ID: "123", TMUX_PANE: "%7" });

		expect(getTerminalId()).toBe("zellij-123");
	});

	it("scopes ZELLIJ_PANE_ID by ZELLIJ_SESSION_NAME when present", () => {
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		setTerminalEnv({ ZELLIJ_PANE_ID: "123", ZELLIJ_SESSION_NAME: "work" });

		expect(getTerminalId()).toBe("zellij-work-123");
	});

	it("normalizes path separators in ZELLIJ_SESSION_NAME so the id stays filename-safe", () => {
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		setTerminalEnv({ ZELLIJ_PANE_ID: "123", ZELLIJ_SESSION_NAME: "foo/bar" });

		expect(getTerminalId()).toBe("zellij-foo-bar-123");
	});

	it("prefers KITTY_WINDOW_ID over an inherited WEZTERM_PANE", () => {
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		setTerminalEnv({ KITTY_WINDOW_ID: "window-42", WEZTERM_PANE: "pane-456" });

		expect(getTerminalId()).toBe("kitty-window-42");
	});

	it("uses WEZTERM_PANE when no multiplexer or kitty markers are present", () => {
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		setTerminalEnv({ WEZTERM_PANE: "pane-456", TERM_SESSION_ID: "abc" });

		expect(getTerminalId()).toBe("wezterm-pane-456");
	});
});
