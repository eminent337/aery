/**
 * Context @ Mentions Resolver.
 *
 * Implements Google Antigravity-style @ mentions context resolution.
 * Automatically resolves and attaches referenced files, directory trees,
 * rules, and agents directly to the model's prompt payload.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { AgentRegistry } from "../registry/agent-registry";
import type { ExpandedPromptResult, ResolvedMention } from "./types";

export class MentionResolver {
	private static instance?: MentionResolver;

	public static getInstance(): MentionResolver {
		if (!MentionResolver.instance) {
			MentionResolver.instance = new MentionResolver();
		}
		return MentionResolver.instance;
	}

	/**
	 * Resolves all @ mentions found in the user prompt and returns an expanded prompt.
	 */
	public async resolveMentions(prompt: string, cwd = process.cwd()): Promise<ExpandedPromptResult> {
		if (!prompt || !prompt.includes("@")) {
			return {
				originalPrompt: prompt,
				expandedPrompt: prompt,
				mentions: [],
			};
		}

		const mentionTokens = this.extractMentionTokens(prompt);
		if (mentionTokens.length === 0) {
			return {
				originalPrompt: prompt,
				expandedPrompt: prompt,
				mentions: [],
			};
		}

		const resolvedList: ResolvedMention[] = [];

		for (const token of mentionTokens) {
			const resolved = await this.resolveToken(token, cwd);
			if (resolved) {
				resolvedList.push(resolved);
			}
		}

		if (resolvedList.length === 0) {
			return {
				originalPrompt: prompt,
				expandedPrompt: prompt,
				mentions: [],
			};
		}

		// Build formatted context blocks to append
		const contextBlocks: string[] = [];
		for (const m of resolvedList) {
			if (m.error) {
				contextBlocks.push(`<!-- [Mention ${m.rawToken} Failed: ${m.error}] -->`);
			} else {
				contextBlocks.push(m.content);
			}
		}

		const expandedPrompt = `${prompt.trim()}\n\n---\n### Attached Context (@ Mentions)\n${contextBlocks.join("\n\n")}`;

		return {
			originalPrompt: prompt,
			expandedPrompt,
			mentions: resolvedList,
		};
	}

	private extractMentionTokens(prompt: string): string[] {
		// Matches:
		// 1) Explicit prefixes: @file:path, @dir:path, @rule:name, @terminal:id, @agent:id
		// 2) File paths with extensions: @path/to/file.ext
		const regex =
			/@(file:[\w\-./\\]+|dir:[\w\-./\\]+|rule:[\w-]+|terminal:[\w-]+|agent:[\w-]+|[\w\-./\\]+\.[a-zA-Z0-9]{1,10})/g;
		const matches = prompt.match(regex);
		if (!matches) return [];
		return Array.from(new Set(matches.map(m => m.replace(/[.,;:!?]+$/, ""))));
	}

	private async resolveToken(rawToken: string, cwd: string): Promise<ResolvedMention | null> {
		const token = rawToken.slice(1); // remove leading '@'

		if (token.startsWith("file:")) {
			const filePath = token.slice("file:".length);
			return this.resolveFileMention(rawToken, filePath, cwd);
		}

		if (token.startsWith("dir:")) {
			const dirPath = token.slice("dir:".length);
			return this.resolveDirMention(rawToken, dirPath, cwd);
		}

		if (token.startsWith("rule:")) {
			const ruleName = token.slice("rule:".length);
			return this.resolveRuleMention(rawToken, ruleName, cwd);
		}

		if (token.startsWith("agent:")) {
			const agentId = token.slice("agent:".length);
			return this.resolveAgentMention(rawToken, agentId);
		}

		// Implicit file mention e.g. @package.json or @src/index.ts
		if (token.includes(".")) {
			return this.resolveFileMention(rawToken, token, cwd);
		}

		return null;
	}

	private async resolveFileMention(rawToken: string, relPath: string, cwd: string): Promise<ResolvedMention> {
		const absPath = path.isAbsolute(relPath) ? relPath : path.resolve(cwd, relPath);

		if (!fs.existsSync(absPath)) {
			return {
				rawToken,
				type: "file",
				identifier: relPath,
				content: "",
				error: `File not found at ${relPath}`,
			};
		}

		try {
			const stat = await fs.promises.stat(absPath);
			if (stat.isDirectory()) {
				return this.resolveDirMention(rawToken, relPath, cwd);
			}

			const content = await fs.promises.readFile(absPath, "utf-8");
			const ext = path.extname(absPath).slice(1) || "text";
			const snippet = content.length > 30000 ? `${content.slice(0, 30000)}\n...[truncated]` : content;

			return {
				rawToken,
				type: "file",
				identifier: relPath,
				resolvedPath: absPath,
				content: `#### [File: ${relPath}]\n\`\`\`${ext}\n${snippet}\n\`\`\``,
			};
		} catch (err) {
			return {
				rawToken,
				type: "file",
				identifier: relPath,
				content: "",
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	private async resolveDirMention(rawToken: string, relPath: string, cwd: string): Promise<ResolvedMention> {
		const absPath = path.isAbsolute(relPath) ? relPath : path.resolve(cwd, relPath);

		if (!fs.existsSync(absPath)) {
			return {
				rawToken,
				type: "dir",
				identifier: relPath,
				content: "",
				error: `Directory not found at ${relPath}`,
			};
		}

		try {
			const entries = await fs.promises.readdir(absPath, { withFileTypes: true });
			const listing = entries
				.slice(0, 50)
				.map(e => `${e.isDirectory() ? "📁 " : "📄 "}${e.name}`)
				.join("\n");

			return {
				rawToken,
				type: "dir",
				identifier: relPath,
				resolvedPath: absPath,
				content: `#### [Directory: ${relPath}]\n\`\`\`text\n${listing}\n\`\`\``,
			};
		} catch (err) {
			return {
				rawToken,
				type: "dir",
				identifier: relPath,
				content: "",
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	private async resolveRuleMention(rawToken: string, ruleName: string, cwd: string): Promise<ResolvedMention> {
		const candidates = [
			path.resolve(cwd, ".agents", "rules", `${ruleName}.md`),
			path.resolve(cwd, ".agents", "rules", ruleName),
			path.resolve(cwd, "rules", `${ruleName}.md`),
		];

		for (const cand of candidates) {
			if (fs.existsSync(cand)) {
				try {
					const content = await fs.promises.readFile(cand, "utf-8");
					return {
						rawToken,
						type: "rule",
						identifier: ruleName,
						resolvedPath: cand,
						content: `#### [Rule: ${ruleName}]\n${content.trim()}`,
					};
				} catch {}
			}
		}

		return {
			rawToken,
			type: "rule",
			identifier: ruleName,
			content: "",
			error: `Rule '${ruleName}' not found in .agents/rules/`,
		};
	}

	private async resolveAgentMention(rawToken: string, agentId: string): Promise<ResolvedMention> {
		const registry = AgentRegistry.global();
		const info = registry.get(agentId);

		if (!info) {
			return {
				rawToken,
				type: "agent",
				identifier: agentId,
				content: "",
				error: `Agent '${agentId}' not found in active registry`,
			};
		}

		return {
			rawToken,
			type: "agent",
			identifier: agentId,
			content: `#### [Agent Context: ${info.id}]\n- **Name:** ${info.displayName}\n- **Kind:** ${info.kind}\n- **Status:** ${info.status}`,
		};
	}
}
