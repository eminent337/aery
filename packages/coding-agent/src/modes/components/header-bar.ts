import * as os from "node:os";
import * as path from "node:path";
import { Container, truncateToWidth, visibleWidth } from "@aryee337/aery-tui";
import { theme } from "../theme/theme";

export interface HeaderBarOptions {
	cwd: string;
	branch?: string | null;
	model?: string;
	enabled?: boolean;
}

export class HeaderBarComponent extends Container {
	#cwd: string;
	#branch: string | null = null;
	#model = "";
	#enabled = true;

	constructor(options: HeaderBarOptions) {
		super();
		this.#cwd = options.cwd;
		this.#branch = options.branch ?? null;
		this.#model = options.model ?? "";
		this.#enabled = options.enabled ?? true;
	}

	setWorkspace(cwd: string): void {
		if (this.#cwd === cwd) return;
		this.#cwd = cwd;
	}

	setBranch(branch: string | null): void {
		if (this.#branch === branch) return;
		this.#branch = branch;
	}

	setModel(model: string): void {
		if (this.#model === model) return;
		this.#model = model;
	}

	setEnabled(enabled: boolean): void {
		this.#enabled = enabled;
	}

	get enabled(): boolean {
		return this.#enabled;
	}

	override render(width: number): string[] {
		if (!this.#enabled) return [];
		width = Math.max(1, width);

		const parts: string[] = [];
		const home = os.homedir();
		const displayCwd = this.#cwd.startsWith(home)
			? `~${this.#cwd.slice(home.length)}`
			: path.basename(this.#cwd) || this.#cwd;

		parts.push(`${theme.fg("dim", "Workspace:")} ${theme.bold(theme.fg("accent", displayCwd))}`);

		if (this.#branch) {
			parts.push(`${theme.fg("dim", "⎇")} ${theme.fg("muted", this.#branch)}`);
		}

		if (this.#model) {
			parts.push(`${theme.fg("dim", "Model:")} ${theme.fg("muted", this.#model)}`);
		}

		const sep = ` ${theme.fg("dim", "·")} `;
		const text = parts.join(sep);
		const textWidth = visibleWidth(text);

		const box = theme.boxRound ?? theme.boxSharp;
		const borderChar = box.horizontal;
		const prefix = `${box.topLeft}${borderChar} `;
		const prefixWidth = visibleWidth(prefix);

		if (prefixWidth + textWidth + 3 <= width) {
			const fillLen = Math.max(0, width - prefixWidth - textWidth - 2);
			const rightBorder = ` ${borderChar.repeat(fillLen)}${box.topRight}`;
			return [theme.fg("dim", prefix) + text + theme.fg("dim", rightBorder)];
		}

		return [truncateToWidth(text, width)];
	}
}
