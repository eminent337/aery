/**
 * Aery Structured Security & Sandbox Decision Audit Log
 * Streams tool authorization, block, and safety decisions as JSONL entries.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface SecurityDecisionEntry {
	timestamp: string; // ISO-8601
	toolName: string;
	action: string;
	target: string;
	decision: "allow" | "block";
	rule?: string; // e.g. "blockGitWrites", "protected_path", "read_only", "always_blocked", "user_rule"
	reason?: string;
	metadata?: Record<string, unknown>;
}

export interface SecurityAuditLoggerOptions {
	logPath?: string;
}

export function resolveAuditLogPath(customPath?: string): string {
	const rawPath =
		customPath || process.env.AERY_SECURITY_AUDIT_LOG || join(homedir(), ".aery", "logs", "security-audit.jsonl");

	if (rawPath === "~") {
		return homedir();
	}
	if (rawPath.startsWith("~/")) {
		return join(homedir(), rawPath.slice(2));
	}
	return resolve(rawPath);
}

export class SecurityAuditLogger {
	public readonly logPath: string;

	constructor(logPathOrOptions?: string | SecurityAuditLoggerOptions) {
		const rawPath = typeof logPathOrOptions === "string" ? logPathOrOptions : logPathOrOptions?.logPath;
		this.logPath = resolveAuditLogPath(rawPath);
	}

	/**
	 * Append a single security decision entry to the JSONL log file.
	 * Safe fallback: never throws or crashes if disk or directory write fails.
	 */
	logDecision(entry: SecurityDecisionEntry): void {
		try {
			const dir = dirname(this.logPath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			const line = `${JSON.stringify(entry)}\n`;
			appendFileSync(this.logPath, line, "utf-8");
		} catch {
			// Fail-safe: audit logging must not interrupt tool execution
		}
	}

	/**
	 * Flush or close log resources if needed.
	 */
	close(): void {
		// No-op for synchronous appendFileSync, available for interface completeness
	}
}
