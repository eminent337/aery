import * as fs from "node:fs/promises";
import * as path from "node:path";
import chalk from "chalk";

export type ImportSource = "cursor" | "claude" | "codex" | "gemini";

export interface ImportItem {
	type: "rule" | "mcp" | "instruction";
	name: string;
	sourcePath: string;
	destinationPath: string;
	contentSummary: string;
}

export interface ImportResult {
	source: string;
	foundItems: ImportItem[];
	importedCount: number;
	dryRun: boolean;
}

export interface ImportOptions {
	source?: ImportSource | string;
	dryRun?: boolean;
	targetDir?: string;
}

export async function scanForeignAgentConfigs(targetDir: string, specificSource?: string): Promise<ImportItem[]> {
	const items: ImportItem[] = [];
	const aeryRulesDir = path.join(targetDir, ".aery", "rules");
	const aeryMcpPath = path.join(targetDir, ".aery", "mcp.json");

	// 1. Cursor
	if (!specificSource || specificSource === "cursor") {
		const cursorrules = path.join(targetDir, ".cursorrules");
		try {
			const stat = await fs.stat(cursorrules);
			if (stat.isFile()) {
				items.push({
					type: "rule",
					name: "Cursor Rules",
					sourcePath: cursorrules,
					destinationPath: path.join(aeryRulesDir, "cursor-imported.md"),
					contentSummary: ".cursorrules project instructions",
				});
			}
		} catch {}

		const cursorRulesDir = path.join(targetDir, ".cursor", "rules");
		try {
			const files = await fs.readdir(cursorRulesDir);
			for (const file of files) {
				items.push({
					type: "rule",
					name: `Cursor Rule (${file})`,
					sourcePath: path.join(cursorRulesDir, file),
					destinationPath: path.join(aeryRulesDir, `cursor-${file.replace(/\.mdc$/, ".md")}`),
					contentSummary: `Cursor rule file: ${file}`,
				});
			}
		} catch {}
	}

	// 2. Claude Code
	if (!specificSource || specificSource === "claude") {
		const claudeMd = path.join(targetDir, "CLAUDE.md");
		try {
			const stat = await fs.stat(claudeMd);
			if (stat.isFile()) {
				items.push({
					type: "instruction",
					name: "Claude Code Project Guide",
					sourcePath: claudeMd,
					destinationPath: path.join(aeryRulesDir, "claude-imported.md"),
					contentSummary: "CLAUDE.md project developer guidelines",
				});
			}
		} catch {}

		const claudeMcp = path.join(targetDir, ".claude", "mcp.json");
		try {
			const stat = await fs.stat(claudeMcp);
			if (stat.isFile()) {
				items.push({
					type: "mcp",
					name: "Claude MCP Config",
					sourcePath: claudeMcp,
					destinationPath: aeryMcpPath,
					contentSummary: ".claude/mcp.json server definitions",
				});
			}
		} catch {}
	}

	// 3. Codex CLI
	if (!specificSource || specificSource === "codex") {
		const codexMd = path.join(targetDir, "codex.md");
		try {
			const stat = await fs.stat(codexMd);
			if (stat.isFile()) {
				items.push({
					type: "instruction",
					name: "Codex Project Instructions",
					sourcePath: codexMd,
					destinationPath: path.join(aeryRulesDir, "codex-imported.md"),
					contentSummary: "codex.md developer instructions",
				});
			}
		} catch {}
	}

	// 4. Gemini / AGY
	if (!specificSource || specificSource === "gemini") {
		const geminiMd = path.join(targetDir, "GEMINI.md");
		try {
			const stat = await fs.stat(geminiMd);
			if (stat.isFile()) {
				items.push({
					type: "instruction",
					name: "Gemini / AGY Guide",
					sourcePath: geminiMd,
					destinationPath: path.join(aeryRulesDir, "gemini-imported.md"),
					contentSummary: "GEMINI.md project guide",
				});
			}
		} catch {}
	}

	return items;
}

export async function runImport(options: ImportOptions = {}): Promise<ImportResult> {
	const cwd = options.targetDir || process.cwd();
	const source = options.source || "all";
	const dryRun = options.dryRun ?? false;

	const foundItems = await scanForeignAgentConfigs(cwd, options.source);
	let importedCount = 0;

	if (!dryRun) {
		for (const item of foundItems) {
			try {
				const content = await fs.readFile(item.sourcePath, "utf-8");
				await fs.mkdir(path.dirname(item.destinationPath), { recursive: true });

				if (item.type === "mcp") {
					// Merge MCP configurations
					let existingMcp: Record<string, unknown> = {};
					try {
						const existingRaw = await fs.readFile(item.destinationPath, "utf-8");
						existingMcp = JSON.parse(existingRaw);
					} catch {}

					const parsed = JSON.parse(content);
					const merged = { ...existingMcp, ...parsed };
					await fs.writeFile(item.destinationPath, JSON.stringify(merged, null, 2), "utf-8");
				} else {
					// Write rule / instruction file
					await fs.writeFile(item.destinationPath, content, "utf-8");
				}
				importedCount++;
			} catch (err) {
				console.error(
					chalk.red(`Failed to import ${item.name}: ${err instanceof Error ? err.message : String(err)}`),
				);
			}
		}
	}

	return {
		source,
		foundItems,
		importedCount: dryRun ? 0 : importedCount,
		dryRun,
	};
}

export function printImportConsole(result: ImportResult): void {
	console.log(chalk.bold(`\nAery Configuration Importer`));
	console.log(chalk.dim(`Scanning sources: ${result.source}`));

	if (result.foundItems.length === 0) {
		console.log(chalk.yellow(`No foreign agent configurations (.cursorrules, CLAUDE.md, codex.md, etc.) detected.`));
		return;
	}

	console.log(chalk.green(`Discovered ${result.foundItems.length} importable items:\n`));
	for (const item of result.foundItems) {
		const action = result.dryRun ? chalk.dim("[dry-run] would import") : chalk.green("✓ imported");
		console.log(`${action} ${chalk.bold(item.name)}`);
		console.log(`  Source: ${chalk.cyan(item.sourcePath)}`);
		console.log(`  Target: ${chalk.dim(item.destinationPath)}`);
		console.log(`  Detail: ${chalk.dim(item.contentSummary)}\n`);
	}

	if (result.dryRun) {
		console.log(chalk.dim(`Dry run complete. Run without --dry-run to apply.`));
	} else {
		console.log(chalk.green(`Successfully imported ${result.importedCount} items into Aery configuration.`));
	}
}
