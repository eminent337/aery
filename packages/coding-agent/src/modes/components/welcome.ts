import {
	type Component,
	Ellipsis,
	padding,
	replaceTabs,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@aryee337/aery-tui";
import { theme } from "../../modes/theme/theme";
import tipsText from "./tips.txt" with { type: "text" };

/** Tips embedded at build time, one per line; blanks dropped. */
const TIPS: readonly string[] = tipsText
	.split("\n")
	.map(line => line.trim())
	.filter(line => line.length > 0);

export function renderWelcomeTip(tip: string, boxWidth: number): string[] {
	const label = "Tip: ";
	const labelWidth = visibleWidth(label);
	const bodyBudget = boxWidth - 1 - labelWidth; // 1 = leading indent
	if (bodyBudget < 8) return [];

	const wrappedBody = wrapTextWithAnsi(replaceTabs(tip), bodyBudget);
	if (wrappedBody.length === 0) return [];

	const continuationIndent = padding(labelWidth);

	return wrappedBody.map((body, index) =>
		index === 0
			? ` ${theme.italic(theme.fg("accent", label))}${theme.italic(theme.fg("dim", body))}`
			: ` ${continuationIndent}${theme.italic(theme.fg("dim", body))}`,
	);
}

export interface RecentSession {
	name: string;
	timeAgo: string;
}

export interface LspServerInfo {
	name: string;
	status: "ready" | "error" | "connecting";
	fileTypes: string[];
}

/**
 * Minimalist welcome screen matching classic Aery identity.
 */
export class WelcomeComponent implements Component {
	constructor(
		private readonly version: string,
		public modelName: string,
		public providerName: string,
		public recentSessions: RecentSession[] = [],
		public lspServers: LspServerInfo[] = [],
	) {}

	invalidate(): void {}

	/**
	 * No intro animation in simple mode.
	 */
	playIntro(requestRender: () => void): void {
		requestRender();
	}

	setModel(modelName: string, providerName: string): void {
		this.modelName = modelName;
		this.providerName = providerName;
	}

	setRecentSessions(sessions: RecentSession[]): void {
		this.recentSessions = sessions;
	}

	setLspServers(servers: LspServerInfo[]): void {
		this.lspServers = servers;
	}

	render(termWidth: number): string[] {
		const boxWidth = Math.max(0, termWidth - 2);
		if (boxWidth < 10) return [];
		const contentWidth = boxWidth - 2;
		const out: string[] = [];
		const border = (t: string) => theme.fg("headerBorder", t);

		out.push(border(`╭${"─".repeat(contentWidth)}╮`));

		const titleLine = ` >_ aery (v${this.version})`;
		const truncTitle = truncateToWidth(titleLine, contentWidth, Ellipsis.Unicode);
		out.push(
			border("│") +
				theme.fg("headerTitle", theme.bold(truncTitle)) +
				padding(Math.max(0, contentWidth - visibleWidth(truncTitle))) +
				border("│"),
		);

		out.push(border("│") + padding(contentWidth) + border("│"));

		const modelStr = ` model:     ${this.modelName}`;
		const modelHint = "   /model to change";
		const rawModelLine = modelStr + modelHint;
		const truncModelLine = truncateToWidth(rawModelLine, contentWidth, Ellipsis.Unicode);

		let formattedModelLine: string;
		if (visibleWidth(rawModelLine) <= contentWidth) {
			formattedModelLine = theme.fg("headerLabel", modelStr) + theme.fg("headerHint", modelHint);
		} else {
			formattedModelLine = theme.fg("headerValue", truncModelLine);
		}

		out.push(
			border("│") +
				formattedModelLine +
				padding(Math.max(0, contentWidth - visibleWidth(truncModelLine))) +
				border("│"),
		);

		const dirStr = ` directory: ${process.cwd()}`;
		const truncDir = truncateToWidth(dirStr, contentWidth, Ellipsis.Unicode);
		out.push(
			border("│") +
				theme.fg("headerValue", truncDir) +
				padding(Math.max(0, contentWidth - visibleWidth(truncDir))) +
				border("│"),
		);

		out.push(border("│") + padding(contentWidth) + border("│"));

		for (const server of this.lspServers) {
			const statusIcon =
				server.status === "ready"
					? theme.status.success
					: server.status === "error"
						? theme.status.error
						: theme.status.pending;
			const serverLine = ` ${server.name}   ${statusIcon} ${server.status}`;
			const truncServer = truncateToWidth(serverLine, contentWidth, Ellipsis.Unicode);
			out.push(
				border("│") +
					theme.fg("headerValue", truncServer) +
					padding(Math.max(0, contentWidth - visibleWidth(truncServer))) +
					border("│"),
			);
		}

		out.push(border(`╰${"─".repeat(contentWidth)}╯`));
		return out;
	}
}

// Ensure these are exported if any other module was importing them
export const AERY_LOGO: string[] = ["aery"];
export interface ShineConfig {
	pos?: number;
	strength?: number;
}
export function gradientEscape(t?: number, shine?: ShineConfig): string {
	return "";
}
export function gradientLogo(lines?: readonly string[], phase?: number, shine?: ShineConfig): string[] {
	return ["aery"];
}
