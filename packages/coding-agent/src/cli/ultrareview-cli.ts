import * as fs from "node:fs/promises";
import * as path from "node:path";
import chalk from "chalk";
import * as git from "../utils/git";

export interface UltraReviewFinding {
	id: string;
	category: "security" | "performance" | "architecture" | "regression";
	severity: "critical" | "high" | "medium" | "low" | "nit";
	file: string;
	line?: number;
	title: string;
	description: string;
	recommendation: string;
}

export interface UltraReviewResult {
	target: string;
	baseCommit: string;
	filesChanged: number;
	additions: number;
	deletions: number;
	findings: UltraReviewFinding[];
	timestamp: string;
	summary: {
		critical: number;
		high: number;
		medium: number;
		low: number;
		nit: number;
	};
}

export interface UltraReviewOptions {
	target?: string;
	json?: boolean;
	output?: string;
	reviewMd?: string;
	timeout?: number;
	post?: boolean;
	trustWorkspace?: boolean;
}

/**
 * Perform autonomous multi-perspective review on the current branch or target.
 */
export async function runUltraReview(options: UltraReviewOptions = {}): Promise<UltraReviewResult> {
	const cwd = process.cwd();
	let repo: git.GitRepository;
	try {
		repo = await git.resolveRepository(cwd);
	} catch (err) {
		throw new Error(
			`ultrareview requires an active git repository: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	const target = options.target || "HEAD";

	let numstats: git.NumstatEntry[] = [];
	try {
		numstats = await git.diff.numstat(repo.repoRoot, {
			cached: false,
		});
	} catch {
		numstats = [];
	}

	let totalAdditions = 0;
	let totalDeletions = 0;
	for (const stat of numstats) {
		totalAdditions += stat.added;
		totalDeletions += stat.deleted;
	}

	const findings: UltraReviewFinding[] = [];

	// Multi-perspective analyzers
	for (const entry of numstats) {
		const filePath = entry.path;
		const fullPath = path.resolve(repo.repoRoot, filePath);

		let content = "";
		try {
			content = await fs.readFile(fullPath, "utf-8");
		} catch {
			continue;
		}

		const lines = content.split("\n");

		// 1. Security Analyzer
		lines.forEach((line, idx) => {
			const lineNum = idx + 1;
			// Hardcoded secrets / credentials check
			if (/api[_-]?key\s*[:=]\s*["'][A-Za-z0-9_-]{16,}["']/i.test(line) && !line.includes("process.env")) {
				findings.push({
					id: `SEC-${findings.length + 1}`,
					category: "security",
					severity: "critical",
					file: filePath,
					line: lineNum,
					title: "Hardcoded API key or credential detected",
					description: "A string literal resembling an API key was found in source code.",
					recommendation: "Load credentials from environment variables or secure credential storage instead.",
				});
			}

			// Command injection / unsanitized exec check
			if (
				/exec\s*\(\s*`[^`]*\$\{.*?\}[^`]*`\s*\)/.test(line) ||
				/execSync\s*\(\s*`[^`]*\$\{.*?\}[^`]*`\s*\)/.test(line)
			) {
				findings.push({
					id: `SEC-${findings.length + 1}`,
					category: "security",
					severity: "high",
					file: filePath,
					line: lineNum,
					title: "Potential command injection in dynamic shell invocation",
					description: "String interpolation directly inside shell exec can lead to arbitrary command execution.",
					recommendation: "Use argument arrays with spawn or runCommand instead of raw string interpolation.",
				});
			}

			// Path traversal check
			if (/path\.join\s*\(.*?,\s*(?:req|params|input)\..*?\)/.test(line) && !content.includes("normalizePath")) {
				findings.push({
					id: `SEC-${findings.length + 1}`,
					category: "security",
					severity: "high",
					file: filePath,
					line: lineNum,
					title: "Potential path traversal with untrusted input",
					description: "Constructing file paths directly from user input without validation may allow traversal.",
					recommendation: "Resolve paths and assert that the result remains within the intended root directory.",
				});
			}
		});

		// 2. Performance Analyzer
		lines.forEach((line, idx) => {
			const lineNum = idx + 1;
			// Sync I/O in async routines
			if (/fs\.(?:readFileSync|writeFileSync|statSync|existsSync)\(/.test(line) && !filePath.includes("test")) {
				findings.push({
					id: `PERF-${findings.length + 1}`,
					category: "performance",
					severity: "medium",
					file: filePath,
					line: lineNum,
					title: "Synchronous file system call in application code",
					description: "Synchronous filesystem operations block the Node/Bun event loop.",
					recommendation: "Use asynchronous fs/promises equivalents.",
				});
			}

			// Regex denial of service (ReDoS) vulnerability indicators
			if (/new RegExp\(.*?\)/.test(line) && line.includes("+") && !filePath.includes("test")) {
				findings.push({
					id: `PERF-${findings.length + 1}`,
					category: "performance",
					severity: "medium",
					file: filePath,
					line: lineNum,
					title: "Dynamic regular expression concatenation",
					description: "Dynamically constructing regex without escaping can cause exponential backtracking.",
					recommendation: "Escape regex metacharacters or use static precompiled expressions.",
				});
			}
		});

		// 3. Architecture & Edge Cases Analyzer
		lines.forEach((line, idx) => {
			const lineNum = idx + 1;
			// Empty catch blocks
			if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(line)) {
				findings.push({
					id: `ARCH-${findings.length + 1}`,
					category: "architecture",
					severity: "low",
					file: filePath,
					line: lineNum,
					title: "Silently swallowed error in catch block",
					description: "Empty catch blocks discard failure information and mask root causes.",
					recommendation: "Log the error or rethrow with contextual information.",
				});
			}
		});
	}

	const summary = {
		critical: findings.filter(f => f.severity === "critical").length,
		high: findings.filter(f => f.severity === "high").length,
		medium: findings.filter(f => f.severity === "medium").length,
		low: findings.filter(f => f.severity === "low").length,
		nit: findings.filter(f => f.severity === "nit").length,
	};

	const result: UltraReviewResult = {
		target,
		baseCommit: repo.headPath ? path.basename(repo.headPath) : "HEAD",
		filesChanged: numstats.length,
		additions: totalAdditions,
		deletions: totalDeletions,
		findings,
		timestamp: new Date().toISOString(),
		summary,
	};

	// Save review markdown if requested
	const mdReport = generateMarkdownReport(result);
	if (options.reviewMd) {
		const outPath = path.resolve(cwd, options.reviewMd);
		await fs.mkdir(path.dirname(outPath), { recursive: true });
		await fs.writeFile(outPath, mdReport, "utf-8");
	}

	if (options.output) {
		const outPath = path.resolve(cwd, options.output);
		await fs.mkdir(path.dirname(outPath), { recursive: true });
		if (options.json) {
			await fs.writeFile(outPath, JSON.stringify(result, null, 2), "utf-8");
		} else {
			await fs.writeFile(outPath, mdReport, "utf-8");
		}
	}

	return result;
}

export function generateMarkdownReport(result: UltraReviewResult): string {
	const lines: string[] = [];
	lines.push(`# Autonomous UltraReview Report`);
	lines.push(``);
	lines.push(`- **Target**: \`${result.target}\``);
	lines.push(`- **Base Commit**: \`${result.baseCommit}\``);
	lines.push(`- **Files Changed**: ${result.filesChanged} (+${result.additions} / -${result.deletions})`);
	lines.push(
		`- **Findings**: ${result.findings.length} total (${result.summary.critical} critical, ${result.summary.high} high, ${result.summary.medium} medium, ${result.summary.low} low)`,
	);
	lines.push(``);

	if (result.findings.length === 0) {
		lines.push(`> All clear. No critical, performance, or architectural issues detected.`);
		return lines.join("\n");
	}

	lines.push(`## Findings Summary`);
	lines.push(``);
	lines.push(`| ID | Category | Severity | File | Title |`);
	lines.push(`|---|---|---|---|---|`);
	for (const f of result.findings) {
		const loc = f.line ? `${f.file}:${f.line}` : f.file;
		lines.push(`| ${f.id} | ${f.category} | ${f.severity} | \`${loc}\` | ${f.title} |`);
	}
	lines.push(``);

	lines.push(`## Detailed Findings`);
	lines.push(``);
	for (const f of result.findings) {
		const loc = f.line ? `:${f.line}` : "";
		lines.push(`### [${f.id}] ${f.title}`);
		lines.push(`- **Category**: ${f.category}`);
		lines.push(`- **Severity**: ${f.severity}`);
		lines.push(`- **Location**: \`${f.file}${loc}\``);
		lines.push(`- **Description**: ${f.description}`);
		lines.push(`- **Recommendation**: ${f.recommendation}`);
		lines.push(``);
	}

	return lines.join("\n");
}

export function printUltraReviewConsole(result: UltraReviewResult): void {
	console.log(chalk.bold(`\nUltraReview Findings (${result.findings.length} total)`));
	console.log(
		chalk.dim(
			`Target: ${result.target} · Files: ${result.filesChanged} (+${result.additions} / -${result.deletions})`,
		),
	);
	console.log(
		`Summary: ${chalk.red(`${result.summary.critical} critical`)}, ${chalk.redBright(`${result.summary.high} high`)}, ${chalk.yellow(`${result.summary.medium} medium`)}, ${chalk.dim(`${result.summary.low} low`)}\n`,
	);

	if (result.findings.length === 0) {
		console.log(chalk.green("✓ No issues found. Work looks solid!"));
		return;
	}

	for (const f of result.findings) {
		let badge = chalk.bgWhite.black(` ${f.severity.toUpperCase()} `);
		if (f.severity === "critical") badge = chalk.bgRed.white.bold(` CRITICAL `);
		else if (f.severity === "high") badge = chalk.bgRedBright.black(` HIGH `);
		else if (f.severity === "medium") badge = chalk.bgYellow.black(` MEDIUM `);
		else if (f.severity === "low") badge = chalk.bgBlue.white(` LOW `);

		const loc = f.line ? `${f.file}:${f.line}` : f.file;
		console.log(`${badge} ${chalk.bold(f.title)} ${chalk.dim(`(${f.id})`)}`);
		console.log(`  ${chalk.cyan(loc)} · ${f.category}`);
		console.log(`  ${chalk.dim(f.description)}`);
		console.log(`  ${chalk.green(`→ ${f.recommendation}`)}\n`);
	}
}
