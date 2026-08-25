import { Container, Input, type SelectItem, SelectList, Spacer, Text } from "@aryee337/aery-tui";
import { getSelectListTheme, theme } from "../../../modes/theme/theme";
import { DynamicBorder } from "../dynamic-border";
import type { ConnectStateManager } from "./state";
import type { PlatformConfig } from "./types";

/**
 * Configuration & Action Panel for a single chat connector platform (Slack / Telegram).
 */
export class ConnectPlatformPanel extends Container {
	#currentMode: "menu" | "input-bot-token" | "input-app-token" = "menu";
	#selectList: SelectList | null = null;
	#tokenInput: Input | null = null;
	#botToken: string;
	#appToken: string;

	constructor(
		private readonly platform: PlatformConfig,
		private readonly stateManager: ConnectStateManager,
		private readonly onDone: (statusMsg?: string) => void,
		private readonly onRequestRender?: () => void,
	) {
		super();
		this.#botToken = platform.botToken ?? "";
		this.#appToken = platform.appToken ?? "";
		this.#buildMenu();
	}

	#buildMenu(): void {
		this.clear();
		this.#currentMode = "menu";
		this.#tokenInput = null;

		// Top border
		this.addChild(new DynamicBorder());

		// Platform title & status
		const statusBadge =
			this.platform.status === "connected"
				? theme.fg("success", "● Connected")
				: this.platform.status === "error"
					? theme.fg("error", "✕ Error")
					: theme.fg("muted", "○ Disconnected");

		this.addChild(
			new Text(
				theme.bold(theme.fg("accent", `  ${this.platform.icon} ${this.platform.name} Connector`)) +
					`  [${statusBadge}]`,
				0,
				0,
			),
		);

		this.addChild(
			new Text(theme.fg("dim", `  Mode: ${this.platform.mode} · ${this.platform.description}`), 0, 0),
		);

		if (this.platform.errorMessage) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("error", `  Error: ${this.platform.errorMessage}`), 0, 0));
		}

		// Token status lines
		this.addChild(new Spacer(1));
		const maskedBot = this.#botToken
			? `••••••••${this.#botToken.slice(-6)}`
			: theme.fg("warning", "(not configured)");
		this.addChild(new Text(`  Bot Token:  ${theme.bold(maskedBot)}`, 0, 0));

		if (this.platform.id === "slack") {
			const maskedApp = this.#appToken
				? `••••••••${this.#appToken.slice(-6)}`
				: theme.fg("warning", "(not configured - required for Socket Mode)");
			this.addChild(new Text(`  App Token:  ${theme.bold(maskedApp)}`, 0, 0));
		}

		this.addChild(new Spacer(1));

		// Action options
		const options: SelectItem[] = [];

		if (this.platform.status !== "connected") {
			options.push({
				value: "connect",
				label: "▶ Connect Platform",
				description: "Establish live connection with configured tokens",
			});
		} else {
			options.push({
				value: "reconnect",
				label: "↺ Reconnect Platform",
				description: "Restart active connection",
			});
			options.push({
				value: "disconnect",
				label: "■ Disconnect",
				description: "Shut down active connection",
			});
		}

		options.push({
			value: "edit-bot-token",
			label: "✎ Set Bot Token",
			description: this.platform.id === "slack" ? "Slack Bot User OAuth Token (xoxb-...)" : "Telegram Bot Token",
		});

		if (this.platform.id === "slack") {
			options.push({
				value: "edit-app-token",
				label: "✎ Set App Token",
				description: "Slack App-Level Token (xapp-...) with connections:write scope",
			});
		}

		options.push({
			value: "back",
			label: "← Back to Connect Hub",
			description: "Return to platform list",
		});

		this.#selectList = new SelectList(options, Math.min(options.length, 6), getSelectListTheme());
		this.#selectList.onSelect = async item => {
			if (item.value === "back") {
				this.onDone();
				return;
			}

			if (item.value === "edit-bot-token") {
				this.#promptInput("bot-token");
				return;
			}

			if (item.value === "edit-app-token") {
				this.#promptInput("app-token");
				return;
			}

			if (item.value === "disconnect") {
				const res = await this.stateManager.disconnectPlatform(this.platform.id);
				this.onDone(res.message);
				return;
			}

			if (item.value === "connect" || item.value === "reconnect") {
				if (!this.#botToken) {
					this.#promptInput("bot-token");
					return;
				}
				if (this.platform.id === "slack" && !this.#appToken) {
					this.#promptInput("app-token");
					return;
				}

				this.clear();
				this.addChild(new DynamicBorder());
				this.addChild(new Text(theme.fg("accent", `  Connecting to ${this.platform.name}...`), 0, 0));
				this.addChild(new DynamicBorder());
				this.onRequestRender?.();

				const res = await this.stateManager.connectPlatform(
					this.platform.id,
					{ botToken: this.#botToken, appToken: this.#appToken },
					msg => {},
				);
				this.onDone(res.message);
				return;
			}
		};

		this.#selectList.onCancel = () => this.onDone();

		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter: select action · Esc: return"), 0, 0));
		this.addChild(new DynamicBorder());
		this.onRequestRender?.();
	}

	#promptInput(type: "bot-token" | "app-token"): void {
		this.clear();
		this.#currentMode = type === "bot-token" ? "input-bot-token" : "input-app-token";
		this.#selectList = null;

		this.addChild(new DynamicBorder());
		const label =
			type === "bot-token"
				? this.platform.id === "slack"
					? "Enter Slack Bot Token (xoxb-...)"
					: "Enter Telegram Bot Token"
				: "Enter Slack App-Level Token (xapp-...)";

		this.addChild(new Text(theme.bold(theme.fg("accent", `  ${label}`)), 0, 0));
		this.addChild(new Spacer(1));

		this.#tokenInput = new Input();
		const currentVal = type === "bot-token" ? this.#botToken : this.#appToken;
		if (currentVal) {
			this.#tokenInput.setValue(currentVal);
			this.#tokenInput.handleInput("\x05"); // move to end
		}

		this.#tokenInput.onSubmit = val => {
			const clean = val.trim();
			if (type === "bot-token") {
				this.#botToken = clean;
				this.stateManager.saveCredentials(this.platform.id, { botToken: clean });
			} else {
				this.#appToken = clean;
				this.stateManager.saveCredentials(this.platform.id, { appToken: clean });
			}
			this.#buildMenu();
		};

		this.addChild(this.#tokenInput);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter: save token · Esc: cancel"), 0, 0));
		this.addChild(new DynamicBorder());
		this.onRequestRender?.();
	}

	handleInput(data: string): void {
		if (this.#currentMode === "menu" && this.#selectList) {
			this.#selectList.handleInput(data);
			return;
		}

		if (this.#tokenInput) {
			if (data === "\x1b" || data === "\x1b\x1b") {
				this.#buildMenu();
				return;
			}
			this.#tokenInput.handleInput(data);
			this.onRequestRender?.();
		}
	}
}
