/**
 * Agent discovery from filesystem.
 *
 * Discovers agent definitions from:
 *   - ~/.aery/agent/agents/*.md (user-level, primary)
 *   - ~/.aery/agent/agents/*.md (user-level, legacy)
 *   - ~/.claude/agents/*.md (user-level, legacy)
 *   - .aery/agents/*.md (project-level, primary)
 *   - .aery/agents/*.md (project-level, legacy)
 *   - .claude/agents/*.md (project-level, legacy)
 *
 * Agent files use markdown with YAML frontmatter.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@aryee337/aery-utils";
import { isProviderEnabled } from "../capability";
import { findAllNearestProjectConfigDirs, getConfigDirs } from "../config";
import { listClaudePluginRoots } from "../discovery/helpers";
import { loadBundledAgents, parseAgent } from "./agents";
import type { AgentDefinition, AgentSource } from "./types";

/** Result of agent discovery */
export interface DiscoveryResult {
	agents: AgentDefinition[];
	projectAgentsDir: string | null;
}

interface CacheEntry {
	result: DiscoveryResult;
	expiresAt: number;
}

const discoveryCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000; // 30s cache TTL for snappy agent turnaround

/**
 * Clear the agent discovery cache (test-only or manual reload).
 */
export function clearAgentDiscoveryCache(): void {
	discoveryCache.clear();
}

/**
 * Load agents from a directory.
 */
async function loadAgentsFromDir(dir: string, source: AgentSource): Promise<AgentDefinition[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
	const files = entries
		.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(file => {
			const filePath = path.join(dir, file.name);
			return fs
				.readFile(filePath, "utf-8")
				.then(content => parseAgent(filePath, content, source, "warn"))
				.catch(error => {
					logger.warn("Failed to read agent file", { filePath, error });
					return null;
				});
		});

	return (await Promise.all(files)).filter(Boolean) as AgentDefinition[];
}

/**
 * Discover agents from filesystem and merge with bundled agents.
 *
 * Precedence (highest wins): .aery > .aery > .claude (project before user), then bundled
 *
 * @param cwd - Current working directory for project agent discovery
 * @param home - User home directory
 * @param options - Cache control options
 */
export async function discoverAgents(
	cwd: string,
	home: string = os.homedir(),
	options?: { force?: boolean },
): Promise<DiscoveryResult> {
	const resolvedCwd = path.resolve(cwd);
	const cacheKey = `${resolvedCwd}::${home}`;
	const now = Date.now();

	if (!options?.force) {
		const cached = discoveryCache.get(cacheKey);
		if (cached && cached.expiresAt > now) {
			return cached.result;
		}
	}
	const agentSources = Array.from(new Set(getConfigDirs("", { project: false }).map(entry => entry.source)));

	// Get user directories (priority order: .aery, .aery, .claude, ...)
	const userDirs = getConfigDirs("agents", { project: false })
		.filter(entry => agentSources.includes(entry.source))
		.map(entry => ({
			...entry,
			path: path.resolve(entry.path),
		}));

	// Get project directories by walking up from cwd (priority order)
	const projectDirs = findAllNearestProjectConfigDirs("agents", resolvedCwd)
		.filter(entry => agentSources.includes(entry.source))
		.map(entry => ({
			...entry,
			path: path.resolve(entry.path),
		}));

	const orderedSources = agentSources.filter(
		source => userDirs.some(entry => entry.source === source) || projectDirs.some(entry => entry.source === source),
	);

	const orderedDirs: Array<{ dir: string; source: AgentSource }> = [];
	for (const source of orderedSources) {
		const project = projectDirs.find(entry => entry.source === source);
		if (project) orderedDirs.push({ dir: project.path, source: "project" });
		const user = userDirs.find(entry => entry.source === source);
		if (user) orderedDirs.push({ dir: user.path, source: "user" });
	}

	// Load agents from Claude Code marketplace plugins (respects disabledProviders)
	const { roots: pluginRoots } = isProviderEnabled("claude-plugins")
		? await listClaudePluginRoots(home, resolvedCwd)
		: { roots: [] };
	const sortedPluginRoots = [...pluginRoots].sort((a, b) => {
		if (a.scope === b.scope) return 0;
		return a.scope === "project" ? -1 : 1;
	});
	for (const plugin of sortedPluginRoots) {
		const agentsDir = path.join(plugin.path, "agents");
		orderedDirs.push({ dir: agentsDir, source: plugin.scope === "project" ? "project" : "user" });
	}

	const seen = new Set<string>();
	const loadedAgents = (await Promise.all(orderedDirs.map(({ dir, source }) => loadAgentsFromDir(dir, source))))
		.flat()
		.filter(agent => {
			if (seen.has(agent.name)) return false;
			seen.add(agent.name);
			return true;
		});

	const bundledAgents = loadBundledAgents().filter(agent => {
		if (seen.has(agent.name)) return false;
		seen.add(agent.name);
		return true;
	});

	const projectAgentsDir = projectDirs.length > 0 ? projectDirs[0].path : null;
	const result: DiscoveryResult = { agents: [...loadedAgents, ...bundledAgents], projectAgentsDir };
	discoveryCache.set(cacheKey, { result, expiresAt: now + CACHE_TTL_MS });

	return result;
}

/**
 * Get an agent by name from discovered agents.
 */
export function getAgent(agents: AgentDefinition[], name: string): AgentDefinition | undefined {
	return agents.find(a => a.name === name);
}
