import { appendProjectMemory, loadProjectMemory } from "../memory/project-memory";
import { commandConsumed, usage } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

export const worktreeCommand: SlashCommandSpec = {
	name: "worktree",
	description: "Manage agent git worktrees (~/.aery/wt)",
	subcommands: [
		{ name: "list", description: "List active agent worktrees" },
		{ name: "clear", description: "Clean up orphaned worktrees" },
	],
	allowArgs: true,
	handle: async (command, runtime) => {
		const args = command.args.trim().split(/\s+/).filter(Boolean);
		const action = args[0] || "list";

		const { listWorktrees, clearWorktrees } = await import("../cli/worktree-cli");

		if (action === "clear") {
			await clearWorktrees({ all: args.includes("--all"), dryRun: args.includes("--dry-run"), json: false });
		} else {
			await listWorktrees({ json: false });
		}
		return commandConsumed();
	},
	handleTui: async (command, runtime) => {
		const args = command.args.trim().split(/\s+/).filter(Boolean);
		const action = args[0] || "list";

		const { listWorktrees, clearWorktrees } = await import("../cli/worktree-cli");

		if (action === "clear") {
			await clearWorktrees({ all: args.includes("--all"), dryRun: args.includes("--dry-run"), json: false });
			runtime.ctx.showStatus("Worktree cleanup completed.");
		} else {
			await listWorktrees({ json: false });
		}
		runtime.ctx.editor.setText("");
		return commandConsumed();
	},
};

export const ultrareviewCommand: SlashCommandSpec = {
	name: "ultrareview",
	description: "Run autonomous multi-perspective review on current branch or target",
	inlineHint: "[target]",
	allowArgs: true,
	handle: async (command, runtime) => {
		const target = command.args.trim() || undefined;
		const { runUltraReview, printUltraReviewConsole } = await import("../cli/ultrareview-cli");
		try {
			const result = await runUltraReview({ target });
			printUltraReviewConsole(result);
		} catch (err) {
			await runtime.output(`UltraReview failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		return commandConsumed();
	},
	handleTui: async (command, runtime) => {
		const target = command.args.trim() || undefined;
		const { runUltraReview, printUltraReviewConsole } = await import("../cli/ultrareview-cli");
		runtime.ctx.showStatus(`Running UltraReview against ${target || "HEAD"}...`);
		try {
			const result = await runUltraReview({ target });
			printUltraReviewConsole(result);
			runtime.ctx.showStatus(`UltraReview complete: ${result.findings.length} findings.`);
		} catch (err) {
			runtime.ctx.showStatus(`UltraReview failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		runtime.ctx.editor.setText("");
		return commandConsumed();
	},
};

export const ultraplanCommand: SlashCommandSpec = {
	name: "ultraplan",
	description: "Enter plan mode for deep exploration and architectural design",
	inlineHint: "[focus]",
	allowArgs: true,
	handle: async (command, runtime) => {
		const focus = command.args.trim();
		const prompt = focus
			? `Please enter plan mode and formulate a comprehensive implementation plan for: ${focus}`
			: `Please enter plan mode and formulate an implementation plan for the current task.`;
		return { prompt };
	},
	handleTui: async (command, runtime) => {
		const focus = command.args.trim();
		const prompt = focus
			? `Please enter plan mode and formulate a comprehensive implementation plan for: ${focus}`
			: `Please enter plan mode and formulate an implementation plan for the current task.`;
		runtime.ctx.editor.setText("");
		return { prompt };
	},
};

export const importCommand: SlashCommandSpec = {
	name: "import",
	description: "Import config, rules, and MCP servers from Cursor, Claude, Codex, Gemini",
	subcommands: [
		{ name: "all", description: "Import all discovered agent configs (default)" },
		{ name: "claude", description: "Import CLAUDE.md and .claude/mcp.json" },
		{ name: "cursor", description: "Import .cursorrules" },
		{ name: "codex", description: "Import codex.md" },
		{ name: "gemini", description: "Import GEMINI.md" },
	],
	allowArgs: true,
	handle: async (command, runtime) => {
		const args = command.args.trim().split(/\s+/).filter(Boolean);
		const source = args[0] || "all";
		const dryRun = args.includes("--dry-run");

		const { runImport, printImportConsole } = await import("../cli/import-cli");
		const result = await runImport({ source, dryRun });
		printImportConsole(result);
		return commandConsumed();
	},
	handleTui: async (command, runtime) => {
		const args = command.args.trim().split(/\s+/).filter(Boolean);
		const source = args[0] || "all";
		const dryRun = args.includes("--dry-run");

		const { runImport, printImportConsole } = await import("../cli/import-cli");
		const result = await runImport({ source, dryRun });
		printImportConsole(result);
		runtime.ctx.showStatus(`Imported ${result.importedCount} items (${source}).`);
		runtime.ctx.editor.setText("");
		return commandConsumed();
	},
};

export const memoryCommand: SlashCommandSpec = {
	name: "memory",
	description: "View and manage project persistent memory (MEMORY.md)",
	subcommands: [
		{ name: "show", description: "Display currently stored facts in MEMORY.md" },
		{ name: "add", description: "Add a persistent fact to MEMORY.md", usage: "<fact>" },
	],
	allowArgs: true,
	handle: async (command, runtime) => {
		const args = command.args.trim().split(/\s+/);
		const action = args[0] || "show";

		if (action === "add") {
			const fact = args.slice(1).join(" ").trim();
			if (!fact) return usage("Usage: /memory add <fact text>", runtime);
			const saved = await appendProjectMemory(fact, runtime.cwd);
			await runtime.output(`Saved fact to project memory (${saved}): ${fact}`);
			return commandConsumed();
		}

		const mem = await loadProjectMemory(runtime.cwd);
		if (!mem || mem.facts.length === 0) {
			await runtime.output("No persistent project memory recorded yet in MEMORY.md.");
			return commandConsumed();
		}

		await runtime.output(`Project Memory (${mem.filePath}):\n${mem.content}`);
		return commandConsumed();
	},
	handleTui: async (command, runtime) => {
		const args = command.args.trim().split(/\s+/);
		const action = args[0] || "show";

		if (action === "add") {
			const fact = args.slice(1).join(" ").trim();
			if (!fact) {
				runtime.ctx.showStatus("Usage: /memory add <fact text>");
				return commandConsumed();
			}
			const saved = await appendProjectMemory(fact, runtime.ctx.sessionManager.getCwd());
			runtime.ctx.showStatus(`Added fact to project memory (${saved}).`);
			runtime.ctx.editor.setText("");
			return commandConsumed();
		}

		const mem = await loadProjectMemory(runtime.ctx.sessionManager.getCwd());
		if (!mem || mem.facts.length === 0) {
			runtime.ctx.showStatus("No persistent project memory recorded yet in MEMORY.md.");
		} else {
			console.log(`\nProject Memory (${mem.filePath}):\n${mem.content}\n`);
			runtime.ctx.showStatus(`Loaded ${mem.facts.length} facts from ${mem.filePath}.`);
		}
		runtime.ctx.editor.setText("");
		return commandConsumed();
	},
};
