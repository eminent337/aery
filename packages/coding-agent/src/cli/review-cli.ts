import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ReviewVerdict = "APPROVE" | "CHANGES_REQUESTED" | "COMMENT";

export interface ReviewFindingRecord {
	title: string;
	body: string;
	priority: "P0" | "P1" | "P2" | "P3";
	filePath: string;
	lineStart: number;
	lineEnd: number;
}

export interface ReviewReport {
	title: string;
	target: string;
	verdict: ReviewVerdict;
	summary: string;
	findings: ReviewFindingRecord[];
	stats: {
		filesChanged: number;
		insertions: number;
		deletions: number;
	};
}

export interface ReviewOptions {
	prompt?: string;
	uncommitted?: boolean;
	base?: string;
	commit?: string;
	json?: boolean;
	title?: string;
	cwd?: string;
	stdout?: (text: string) => void;
}

async function runGit(args: string[], cwd: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
		return stdout;
	} catch (err: any) {
		if (err.stdout && typeof err.stdout === "string") return err.stdout;
		throw new Error(`Git error (git ${args.join(" ")}): ${err.message || String(err)}`);
	}
}

export async function extractReviewDiff(options: {
	uncommitted?: boolean;
	base?: string;
	commit?: string;
	cwd?: string;
}): Promise<{ diff: string; target: string }> {
	const cwd = options.cwd ?? process.cwd();

	if (options.commit) {
		const diff = await runGit(["show", options.commit], cwd);
		return { diff, target: `commit:${options.commit}` };
	}

	if (options.base) {
		const diff = await runGit(["diff", `${options.base}...HEAD`], cwd);
		return { diff, target: `base:${options.base}` };
	}

	// Default: uncommitted changes (both staged and unstaged)
	let diff = await runGit(["diff", "HEAD"], cwd);
	if (!diff.trim()) {
		// If HEAD diff is empty, check working tree diff
		diff = await runGit(["diff"], cwd);
	}

	return { diff, target: "uncommitted" };
}

