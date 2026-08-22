/**
 * ACP skill commands — expose Aery skills as slash commands in ACP mode.
 *
 * Ported from kimchi's `src/modes/acp/skill-commands.ts` (c2cb469b84), adapted
 * to Aery's skill infrastructure. Discovers skills from the Aery user-skill
 * directory (~/.aery/skills) and project-local Claude Code skill directories
 * (.claude/skills), then advertises them as `skill:<name>` slash commands to
 * ACP clients. A prompt starting with `/skill:<name>` has the skill content
 * injected as a prefix so the model applies it for that turn.
 */

import { readFile } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { AvailableCommand } from "@agentclientprotocol/sdk";
import { loadAerySkills } from "../../skills/loader";
import type { Skill } from "../../extensibility/skills";
import { logger } from "@aryee337/aery-utils";

export interface AcpSkillInfo {
	readonly name: string;
	readonly description: string;
	readonly filePath: string;
}

export interface DiscoverAcpSkillCommandsOptions {
	/** Override for os.homedir(), useful for tests. Defaults to homedir(). */
	readonly homeDir?: string;
}

/**
 * Discover all skills that should be advertised as ACP slash commands for the
 * given working directory. Aery user skills and project-local Claude Code
 * skills under .claude/skills are both included; later sources override
 * earlier ones on name collisions.
 */
export async function discoverAcpSkillCommands(
	cwd: string,
	options: DiscoverAcpSkillCommandsOptions = {},
): Promise<AcpSkillInfo[]> {
	const byName = new Map<string, AcpSkillInfo>();

	for (const skill of await loadAerySkills()) {
		byName.set(skill.name, {
			name: skill.name,
			description: skill.description ?? "",
			filePath: skill.filePath,
		});
	}

	for (const skill of discoverClaudeCodeSkills(cwd, options)) {
		byName.set(skill.name, skill);
	}

	return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function discoverClaudeCodeSkills(
	cwd: string,
	_options: DiscoverAcpSkillCommandsOptions,
): AcpSkillInfo[] {
	const skills: AcpSkillInfo[] = [];
	const claudeSkillsDir = path.join(cwd, ".claude", "skills");
	try {
		const entries = require("node:fs").readdirSync(claudeSkillsDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const skillDir = path.join(claudeSkillsDir, entry.name);
			const mdPath = path.join(skillDir, "SKILL.md");
			try {
				const content = require("node:fs").readFileSync(mdPath, "utf8");
				const descriptionMatch = content.match(/^description:\s*(.*)/im);
				skills.push({
					name: entry.name,
					description: descriptionMatch?.[1]?.trim() ?? "",
					filePath: mdPath,
				});
			} catch {
				// SKILL.md missing — skip silently.
			}
		}
	} catch {
		// .claude/skills directory missing — skip silently.
	}
	return skills;
}


export function buildSkillAvailableCommands(skills: readonly AcpSkillInfo[]): AvailableCommand[] {
	return skills.map(skill => ({
		name: `skill:${skill.name}`,
		description: skill.description || `Invoke the ${skill.name} skill`,
		input: {
			hint: "Optional prompt to run with this skill loaded.",
		},
	}));
}

/**
 * Build a compact markdown block listing available skills for injection into
 * the system prompt. Returns an empty string when no skills are discovered.
 */
export async function buildSkillListBlock(
	cwd: string,
	options: Pick<DiscoverAcpSkillCommandsOptions, "homeDir"> = {},
): Promise<string> {
	const skills = await discoverAcpSkillCommands(cwd, options);
	if (skills.length === 0) return "";

	const lines = skills.map(s => `- **${s.name}**: ${s.description || `Use the ${s.name} skill.`}`);
	return `## Available Skills

Use the Skill tool to load a skill's full instructions when its description matches your task. You can also invoke a skill for the current turn by starting your message with \`/skill:<name>\`.

${lines.join("\n")}`;
}

export interface SkillCommandRewrite {
	readonly skillName: string;
	readonly remainingText: string;
	readonly skillContent: string;
}

/**
 * Parse a prompt that starts with a skill command name (`/skill:<name>`).
 * Returns undefined if the text does not begin with `/skill:` or if the name
 * is not a known skill.
 */
export async function tryParseSkillCommand(
	text: string,
	skills: ReadonlyMap<string, AcpSkillInfo>,
): Promise<SkillCommandRewrite | undefined> {
	if (!text.startsWith("/skill:")) return undefined;
	const withoutPrefix = text.slice("/skill:".length);
	const spaceIdx = withoutPrefix.search(/\s/);
	const name = spaceIdx === -1 ? withoutPrefix : withoutPrefix.slice(0, spaceIdx);
	const remaining = spaceIdx === -1 ? "" : withoutPrefix.slice(spaceIdx + 1).trimStart();

	if (!name) return undefined;
	const skill = skills.get(name);
	if (!skill) return undefined;

	let rawContent: string;
	try {
		rawContent = await readFile(skill.filePath, "utf-8");
	} catch {
		return undefined;
	}

	const skillContent = rawContent.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
	return { skillName: skill.name, remainingText: remaining, skillContent };
}

/**
 * Build the effective prompt text for a skill command invocation. The skill
 * content is injected as a clear prefix so the model applies it for this turn.
 */
export function buildSkillCommandPrompt(rewrite: SkillCommandRewrite): string {
	const { skillName, remainingText, skillContent } = rewrite;
	const header = `Invoking skill: ${skillName}`;
	const prefix = [header, "", skillContent].join("\n");
	return remainingText ? `${prefix}\n\n${remainingText}` : prefix;
}

