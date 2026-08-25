/**
 * Detailed Platform Configuration & Multi-Bot Management Panel.
 * Supports adding tokens, connecting individual/all bots, switching active bots,
 * reloading/disconnecting specific bots, and removing tokens with confirmation.
 */

import {
	Container,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	Input,
} from "@aryee337/aery-tui";
import { getSelectListTheme, theme } from "../../../modes/theme/theme.js";
import { DynamicBorder } from "../dynamic-border.js";
import { ConnectStateManager, getBotDisplayName } from "./state.js";
import type { PlatformConfig } from "./types.js";

export class ConnectPlatformPanel extends Container {
	#selectList: SelectList | null = null;
	#activeList: SelectList | null = null;
	#input: Input | null = null;
	#inputPrompt: Text | null = null;
	#activeSubmenu: Container | null = null;
	#statusText: Text | null = null;

	constructor(
		private readonly platform: PlatformConfig,
		private readonly stateManager: ConnectStateManager,
		private readonly onDone: (statusMsg?: string) => void,
		private readonly onRequestRender?: () => void,
	) {
		super();
		this.#buildMenu();
	}

	#buildMenu(): void {
		this.clear();
		this.#activeSubmenu = null;
		this.#activeList = null;
		this.#input = null;
		this.#inputPrompt = null;

		this.addChild(new DynamicBorder());

		// Header
		const connectedCount = this.platform.bots.filter(b => b.status === "connected").length;
		const totalTokens = this.platform.botTokens.length;
		const statusIcon =
			connectedCount > 0
				? theme.fg("success", `● ${connectedCount} Active Bot${connectedCount === 1 ? "" : "s"}`)
				: theme.fg("muted", "○ Disconnected");

		this.addChild(
			new Text(
				`${this.platform.icon} ${theme.bold(this.platform.name)}  ${theme.fg("dim", `[${this.platform.mode}]`)}  ${statusIcon}`,
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));

		if (this.#statusText) {
			this.addChild(this.#statusText);
			this.addChild(new Spacer(1));
		}

		// Options
		const options: SelectItem[] = [
			{
				value: "add-bot-token",
				label: "➕ Add Bot Token",
				description: "Append a new bot token to your bot pool",
			},
		];

		if (totalTokens > 0) {
			options.push({
				value: "connect-bot-menu",
				label: "▶ Connect Bot...",
				description: "Select which bot token to connect",
			});

			if (totalTokens > 1) {
				options.push({
					value: "connect-all-bots",
					label: "▶▶ Connect All Active Tokens",
					description: `Connect all ${totalTokens} configured bots at once`,
				});
			}

			if (connectedCount > 0) {
				options.push({
					value: "connected-bots-menu",
					label: `● Connected Bots (${connectedCount} active)`,
					description: "Switch to a connected bot to reload or disconnect",
				});
			}

			options.push({
				value: "delete-bot-menu",
				label: "🗑 Delete Bot Token...",
				description: "Select a bot token to completely remove from storage",
			});
		}

		if (this.platform.id === "slack") {
			options.push({
				value: "edit-app-token",
				label: "✎ Set Slack App Token",
				description: "Slack App-Level Token (xapp-...) with connections:write scope",
			});
		}

		options.push({
			value: "edit-passcode",
			label: "🔐 Set Security Passcode",
			description: "Require password on chat start and after 10m inactivity",
		});

		options.push({
			value: "back",
			label: "← Back to Connect Hub",
			description: "Return to platform list",
		});

		this.#selectList = new SelectList(options, Math.min(options.length, 8), getSelectListTheme());
		this.#selectList.onSelect = async item => {
			if (item.value === "back") {
				this.onDone();
				return;
			}
			if (item.value === "add-bot-token") {
				this.#promptInput("add-bot-token");
				return;
			}
			if (item.value === "connect-bot-menu") {
				this.#openConnectBotMenu();
				return;
			}
			if (item.value === "connect-all-bots") {
				await this.#handleConnectAll();
				return;
			}
			if (item.value === "connected-bots-menu") {
				this.#openConnectedBotsMenu();
				return;
			}
			if (item.value === "delete-bot-menu") {
				this.#openDeleteBotMenu();
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
		};

		this.#selectList.onCancel = () => this.onDone();
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.onRequestRender?.();
	}

	#openConnectBotMenu(): void {
		const submenu = new Container();
		submenu.addChild(new Text(theme.bold("  Select Bot Token to Connect:"), 0, 0));
		submenu.addChild(new Spacer(1));

		const items: SelectItem[] = this.platform.bots.map(bot => {
			const isConn = bot.status === "connected";
			const statusLabel = isConn ? theme.fg("success", "● Active") : theme.fg("muted", "○ Disconnected");
			return {
				value: bot.token,
				label: `  ${bot.name}  ${statusLabel}`,
				description: isConn ? "Already running" : "Click to establish live connection",
			};
		});

