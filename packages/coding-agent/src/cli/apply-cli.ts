import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as Diff from "diff";
import { loadEntriesFromFile, SessionManager } from "../session/session-manager";

export interface FilePatch {
	filePath: string;
	relativePath: string;
	oldContent: string;
	newContent: string;
	diff: string;
	insertions: number;
	deletions: number;
}

export interface ApplyResult {
	sessionFile: string;
	sessionId?: string;
	dryRun: boolean;
	patches: FilePatch[];
	totalInsertions: number;
	totalDeletions: number;
}

/**
 * Locate target session file either by explicit path, prefix search, or latest session.
 */
export async function resolveSessionFile(target?: string, last?: boolean, cwd = process.cwd()): Promise<string> {
	if (target && fsSync.existsSync(target)) {
		return path.resolve(cwd, target);
	}

	const sessions = await SessionManager.list(cwd);
	const allSessions = sessions.length > 0 ? sessions : await SessionManager.listAll();

	if (target) {
		const matched = allSessions.find(s => s.id.startsWith(target) || path.basename(s.path).startsWith(target));
		if (matched) return matched.path;
		throw new Error(`No session found matching identifier "${target}".`);
	}

	if (last || allSessions.length > 0) {
		const latest = allSessions[0];
		if (latest) return latest.path;
	}

	throw new Error("No session found. Run a session first or specify a session file.");
}

interface NormalizedToolCall {
	name: string;
	args: Record<string, any>;
}

function extractToolCallsFromEntry(entry: any): NormalizedToolCall[] {
	const calls: NormalizedToolCall[] = [];

	if (entry.type === "message" && entry.message) {
		const msg = entry.message;
		if (Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "toolCall" || block.type === "tool_call" || block.type === "tool_use") {
					calls.push({
						name: block.name,
						args: block.arguments ?? block.input ?? {},
					});
				}
			}
		}
	} else if (entry.type === "tool_call" || entry.type === "toolCall") {
		calls.push({
			name: entry.name,
			args: entry.arguments ?? entry.input ?? {},
		});
	}

	return calls;
}

/**
 * Extract simulated file states from session tool invocations.
 */
export async function extractSessionPatches(sessionFile: string, baseDir = process.cwd()): Promise<FilePatch[]> {
	const entries = await loadEntriesFromFile(sessionFile);
	const fileState = new Map<string, { original: string; current: string }>();

	for (const entry of entries) {
		const calls = extractToolCallsFromEntry(entry);
		for (const call of calls) {
			const name = call.name.toLowerCase();
			const args = call.args;

			const rawPath = args.Path ?? args.path ?? args.file_path ?? args.filePath;
			if (!rawPath || typeof rawPath !== "string") continue;

			const fullPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(baseDir, rawPath);

			if (!fileState.has(fullPath)) {
				let diskContent = "";
				try {
					diskContent = await fs.readFile(fullPath, "utf8");
				} catch {
					diskContent = "";
				}
				fileState.set(fullPath, { original: diskContent, current: diskContent });
			}

			const state = fileState.get(fullPath)!;

			if (name === "write_file" || name === "write") {
				const content = String(args.Content ?? args.content ?? "");
				const append = Boolean(args.Append ?? args.append);
				if (append) {
					state.current += content;
				} else {
					state.current = content;
				}
			} else if (name === "edit_file" || name === "edit") {
				const target = args.Target ?? args.target;
				const replacement = String(args.Replacement ?? args.replacement ?? "");

				if (typeof target === "string" && target.length > 0) {
					state.current = state.current.replaceAll(target, replacement);
				} else if (Array.isArray(args.edits)) {
					for (const edit of args.edits) {
						if (typeof edit.target === "string" && edit.target.length > 0) {
							state.current = state.current.replaceAll(edit.target, String(edit.replacement ?? ""));
						}
					}
				}
			}
		}
	}

	const patches: FilePatch[] = [];

	for (const [filePath, state] of fileState.entries()) {
		if (state.original === state.current) continue;

		const rel = path.relative(baseDir, filePath);
		const patchDiff = Diff.createTwoFilesPatch(rel, rel, state.original, state.current, "", "");

		let insertions = 0;
		let deletions = 0;
		for (const line of patchDiff.split("\n")) {
			if (line.startsWith("+") && !line.startsWith("+++")) insertions++;
			else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
		}

		patches.push({
			filePath,
			relativePath: rel,
			oldContent: state.original,
			newContent: state.current,
			diff: patchDiff,
			insertions,
			deletions,
		});
	}

	return patches;
}

export async function runApplyCommand(options: {
	target?: string;
	last?: boolean;
	dryRun?: boolean;
	cwd?: string;
	stdout?: (msg: string) => void;
}): Promise<ApplyResult> {
	const cwd = options.cwd ?? process.cwd();
	const out = options.stdout ?? ((msg: string) => process.stdout.write(`${msg}\n`));
	const sessionFile = await resolveSessionFile(options.target, options.last, cwd);
	const patches = await extractSessionPatches(sessionFile, cwd);

	let totalInsertions = 0;
	let totalDeletions = 0;
	for (const p of patches) {
		totalInsertions += p.insertions;
		totalDeletions += p.deletions;
	}

	const isDry = Boolean(options.dryRun);

	if (patches.length === 0) {
		out("No file changes detected in session to apply.");
		return {
			sessionFile,
			dryRun: isDry,
			patches: [],
			totalInsertions: 0,
			totalDeletions: 0,
		};
	}

	if (isDry) {
		out(`[dry-run] Changes from session ${path.basename(sessionFile)}:`);
		for (const p of patches) {
			out(p.diff);
		}
		out(`[dry-run] Summary: ${patches.length} file(s) would be modified (+${totalInsertions}, -${totalDeletions}).`);
		return {
			sessionFile,
			dryRun: true,
			patches,
			totalInsertions,
			totalDeletions,
		};
	}

	for (const p of patches) {
		await fs.mkdir(path.dirname(p.filePath), { recursive: true });
		await fs.writeFile(p.filePath, p.newContent, "utf8");
		out(`Applied: ${p.relativePath} (+${p.insertions}, -${p.deletions})`);
	}

	out(`Successfully applied ${patches.length} file(s) (+${totalInsertions}, -${totalDeletions}).`);

	return {
		sessionFile,
		dryRun: false,
		patches,
		totalInsertions,
		totalDeletions,
	};
}
