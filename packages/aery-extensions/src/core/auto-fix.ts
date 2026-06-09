/**
 * Auto-Fix Extension
 *
 * Runs lint/test after file-editing tools and injects errors
 * as context so the AI can fix them automatically.
 *
 * Config: ~/.aery/agent/auto-fix.json
 *
 * {
 *   "enabled": true,
 *   "lint": "npm run lint",
 *   "test": "npm test",
 *   "maxRetries": 3,
 *   "timeout": 30,
 *   "tools": ["edit", "write"]
 * }
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@aryee337/aery";

interface AutoFixConfig {
	enabled: boolean;
	lint?: string;
	test?: string;
	maxRetries: number;
	timeout: number;
	tools: string[];
}

function loadConfig(): AutoFixConfig {
	const path = join(homedir(), ".aery", "agent", "auto-fix.json");
	if (!existsSync(path)) {
		return {
			enabled: false,
			maxRetries: 3,
			timeout: 30,
			tools: ["edit", "write"],
		};
	}
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return {
			enabled: false,
			maxRetries: 3,
			timeout: 30,
			tools: ["edit", "write"],
		};
	}
}

function runCheck(command: string, timeout: number): { success: boolean; output: string } {
	try {
		execSync(command, {
			timeout: timeout * 1000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return { success: true, output: "" };
	} catch (e: any) {
		return {
			success: false,
			output: [e.stdout?.toString(), e.stderr?.toString()].filter(Boolean).join("\n").slice(0, 5000),
		};
	}
}

export default function autoFix(aery: ExtensionAPI): void {
	const config = loadConfig();
	if (!config.enabled) return;

	const toolSet = new Set(config.tools.map(t => t.toLowerCase()));
	let retryCount = 0;

	aery.on("tool_result", event => {
		const toolName = event.toolName.toLowerCase();
		if (!toolSet.has(toolName)) return undefined;
		if (event.isError) return undefined;

		// Reset retry count on non-edit tool use
		if (!toolSet.has(toolName)) {
			retryCount = 0;
			return undefined;
		}

		// Check retry limit
		if (retryCount >= config.maxRetries) {
			retryCount = 0;
			return undefined;
		}

		const errors: string[] = [];

		// Run lint
		if (config.lint) {
			const lintResult = runCheck(config.lint, config.timeout);
			if (!lintResult.success) {
				errors.push(`Lint errors:\n${lintResult.output}`);
			}
		}

		// Run test (only if lint passed or no lint configured)
		if (config.test && errors.length === 0) {
			const testResult = runCheck(config.test, config.timeout);
			if (!testResult.success) {
				errors.push(`Test failures:\n${testResult.output}`);
			}
		}

		if (errors.length > 0) {
			retryCount++;
			const errorMsg = errors.join("\n\n");

			// Inject error context so the AI can fix it
			return {
				content: [
					{
						type: "text" as const,
						text: `\n\n[Auto-Fix] Issues detected (attempt ${retryCount}/${config.maxRetries}):\n${errorMsg}\n\nPlease fix these issues.`,
					},
				],
			};
		}

		// Success — reset retry count
		retryCount = 0;
		return undefined;
	});

	// Reset retry count on new turn
	aery.on("turn_start", () => {
		retryCount = 0;
	});
}
