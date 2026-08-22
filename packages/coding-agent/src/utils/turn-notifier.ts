import { execFile } from "node:child_process";
import { env, platform } from "node:process";

export type TerminalKind =
	| "apple_terminal"
	| "iterm2"
	| "kitty"
	| "ghostty"
	| "windows_terminal"
	| "unknown";

export interface TurnNotification {
	title: string;
	subtitle?: string;
	body: string;
	sessionId?: string;
	sound?: boolean;
}

export interface TerminalRoute {
	kind: TerminalKind;
	bundleId?: string;
	tty?: string;
	sessionId?: string;
}

/**
 * Detect the current terminal emulator using environment variables.
 * Reads env vars fresh each call for testability.
 */
export function detectTerminalKind(): TerminalKind {
	const termProgram = env.TERM_PROGRAM?.toLowerCase() ?? "";
	const term = env.TERM?.toLowerCase() ?? "";

	if (termProgram.includes("iterm") || term.includes("iterm2")) return "iterm2";
	if (termProgram.includes("apple_terminal") || termProgram === "apple terminal") return "apple_terminal";
	if (term.includes("kitty") || env.KITTY_WINDOW_ID) return "kitty";
	if (env.GHOSTTY_RESOURCES_DIR || env.GHOSTTY_BIN_DIR) return "ghostty";
	if (env.WT_SESSION) return "windows_terminal";
	return "unknown";
}

export function detectTerminalRoute(): TerminalRoute {
	const tty = env.TTY ?? undefined;
	const sessionId = env.TERM_SESSION_ID ?? env.ITERM_SESSION_ID ?? env.KITTY_PID ?? undefined;

	return {
		kind: detectTerminalKind(),
		bundleId: env.TERM_PROGRAM,
		tty,
		sessionId,
	};
}

export function getTerminalActivationCommand(route: TerminalRoute): string[] | undefined {
	switch (route.kind) {
		case "apple_terminal":
			return ["/usr/bin/open", "-b", "com.apple.Terminal"];
		case "iterm2":
			return ["/usr/bin/open", "-b", "com.googlecode.iterm2"];
		case "ghostty":
			return ["/usr/bin/open", "-b", "com.mitchellh.ghostty"];
		default:
			return undefined;
	}
}

export function sendTurnNotification(notification: TurnNotification): boolean {
	try {
		const notifier = require("node-notifier");
		if (notifier && notifier.notify) {
			notifier.notify({
				title: notification.title,
				message: notification.body,
				subtitle: notification.subtitle,
				sound: notification.sound ? "Glass" : false,
				wait: false,
				timeout: 10,
			});
			return true;
		}
	} catch {
		// node-notifier not installed, fall through
	}

	if (sendTerminalSequenceNotification(notification)) {
		return true;
	}

	return false;
}

function sendTerminalSequenceNotification(notification: TurnNotification): boolean {
	const route = detectTerminalRoute();

	if (route.kind === "kitty") {
		const payload = JSON.stringify({
			title: notification.title,
			body: notification.body,
			level: "info",
		});
		const osc99 = `\x1b]99;${payload.replace(/[\x00-\x1f\x7f]/g, "")}\x07`;
		process.stdout.write(osc99);
		return true;
	}

	if (route.kind === "iterm2") {
		const osc7 = `\x1b]7;notify;${notification.title};${notification.body}\x07`;
		process.stdout.write(osc7);
		return true;
	}

	return false;
}

export function buildTurnNotification(sessionName?: string, todoProgress?: { total: number; completed: number }): TurnNotification {
	const title = sessionName ? `aery · ${sessionName}` : "aery · done";
	const subtitle = todoProgress
		? `${todoProgress.completed}/${todoProgress.total} todos`
		: undefined;
	const body = todoProgress && todoProgress.total > 0
		? `Finished turn — ${todoProgress.completed}/${todoProgress.total} tasks complete`
		: "Turn complete";

	return { title, subtitle, body };
}
