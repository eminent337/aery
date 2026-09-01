import { appendFile } from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@aryee337/aery-utils";

/**
 * Local privacy audit log.
 *
 * Append-only JSONL at `~/.aery/agent/privacy-audit.log`. One line per
 * firewall finding (block or warn). Fields are metadata ONLY — the matched
 * secret value or sensitive file content is NEVER written.
 *
 * Lines look like:
 *   {"ts":1710000000000,"provider":"opencode-zen","model":"muse-spark-1.2-contributor-free","categories":["aws-access-key"],"sensitiveKinds":[],"action":"block"}
 *
 * Failures are swallowed: an unwritable audit log must never break or slow
 * the guarded request.
 */

export interface AuditEntry {
	ts: number;
	provider: string;
	model: string;
	categories: string[];
	sensitiveKinds: string[];
	action: "block" | "warn";
}

/** Injected for tests; undefined -> real agent dir (~/.aery/agent). */
let auditLogPathOverride: string | undefined;

export function __setPrivacyAuditLogPath(p: string | undefined): void {
	auditLogPathOverride = p;
}

export function __getPrivacyAuditLogPath(): string {
	return auditLogPathOverride ?? path.join(getAgentDir(), "privacy-audit.log");
}

/**
 * Append one audit line. Fire-and-forget: never throws, never blocks the
 * hot path (the append is queued to the event loop).
 */
export function appendPrivacyAudit(entry: AuditEntry): void {
	try {
		void appendFile(__getPrivacyAuditLogPath(), `${JSON.stringify(entry)}\n`, { flag: "a" }).catch(() => {
			/* audit is best-effort */
		});
	} catch {
		/* synchronous failure (bad path) is also silent */
	}
}
