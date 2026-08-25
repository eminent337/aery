import { Container, type SelectItem, SelectList, Spacer, Text } from "@aryee337/aery-tui";
import { getSelectListTheme, theme } from "../../../modes/theme/theme";
import { DynamicBorder } from "../dynamic-border";
import type { SkillsStateManager } from "./state";
import type { SkillItem } from "./types";

export class SkillActionPanel extends Container {
	#selectList!: SelectList;

	constructor(
		private readonly skill: SkillItem,
		private readonly stateManager: SkillsStateManager,
		private readonly onDone: (statusMsg?: string) => void,
		private readonly onRequestRender?: () => void,
	) {
		super();
		this.#build();
	}

	#build(): void {
		this.clear();

		// Header
		this.addChild(new DynamicBorder());
		const statusBadge = this.skill.installed
			? theme.fg("success", "● Installed")
			: theme.fg("muted", "○ Available");

		this.addChild(
			new Text(
				theme.bold(theme.fg("accent", `  ✦ ${this.skill.name}`)) +
					`  [${this.skill.category}]  [${statusBadge}]`,
				0,
				0,
			),
		);

		this.addChild(new Text(theme.fg("dim", `  Source: ${this.skill.source}`), 0, 0));

		if (this.skill.description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", `  ${this.skill.description}`), 0, 0));
		}

		if (this.skill.installCmd) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", `  Install command: ${this.skill.installCmd}`), 0, 0));
		}

		this.addChild(new Spacer(1));

		const options: SelectItem[] = [];

		if (!this.skill.installed && this.skill.installCmd) {
			options.push({
				value: "install",
				label: "▶ Install Skill",
				description: "Run npx install command for this skill",
			});
		}

		options.push({
			value: "back",
			label: "← Back to Skills Catalog",
			description: "Return to skill list",
		});

		this.#selectList = new SelectList(options, Math.min(options.length, 5), getSelectListTheme());
		this.#selectList.onSelect = async item => {
			if (item.value === "back") {
				this.onDone();
				return;
			}

			if (item.value === "install") {
				this.clear();
				this.addChild(new DynamicBorder());
				this.addChild(new Text(theme.fg("accent", `  Installing skill ${this.skill.name}...`), 0, 0));
				this.addChild(new DynamicBorder());
				this.onRequestRender?.();

				const res = await this.stateManager.installSkill(this.skill);
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

	handleInput(data: string): void {
		if (this.#selectList) {
			this.#selectList.handleInput(data);
		}
	}
}
