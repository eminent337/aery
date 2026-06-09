/**
 * TUI polish utilities for tool rendering.
 *
 * Provides:
 * - Nerd Font-style file type icons (deterministic, no external font dependency)
 * - Branch connectors (│ ├ └) for nested tool call trees
 */

const FILE_ICONS: Record<string, string> = {
	ts: "󰛦",
	sx: "󰛦",
	js: "󰌞",
	jsx: "󰌞",
	tsx: "󰌞",
	py: "󰌠",
	rs: "󱘗",
	go: "󰟓",
	html: "󰌝",
	css: "󰌜",
	scss: "󰌜",
	json: "󰘦",
	yaml: "󰘦",
	yml: "󰘦",
	md: "󰍔",
	sql: "󰆼",
	sh: "󰲋",
	bash: "󰲋",
	zsh: "󰲋",
	fish: "󰲋",
	gitignore: "󰊢",
	lock: "󰒓",
	dockerfile: "󰡨",
	toml: "󰄛",
	xml: "󰗀",
};

export function fileTypeIcon(filename: string): string {
	const ext = filename.split(".").pop()?.toLowerCase();
	if (!ext) return "󰈙"; // generic file
	return FILE_ICONS[ext] ?? "󰈙";
}

export function fmtFileHeader(filename: string): string {
	return `${fileTypeIcon(filename)} ${filename}`;
}

export interface BranchLine {
	depth: number;
	isLast: boolean;
}

export function branchConnector(lines: BranchLine[]): string {
	if (lines.length === 0) return "";
	return lines.map(l => (l.isLast ? "  " : "│ ")).join("") + (lines[lines.length - 1]?.isLast ? "└─" : "├─");
}

export function fmtToolHeader(toolName: string, args: Record<string, unknown>, branches?: BranchLine[]): string {
	// If args contain a file path, decorate with icon
	const fileArg = args.file ?? args.path ?? args.filename;
	const filePrefix = typeof fileArg === "string" ? `${fileTypeIcon(fileArg)} ` : "";
	const branch = branches ? `${branchConnector(branches)} ` : "";
	return `${branch}${filePrefix}${toolName}`;
}
