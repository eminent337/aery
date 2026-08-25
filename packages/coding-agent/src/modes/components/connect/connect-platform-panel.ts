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

			// Slack Setup Guide Box
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.bold(theme.fg("accent", "  📖 Slack Setup Guide:")), 0, 0));
			this.addChild(
				new Text(
					theme.fg(
						"dim",
						"  1. Go to https://api.slack.com/apps → Create New App (From scratch)",
					),
					0,
					0,
				),
			);
			this.addChild(
				new Text(
					theme.fg(
						"dim",
						"  2. Settings → Socket Mode → Enable Socket Mode → Create App Token (xapp-...) with `connections:write`",
					),
					0,
					0,
				),
			);
			this.addChild(
				new Text(
					theme.fg(
						"dim",
						"  3. Features → OAuth & Permissions → Scopes: add `app_mentions:read`, `chat:write`, `channels:history`",
					),
					0,
					0,
				),
			);
			this.addChild(
				new Text(
					theme.fg(
						"dim",
						"  4. Features → Event Subscriptions → Enable Events → Subscribe to bot event: `app_mention`",
					),
					0,
					0,
				),
			);
			this.addChild(
				new Text(
					theme.fg(
						"dim",
						"  5. Install to Workspace → Copy Bot User OAuth Token (xoxb-...) & App Token (xapp-...)",
					),
					0,
					0,
				),
			);
		} else if (this.platform.id === "telegram") {
			// Telegram Setup Guide Box
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.bold(theme.fg("accent", "  📖 Telegram Setup Guide:")), 0, 0));
			this.addChild(
				new Text(
					theme.fg(
						"dim",
						"  1. Open Telegram and search for @BotFather (verified bot creator)",
					),
					0,
					0,
				),
			);
			this.addChild(
				new Text(
					theme.fg(
						"dim",
						"  2. Send `/newbot` and follow prompts to pick a name and username ending in `bot`",
					),
					0,
					0,
				),
			);
			this.addChild(
				new Text(
					theme.fg(
						"dim",
						"  3. BotFather will provide an HTTP API token (e.g. `123456789:ABCdefGhIJKlmNo...`)",
					),
					0,
					0,
				),
			);
			this.addChild(
				new Text(
					theme.fg(
						"dim",
						"  4. Copy that token and set it in 'Set Bot Token' below, then hit Connect!",
					),
					0,
					0,
				),
			);
		}

		this.addChild(new Spacer(1));

		// Action options
		const options: SelectItem[] = [];

		if (this.platform.status === "connected") {
			options.push({
				value: "disconnect",
				label: "■ Disconnect Platform",
				description: "Immediately shut down active connector and stop polling",
			});
			options.push({
				value: "reconnect",
				label: "↺ Reconnect Platform",
				description: "Restart active connection",
			});
		} else {
			options.push({
				value: "connect",
				label: "▶ Connect Platform",
				description: "Establish live connection with configured tokens",
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
			value: "edit-passcode",
			label: "🔐 Set Security Passcode",
			description: "Require password on chat start and after 10m inactivity",
		});

		if (this.#botToken || this.#appToken) {
			options.push({
				value: "clear-tokens-menu",
				label: "🗑 Manage / Delete Tokens",
				description: "Select individual tokens to clear or delete all",
			});
		}

		options.push({
			value: "back",
			label: "← Back to Connect Hub",
			description: "Return to platform list",
		});

		this.#selectList = new SelectList(options, Math.min(options.length, 7), getSelectListTheme());
		this.#selectList.onSelect = async item => {
			if (item.value === "back") {
				this.onDone();
				return;
			}

			if (item.value === "clear-tokens-menu") {
				this.#openClearTokensMenu();
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

			if (item.value === "edit-passcode") {
				this.#promptInput("passcode");
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

	#promptInput(type: "bot-token" | "app-token" | "passcode"): void {
		this.clear();
		this.#currentMode = type === "bot-token" ? "input-bot-token" : type === "app-token" ? "input-app-token" : "input-passcode" as any;
		this.#selectList = null;

		this.addChild(new DynamicBorder());
		const label =
			type === "bot-token"
				? this.platform.id === "slack"
					? "Enter Slack Bot Token (xoxb-...)"
					: "Enter Telegram Bot Token"
				: type === "app-token"
					? "Enter Slack App-Level Token (xapp-...)"
					: "Enter Security Passcode (leave empty to disable)";

		this.addChild(new Text(theme.bold(theme.fg("accent", `  ${label}`)), 0, 0));
		this.addChild(new Spacer(1));

		this.#tokenInput = new Input();
		const currentPasscode = (this.stateManager as any).getPasscode?.() ?? "";
		const currentVal = type === "bot-token" ? this.#botToken : type === "app-token" ? this.#appToken : currentPasscode;
		if (currentVal) {
			this.#tokenInput.setValue(currentVal);
			this.#tokenInput.handleInput("\x05"); // move to end
		}

		this.#tokenInput.onSubmit = val => {
			const clean = val.trim();
			if (type === "bot-token") {
				this.#botToken = clean;
				this.stateManager.saveCredentials(this.platform.id, { botToken: clean });
			} else if (type === "app-token") {
				this.#appToken = clean;
				this.stateManager.saveCredentials(this.platform.id, { appToken: clean });
			} else if (type === "passcode") {
				(this.stateManager as any).setPasscode?.(clean || undefined);
			}
			this.#buildMenu();
		};

		this.addChild(this.#tokenInput);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter: save · Esc: cancel"), 0, 0));
		this.addChild(new DynamicBorder());
		this.onRequestRender?.();
	}

	#openClearTokensMenu(): void {
		this.clear();
		this.#currentMode = "menu";
		this.#tokenInput = null;

		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", `  Manage / Delete Saved Tokens`)), 0, 0));
		this.addChild(new Text(theme.fg("dim", `  Select a specific token to delete, or wipe all credentials`), 0, 0));
		this.addChild(new Spacer(1));

		const options: SelectItem[] = [];

		if (this.#botToken) {
			const masked = `${this.#botToken.slice(0, 8)}...${this.#botToken.slice(-4)}`;
			options.push({
				value: "delete-bot-token",
				label: `🗑 Clear Bot Token (${masked})`,
				description: "Remove Bot Token only",
			});
		}

		if (this.platform.id === "slack" && this.#appToken) {
			const masked = `${this.#appToken.slice(0, 8)}...${this.#appToken.slice(-4)}`;
			options.push({
				value: "delete-app-token",
				label: `🗑 Clear App Token (${masked})`,
				description: "Remove App-Level Token only",
			});
		}

		options.push({
			value: "delete-all",
			label: "⚠ Clear ALL Tokens",
			description: "Wipe all credentials and reset connection",
		});

		options.push({
			value: "back",
			label: "← Back",
			description: "Return to previous menu",
		});

		this.#selectList = new SelectList(options, Math.min(options.length, 6), getSelectListTheme());
		this.#selectList.onSelect = async item => {
			if (item.value === "back") {
				this.#buildMenu();
				return;
			}

			if (item.value === "delete-bot-token") {
				this.#botToken = "";
				this.stateManager.clearCredentials(this.platform.id, "botToken");
				this.#buildMenu();
				return;
			}

			if (item.value === "delete-app-token") {
				this.#appToken = "";
				this.stateManager.clearCredentials(this.platform.id, "appToken");
				this.#buildMenu();
				return;
			}

			if (item.value === "delete-all") {
				this.#botToken = "";
				this.#appToken = "";
				this.stateManager.clearCredentials(this.platform.id, "all");
				this.#buildMenu();
				return;
			}
		};

		this.#selectList.onCancel = () => this.#buildMenu();

		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter: select action · Esc: return"), 0, 0));
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
