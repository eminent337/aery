import type { ExternalAgentAdapter, ExternalAgentExecutionOptions, ResolvedAgentInvocation } from "./types";

export const BUILTIN_EXTERNAL_AGENTS: Record<string, ExternalAgentAdapter> = {
	agy: {
		id: "agy",
		displayName: "Google Antigravity (agy)",
		defaultBinary: "agy",
		versionArgs: ["--version"],
		buildArgs: (prompt, options) => {
			const args = ["-p", prompt, "--dangerously-skip-permissions"];
			if (options?.extraArgs?.length) {
				args.push(...options.extraArgs);
			}
			return args;
		},
		parseVersion: stdout => stdout.trim().split("\n")[0] ?? "unknown",
	},

	codex: {
		id: "codex",
		displayName: "OpenAI Codex CLI",
		defaultBinary: "codex",
		versionArgs: ["-V"],
		buildArgs: (prompt, options) => {
			const args = ["exec", prompt, "--dangerously-bypass-approvals-and-sandbox"];
			if (options?.extraArgs?.length) {
				args.push(...options.extraArgs);
			}
			return args;
		},
		parseVersion: stdout => stdout.trim().split("\n")[0] ?? "unknown",
	},

	opencode: {
		id: "opencode",
		displayName: "OpenCode",
		defaultBinary: "opencode",
		versionArgs: ["--version"],
		buildArgs: (prompt, options) => {
			const args = ["run", prompt, "--auto"];
			if (options?.extraArgs?.length) {
				args.push(...options.extraArgs);
			}
			return args;
		},
		parseVersion: stdout => stdout.trim().split("\n")[0] ?? "unknown",
	},

	claude: {
		id: "claude",
		displayName: "Anthropic Claude Code CLI",
		defaultBinary: "claude",
		versionArgs: ["--version"],
		buildArgs: (prompt, options) => {
			const args = ["-p", prompt, "--dangerously-skip-permissions"];
			if (options?.extraArgs?.length) {
				args.push(...options.extraArgs);
			}
			return args;
		},
		parseVersion: stdout => stdout.trim().split("\n")[0] ?? "unknown",
	},

	aider: {
		id: "aider",
		displayName: "Aider AI Pair Programmer",
		defaultBinary: "aider",
		versionArgs: ["--version"],
		buildArgs: (prompt, options) => {
			const args = ["--message", prompt, "--yes"];
			if (options?.extraArgs?.length) {
				args.push(...options.extraArgs);
			}
			return args;
		},
		parseVersion: stdout => stdout.trim().split("\n")[0] ?? "unknown",
	},

	pi: {
		id: "pi",
		displayName: "Pi Coding Agent",
		defaultBinary: "pi",
		versionArgs: ["--version"],
		buildArgs: (prompt, options) => {
			const args = ["-p", prompt];
			if (options?.extraArgs?.length) {
				args.push(...options.extraArgs);
			}
			return args;
		},
		parseVersion: stdout => stdout.trim().split("\n")[0] ?? "unknown",
	},

	gh: {
		id: "gh",
		displayName: "GitHub Copilot CLI",
		defaultBinary: "gh",
		versionArgs: ["--version"],
		buildArgs: (prompt, options) => {
			const args = ["copilot", "suggest", prompt];
			if (options?.extraArgs?.length) {
				args.push(...options.extraArgs);
			}
			return args;
		},
		parseVersion: stdout => stdout.trim().split("\n")[0] ?? "unknown",
	},

	custom: {
		id: "custom",
		displayName: "Custom / Generic CLI Agent",
		defaultBinary: "agent",
		versionArgs: ["--version"],
		buildArgs: (prompt, options) => {
			const args = options?.extraArgs ? [...options.extraArgs] : [];
			args.push(prompt);
			return args;
		},
		parseVersion: stdout => stdout.trim().split("\n")[0] ?? "unknown",
	},
};

export function getExternalAgentAdapter(agentId: string): ExternalAgentAdapter | undefined {
	return BUILTIN_EXTERNAL_AGENTS[agentId.toLowerCase()];
}

export function listSupportedExternalAgents(): ExternalAgentAdapter[] {
	return Object.values(BUILTIN_EXTERNAL_AGENTS);
}

export function resolveAgentInvocation(
	agentId: string,
	prompt: string,
	options?: ExternalAgentExecutionOptions,
): ResolvedAgentInvocation {
	const adapter = getExternalAgentAdapter(agentId);
	if (!adapter) {
		throw new Error(
			`Unknown external agent '${agentId}'. Supported: ${listSupportedExternalAgents()
				.map(a => a.id)
				.join(", ")}`,
		);
	}

	const binary = options?.customBinary || adapter.defaultBinary;
	const args = adapter.buildArgs(prompt, options);

	return {
		binary,
		args,
		cwd: options?.cwd,
		timeoutMs: options?.timeoutMs,
	};
}