export function parseDiffStats(diffText: string): {
	filesChanged: number;
	insertions: number;
	deletions: number;
	files: string[];
} {
	const filesSet = new Set<string>();
	let insertions = 0;
	let deletions = 0;

	for (const line of diffText.split("\n")) {
		if (line.startsWith("diff --git ")) {
			const parts = line.split(" ");
			if (parts.length >= 4) {
				const bPath = parts[3].replace(/^b\//, "");
				filesSet.add(bPath);
			}
		} else if (line.startsWith("+") && !line.startsWith("+++")) {
			insertions++;
		} else if (line.startsWith("-") && !line.startsWith("---")) {
			deletions++;
		}
	}

	return {
		filesChanged: filesSet.size,
		insertions,
		deletions,
		files: Array.from(filesSet),
	};
}

export function analyzeDiffContent(diffText: string, customPrompt?: string): ReviewFindingRecord[] {
	const findings: ReviewFindingRecord[] = [];
	const lines = diffText.split("\n");

	let currentFile = "unknown";
	let currentLine = 1;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (line.startsWith("diff --git ")) {
			const parts = line.split(" ");
			if (parts.length >= 4) {
				currentFile = parts[3].replace(/^b\//, "");
			}
			currentLine = 1;
			continue;
		}

		if (line.startsWith("@@ ")) {
			const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
			if (match) {
				currentLine = parseInt(match[1], 10);
			}
			continue;
		}

		if (line.startsWith("+") && !line.startsWith("+++")) {
			const addedContent = line.slice(1);

			// Secret detection
			if (/(?:api_key|secret_key|private_key|auth_token)\s*=\s*['"][a-zA-Z0-9_-]{16,}['"]/i.test(addedContent)) {
				findings.push({
					title: "Hardcoded secret detected",
					body: "Appears to contain hardcoded API credential or secret token. Use environment variables or secure vault.",
					priority: "P0",
					filePath: currentFile,
					lineStart: currentLine,
					lineEnd: currentLine,
				});
			}

			// Leftover debugger / inspection calls
			if (/\bdebugger\b/.test(addedContent)) {
				findings.push({
					title: "Debugger statement in code",
					body: "Remove debugger statement before committing.",
					priority: "P1",
					filePath: currentFile,
					lineStart: currentLine,
					lineEnd: currentLine,
				});
			}

			// Leftover console.log
			if (/\bconsole\.log\(/.test(addedContent) && !currentFile.includes("test")) {
				findings.push({
					title: "Console log statement in production code",
					body: "Consider using structured logger or removing debugging log statement.",
					priority: "P2",
					filePath: currentFile,
					lineStart: currentLine,
					lineEnd: currentLine,
				});
			}

			// Unaddressed FIXMEs
			if (/\bFIXME\b/i.test(addedContent)) {
				findings.push({
					title: "Unresolved FIXME marker",
					body: "Address or track FIXME before finalizing change.",
					priority: "P2",
					filePath: currentFile,
					lineStart: currentLine,
					lineEnd: currentLine,
				});
			}

			currentLine++;
		} else if (!line.startsWith("-")) {
			currentLine++;
		}
	}

	return findings;
}

export async function runReviewCommand(options: ReviewOptions): Promise<ReviewReport> {
	const cwd = options.cwd ?? process.cwd();
	const out = options.stdout ?? ((msg: string) => process.stdout.write(`${msg}\n`));

	const { diff, target } = await extractReviewDiff({
		uncommitted: options.uncommitted,
		base: options.base,
		commit: options.commit,
		cwd,
	});

	const stats = parseDiffStats(diff);
	const title = options.title ?? `Review for ${target}`;

	if (!diff.trim() || stats.filesChanged === 0) {
		const emptyReport: ReviewReport = {
			title,
			target,
			verdict: "APPROVE",
			summary: "No changes detected to review.",
			findings: [],
			stats: { filesChanged: 0, insertions: 0, deletions: 0 },
		};

		if (options.json) {
			out(JSON.stringify(emptyReport, null, 2));
		} else {
			out(`Verdict: APPROVE`);
			out(`Summary: No changes detected to review.`);
		}
		return emptyReport;
	}

	const findings = analyzeDiffContent(diff, options.prompt);

	let verdict: ReviewVerdict = "APPROVE";
	if (findings.some(f => f.priority === "P0" || f.priority === "P1")) {
		verdict = "CHANGES_REQUESTED";
	} else if (findings.length > 0) {
		verdict = "COMMENT";
	}

	let summary = `Analyzed ${stats.filesChanged} file(s) (+${stats.insertions}, -${stats.deletions}). `;
	if (verdict === "APPROVE") {
		summary += "No critical defects or policy violations identified.";
	} else if (verdict === "CHANGES_REQUESTED") {
		summary += `Found ${findings.length} issue(s) requiring remediation before merge.`;
	} else {
		summary += `Found ${findings.length} advisory remark(s).`;
	}

	const report: ReviewReport = {
		title,
		target,
		verdict,
		summary,
		findings,
		stats: {
			filesChanged: stats.filesChanged,
			insertions: stats.insertions,
			deletions: stats.deletions,
		},
	};

	if (options.json) {
		out(JSON.stringify(report, null, 2));
	} else {
		out(`Review: ${title}`);
		out(`Target: ${target}`);
		out(`Verdict: ${verdict}`);
		out(`Summary: ${summary}`);
		out(`Stats: ${stats.filesChanged} file(s) changed (+${stats.insertions}, -${stats.deletions})`);

		if (findings.length > 0) {
			out("\nFindings:");
			for (const f of findings) {
				out(`  [${f.priority}] ${f.title}`);
				out(`    Location: ${f.filePath}:${f.lineStart}`);
				out(`    Details:  ${f.body}`);
			}
		}
	}

	return report;
}
