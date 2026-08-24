/**
 * Action Panel for a selected plugin / extension in the Hub.
 */
import { Container, type SelectItem, SelectList, Spacer, Text, truncateToWidth } from "@aryee337/aery-tui";
import { getSelectListTheme, theme } from "../../../modes/theme/theme";
import { DynamicBorder } from "../dynamic-border";
import type { HubStateManager } from "./state";
import type { HubExtensionItem } from "./types";

export class PluginActionPanel extends Container {
	#selectList!: SelectList;

	constructor(
		private readonly item: HubExtensionItem,
		private readonly stateManager: HubStateManager,
		private readonly onDone: (statusMsg?: string) => void,
	) {
		super();
		this.#build();
	}

	#build(): void {
		this.clear();

		// Header
		this.addChild(new DynamicBorder());
		const tierBadge =
			this.item.tier === "core" ? "⚙ core" : this.item.tier === "verified" ? "✦ verified" : "◆ community";
		this.addChild(new Text(theme.bold(theme.fg("accent", `  ${this.item.name} (${tierBadge})`)), 0, 0));
		this.addChild(
			new Text(
				theme.fg("muted", `  Version: ${this.item.version} · Author: ${this.item.author ?? "Community"}`),
				0,
				0,
			),
		);
		if (this.item.description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", `  ${this.item.description}`), 0, 0));
		}
		this.addChild(new Spacer(1));

		const options: SelectItem[] = [];

		if (!this.item.installed) {
			options.push({
				value: "install-project",
				label: "Install Extension (Project Scope)",
				description: "Install for this repository",
			});
			options.push({
				value: "install-user",
				label: "Install Extension (User Scope)",
				description: "Install globally for your user",
			});
		} else {
			options.push({
				value: "toggle",
				label: this.item.enabled ? "Disable Extension" : "Enable Extension",
				description: `Current status: ${this.item.enabled ? "Active" : "Disabled"}`,
			});
			if (this.item.latestVersion && this.item.latestVersion !== this.item.version) {
				options.push({
					value: "update",
					label: `Update to Latest (v${this.item.latestVersion})`,
					description: "Download and apply new version",
				});
			}
			options.push({
				value: "uninstall",
				label: "Uninstall Extension",
				description: "Remove from local disk",
			});
		}

		options.push({
			value: "back",
			label: "Back to List",
			description: "Return to previous screen",
		});

		this.#selectList = new SelectList(options, Math.min(options.length, 6), getSelectListTheme());
		this.#selectList.onSelect = async opt => {
			if (opt.value === "back") {
				this.onDone();
				return;
			}
			if (opt.value === "install-project") {
				const res = await this.stateManager.installExtension(this.item.id, "project");
				this.onDone(res.message);
				return;
			}
			if (opt.value === "install-user") {
				const res = await this.stateManager.installExtension(this.item.id, "user");
				this.onDone(res.message);
				return;
			}
			if (opt.value === "toggle") {
				const res = await this.stateManager.toggleExtensionEnabled(
					this.item.id,
					!this.item.enabled,
					(this.item.scope as any) ?? "project",
				);
				this.onDone(res.message);
				return;
			}
			if (opt.value === "uninstall") {
				const res = await this.stateManager.uninstallExtension(this.item.id);
				this.onDone(res.message);
				return;
			}
			this.onDone();
		};

		this.#selectList.onCancel = () => this.onDone();

		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to select action · Esc to return"), 0, 0));
		this.addChild(new DynamicBorder());
	}

	handleInput(data: string): void {
		this.#selectList.handleInput(data);
	}
}