		items.push({ value: "back", label: "← Back", description: "Return to menu" });

		const list = new SelectList(items, Math.min(items.length, 7), getSelectListTheme());
		this.#activeList = list;
		list.onSelect = async item => {
			if (item.value === "back") {
				this.#buildMenu();
				return;
			}
			this.#statusText = new Text(theme.fg("accent", `  Connecting ${getBotDisplayName(item.value)}...`), 0, 0);
			this.#buildMenu();
			const res = await this.stateManager.connectBot(this.platform.id, item.value, msg => {
				this.#statusText = new Text(theme.fg("dim", `  ${msg}`), 0, 0);
				this.onRequestRender?.();
			});
			this.#statusText = new Text(
				res.ok ? theme.fg("success", `  ✓ ${res.message}`) : theme.fg("error", `  ✕ ${res.message}`),
				0,
				0,
			);
			await this.#reloadState();
		};
		list.onCancel = () => this.#buildMenu();

		submenu.addChild(list);
		this.#swapContent(submenu);
	}

	#openConnectedBotsMenu(): void {
		const connectedBots = this.platform.bots.filter(b => b.status === "connected");
		const submenu = new Container();
		submenu.addChild(new Text(theme.bold(`  Connected Bots (${connectedBots.length} Active):`), 0, 0));
		submenu.addChild(new Spacer(1));

		const items: SelectItem[] = connectedBots.map(bot => ({
			value: bot.token,
			label: `  ● ${theme.bold(bot.name || "Bot")}`,
			description: "Select to reload or disconnect this bot",
		}));
		items.push({ value: "disconnect-all", label: "■ Disconnect All Active Bots", description: "Shut down all connections" });
		items.push({ value: "back", label: "← Back", description: "Return to menu" });

		const list = new SelectList(items, Math.min(items.length, 7), getSelectListTheme());
		this.#activeList = list;
		list.onSelect = async item => {
			if (item.value === "back") {
				this.#buildMenu();
				return;
			}
			if (item.value === "disconnect-all") {
				await this.stateManager.disconnectAll(this.platform.id);
				this.#statusText = new Text(theme.fg("success", "  ✓ All bots disconnected."), 0, 0);
				await this.#reloadState();
				return;
			}
			this.#openBotActionMenu(item.value);
		};
		list.onCancel = () => this.#buildMenu();

		submenu.addChild(list);
		this.#swapContent(submenu);
	}

	#openBotActionMenu(token: string): void {
		const botName = getBotDisplayName(token);
		const submenu = new Container();
		submenu.addChild(new Text(theme.bold(`  Manage Bot: ${botName}`), 0, 0));
		submenu.addChild(new Spacer(1));

		const items: SelectItem[] = [
			{
				value: "reload",
				label: "↻ Reload Bot",
				description: "Restart this bot connector process",
			},
			{
				value: "disconnect",
				label: "■ Disconnect Bot",
				description: "Stop polling and disconnect this bot",
			},
			{
				value: "back",
				label: "← Back to Connected Bots",
				description: "Return to connected bot list",
			},
		];

		const list = new SelectList(items, 3, getSelectListTheme());
		this.#activeList = list;
		list.onSelect = async item => {
			if (item.value === "back") {
				this.#openConnectedBotsMenu();
				return;
			}
			if (item.value === "reload") {
				this.#statusText = new Text(theme.fg("accent", `  Reloading ${botName}...`), 0, 0);
				this.#buildMenu();
				const res = await this.stateManager.reloadBot(this.platform.id, token, msg => {
					this.#statusText = new Text(theme.fg("dim", `  ${msg}`), 0, 0);
					this.onRequestRender?.();
				});
				this.#statusText = new Text(
					res.ok ? theme.fg("success", `  ✓ ${res.message}`) : theme.fg("error", `  ✕ ${res.message}`),
					0,
					0,
				);
				await this.#reloadState();
				return;
			}
			if (item.value === "disconnect") {
				await this.stateManager.disconnectBot(this.platform.id, token);
				this.#statusText = new Text(theme.fg("success", `  ✓ ${botName} disconnected.`), 0, 0);
				await this.#reloadState();
				return;
			}
		};
		list.onCancel = () => this.#openConnectedBotsMenu();

		submenu.addChild(list);
		this.#swapContent(submenu);
	}

	#openDeleteBotMenu(): void {
		const submenu = new Container();
		submenu.addChild(new Text(theme.bold(theme.fg("error", "  Select Bot Token to Delete:")), 0, 0));
		submenu.addChild(new Spacer(1));

		const items: SelectItem[] = this.platform.botTokens.map(token => ({
			value: token,
			label: `  🗑 ${getBotDisplayName(token)}`,
			description: "Click to confirm removal",
		}));
		items.push({ value: "back", label: "← Back", description: "Return to menu" });

		const list = new SelectList(items, Math.min(items.length, 7), getSelectListTheme());
		this.#activeList = list;
		list.onSelect = item => {
			if (item.value === "back") {
				this.#buildMenu();
				return;
			}
			this.#confirmDelete(item.value);
		};
		list.onCancel = () => this.#buildMenu();

		submenu.addChild(list);
		this.#swapContent(submenu);
	}

	#confirmDelete(token: string): void {
		const botName = getBotDisplayName(token);
		const submenu = new Container();
		submenu.addChild(new Text(theme.bold(theme.fg("error", `  Confirm Delete: Remove ${botName}?`)), 0, 0));
		submenu.addChild(new Text(theme.fg("muted", "  This will disconnect the bot and delete its token from settings."), 0, 0));
		submenu.addChild(new Spacer(1));

		const items: SelectItem[] = [
			{ value: "yes", label: "✓ Yes, Delete Token", description: "Permanently delete this token" },
			{ value: "no", label: "✕ No, Cancel", description: "Keep token and return" },
		];

		const list = new SelectList(items, 2, getSelectListTheme());
		this.#activeList = list;
		list.onSelect = async item => {
			if (item.value === "yes") {
				this.stateManager.removeBotToken(this.platform.id, token);
				this.#statusText = new Text(theme.fg("success", `  ✓ ${botName} removed.`), 0, 0);
				await this.#reloadState();
			} else {
				this.#openDeleteBotMenu();
			}
		};
		list.onCancel = () => this.#openDeleteBotMenu();

		submenu.addChild(list);
		this.#swapContent(submenu);
	}

	async #handleConnectAll(): Promise<void> {
		this.#statusText = new Text(theme.fg("accent", "  Connecting all bots..."), 0, 0);
		this.#buildMenu();
		const res = await this.stateManager.connectAll(this.platform.id, msg => {
			this.#statusText = new Text(theme.fg("dim", `  ${msg}`), 0, 0);
			this.onRequestRender?.();
		});
		this.#statusText = new Text(
			res.ok ? theme.fg("success", `  ✓ ${res.message}`) : theme.fg("error", `  ✕ ${res.message}`),
			0,
			0,
		);
		await this.#reloadState();
	}

	async #reloadState(): Promise<void> {
		const updated = await this.stateManager.loadPlatforms();
		const found = updated.find(p => p.id === this.platform.id);
		if (found) {
			Object.assign(this.platform, found);
		}
		this.#buildMenu();
	}

	#swapContent(child: Container): void {
		this.clear();
		this.#activeSubmenu = child;
		this.addChild(new DynamicBorder());
		this.addChild(child);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.onRequestRender?.();
	}

	#promptInput(mode: "add-bot-token" | "app-token" | "passcode"): void {
		this.clear();
		this.#activeSubmenu = null;
		this.#activeList = null;
		this.addChild(new DynamicBorder());

		const title =
			mode === "add-bot-token"
				? "Add New Bot Token"
				: mode === "app-token"
					? "Set Slack App Token"
					: "Set Security Passcode";

		this.#inputPrompt = new Text(theme.bold(`  ${title}:`), 0, 0);
		this.addChild(this.#inputPrompt);
		this.addChild(new Spacer(1));

		this.#input = new Input();
		this.#input.onSubmit = async val => {
			const trimmed = val.trim();
			if (mode === "add-bot-token" && trimmed) {
				this.stateManager.addBotToken(this.platform.id, trimmed);
				this.#statusText = new Text(theme.fg("success", `  ✓ Added ${getBotDisplayName(trimmed)}.`), 0, 0);
			} else if (mode === "app-token") {
				// save app token
			} else if (mode === "passcode") {
				this.stateManager.setPasscode(trimmed || undefined);
				this.#statusText = new Text(
					trimmed ? theme.fg("success", "  ✓ Security Passcode updated.") : theme.fg("muted", "  ○ Passcode cleared."),
					0,
					0,
				);
			}
			await this.#reloadState();
		};

		this.addChild(this.#input);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to submit · Esc to cancel"), 0, 0));
		this.addChild(new DynamicBorder());
		this.onRequestRender?.();
	}

	handleInput(data: string): void {
		if (this.#input) {
			if (data === "\x1b" || data === "\x1b\x1b") {
				this.#buildMenu();
				return;
			}
			this.#input.handleInput(data);
			this.onRequestRender?.();
			return;
		}
		if (this.#activeList) {
			this.#activeList.handleInput(data);
			this.onRequestRender?.();
			return;
		}
		if (this.#selectList) {
			this.#selectList.handleInput(data);
			this.onRequestRender?.();
		}
	}
}
