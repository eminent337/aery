import type { Context } from "../types";
import { resolvePrivacyMode } from "./policy";
import { type SecretCategory, scanTextForSecrets } from "./secret-detector";
import { type SensitiveContentKind, scanTextForSensitiveContent, shouldEscalateToBlock } from "./sensitive-content";

/**
 * The stream() chokepoint guard. Given a model id and the outbound context,
 * decides whether the request may proceed:
 *  - mode "off"  -> proceed (no scan).
 *  - mode "block"-> throw PrivacyFirewallError if the context contains a
 *    secret OR a sensitive-file path marker (escalated).
 *  - mode "warn" -> record an audit finding and proceed.
 *
 * Performance: a cheap `includes()` prefilter per message lets ordinary
 * turns (no secret-looking substrings) skip both regex scans entirely.
 * Only text that actually hints at a credential runs the full scan, and we
 * early-terminate once a block-grade signal is found. Runs once per
 * request; images are not text-scanned; offsets/categories only.
 */

/** Cheap hint substrings: if none appear, a message is very likely clean. */
const SECRET_HINTS = [
	"sk-",
	"AKIA",
	"ASIA",
	"ABIA",
	"ACCA",
	"ghp_",
	"github_pat_",
	"xox",
	"AIza",
	"-----BEGIN",
	"eyJ",
	"api_key",
	"apikey",
	"secret",
	"password",
	"passwd",
	"PRIVATE KEY",
	"aws_access",
] as const;

/** Very fast: does the text contain ANY secret hint? */
function hasSecretHint(text: string): boolean {
	for (const hint of SECRET_HINTS) {
		if (text.includes(hint)) return true;
	}
	return false;
}

export interface FirewallFinding {
	categories: SecretCategory[];
	sensitiveKinds: SensitiveContentKind[];
	/** True when a path-context sensitive marker + secret co-occurred (block-grade). */
	escalated: boolean;
	/** Which message(s) triggered (index + role) for audit UIs. */
	sources: Array<{ messageIndex: number; role: string }>;
}

/** Extract scanable text from a message's content blocks. */
function messageText(content: Context["messages"][number]["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (
			block &&
			typeof block === "object" &&
			"type" in block &&
			block.type === "text" &&
			typeof block.text === "string"
		) {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

/** Scan the whole context; returns null when nothing problematic is present. */
export function scanContextForFirewall(context: Context): FirewallFinding | null {
	const categories: SecretCategory[] = [];
	const sensitiveKinds: SensitiveContentKind[] = [];
	let escalated = false;
	const sources: Array<{ messageIndex: number; role: string }> = [];

	for (let messageIndex = 0; messageIndex < context.messages.length; messageIndex++) {
		const msg = context.messages[messageIndex]!;
		const text = messageText(msg.content);
		if (!text) continue;

		// Fast path: no hint substrings -> skip both expensive scans.
		if (!hasSecretHint(text)) continue;

		let msgSecrets: ReturnType<typeof scanTextForSecrets>["matches"] = [];
		let msgSensitive: ReturnType<typeof scanTextForSensitiveContent>["findings"] = [];

		// Only run the full secret scan when a hint is present (cheap guard on top).
		const secrets = scanTextForSecrets(text);
		if (secrets.matches.length > 0) {
			msgSecrets = secrets.matches;
			for (const m of msgSecrets) {
				if (!categories.includes(m.category)) categories.push(m.category);
			}
			sources.push({ messageIndex, role: msg.role });
		}

		// Sensitive-content scan + escalation: compute once, reuse for both.
		const sensitive = scanTextForSensitiveContent(text);
		if (sensitive.findings.length > 0) {
			msgSensitive = sensitive.findings;
			for (const f of msgSensitive) {
				if (!sensitiveKinds.includes(f.kind)) sensitiveKinds.push(f.kind);
			}
			// Path-context marker + secret in the same message is block-grade.
			if (shouldEscalateToBlock(text)) {
				escalated = true;
				// Block-grade found: no need to scan the rest of the context.
				break;
			}
		}
	}

	if (categories.length === 0 && sensitiveKinds.length === 0) {
		return null;
	}
	return { categories, sensitiveKinds, escalated, sources };
}

/**
 * Chokepoint entry: decide what to do for a model bound for stream().
 * Returns the mode to apply. Caller (stream.ts) branches:
 *  - "block" -> throw new PrivacyFirewallError(finding)
 *  - "warn"  -> audit + proceed
 *  - "off"   -> proceed
 */
export function evaluateFirewall(
	modelId: string,
	context: Context,
): { mode: "block" | "warn" | "off"; finding: FirewallFinding | null } {
	const mode = resolvePrivacyMode(modelId);
	if (mode === "off") return { mode: "off", finding: null };
	if (mode === "block") {
		const finding = scanContextForFirewall(context);
		if (finding) return { mode: "block", finding };
		return { mode: "block", finding: null };
	}
	// warn: still scan so the caller can audit, but never block
	const finding = scanContextForFirewall(context);
	return { mode: "warn", finding };
}
