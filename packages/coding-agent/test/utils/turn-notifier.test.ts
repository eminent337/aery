import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { env } from "node:process";

let originalEnv: NodeJS.ProcessEnv;

describe("turn-notifier", () => {
	beforeEach(() => {
		originalEnv = { ...env };
		// Clear relevant env vars for each test
		delete env.TERM_PROGRAM;
		delete env.TERM;
		delete env.KITTY_WINDOW_ID;
		delete env.GHOSTTY_RESOURCES_DIR;
		delete env.GHOSTTY_BIN_DIR;
		delete env.WT_SESSION;
	});

	afterEach(() => {
		// Restore original env
		Object.keys(env).forEach(key => {
			if (!(key in originalEnv)) {
				delete env[key];
			}
		});
		Object.assign(env, originalEnv);
	});

	it("detects iTerm2 from TERM_PROGRAM", () => {
		env.TERM_PROGRAM = "iTerm.app";
		const { detectTerminalKind } = require("../../src/utils/turn-notifier");
		expect(detectTerminalKind()).toBe("iterm2");
	});

	it("detects Kitty from TERM", () => {
		env.TERM = "xterm-kitty";
		const { detectTerminalKind } = require("../../src/utils/turn-notifier");
		expect(detectTerminalKind()).toBe("kitty");
	});

	it("detects Kitty from KITTY_WINDOW_ID", () => {
		env.KITTY_WINDOW_ID = "1";
		const { detectTerminalKind } = require("../../src/utils/turn-notifier");
		expect(detectTerminalKind()).toBe("kitty");
	});

	it("detects Ghostty from GHOSTTY_RESOURCES_DIR", () => {
		env.GHOSTTY_RESOURCES_DIR = "/usr/lib/ghostty";
		const { detectTerminalKind } = require("../../src/utils/turn-notifier");
		expect(detectTerminalKind()).toBe("ghostty");
	});

	it("detects Windows Terminal from WT_SESSION", () => {
		env.WT_SESSION = "some-session-id";
		const { detectTerminalKind } = require("../../src/utils/turn-notifier");
		expect(detectTerminalKind()).toBe("windows_terminal");
	});

	it("falls back to unknown when no env vars set", () => {
		const { detectTerminalKind } = require("../../src/utils/turn-notifier");
		expect(detectTerminalKind()).toBe("unknown");
	});

	it("builds correct turn notification with todos", () => {
		const { buildTurnNotification } = require("../../src/utils/turn-notifier");
		const notification = buildTurnNotification("test-session", { total: 5, completed: 3 });
		expect(notification.title).toBe("aery · test-session");
		expect(notification.subtitle).toBe("3/5 todos");
		expect(notification.body).toContain("3/5");
	});

	it("builds turn notification without todos", () => {
		const { buildTurnNotification } = require("../../src/utils/turn-notifier");
		const notification = buildTurnNotification("my-session");
		expect(notification.title).toBe("aery · my-session");
		expect(notification.subtitle).toBeUndefined();
		expect(notification.body).toBe("Turn complete");
	});

	it("send_notification_returns_boolean", () => {
		const { sendTurnNotification } = require("../../src/utils/turn-notifier");
		const result = sendTurnNotification({
			title: "test",
			body: "test body",
		});
		expect(typeof result).toBe("boolean");
	});
});
