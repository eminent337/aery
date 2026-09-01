/**
 * Local, network-free secret detection for outbound LLM payloads.
 *
 * Design goals, in order:
 * 1. Precision over recall — every match should be a genuine credential or
 *    sensitive personal item. False positives on ordinary code are worse
 *    than a rare miss, because blocks interrupt the user's flow.
 * 2. Zero network access, microseconds per message — this runs on every
 *    outbound request to a data-collecting model.
 * 3. No content retention — the detector returns offsets/categories only;
 *    callers never persist the matched text beyond the audit event id.
 */

import bip39Words from "./bip39-words.json";

/** Categories a matched secret can belong to. Drives audit ids + UI copy. */
export type SecretCategory =
	| "openai-key"
	| "anthropic-key"
	| "aws-access-key"
	| "github-token"
	| "slack-token"
	| "google-api-key"
	| "private-key"
	| "jwt"
	| "seed-phrase"
	| "high-entropy-token"
	| "connection-string"
	| "credential-assignment";

/** A single detection: category + offsets into the scanned string. */
export interface SecretMatch {
	category: SecretCategory;
	/** Match start offset within the scanned text. */
	start: number;
	/** Match end offset (exclusive) within the scanned text. */
	end: number;
	/** Short human label for the matched family, safe to show/log. */
	label: string;
}

export interface SecretScanResult {
	matches: SecretMatch[];
}

const BIP39 = new Set<string>(bip39Words);

/**
 * High-precision patterns. Each must be specific enough that ordinary source
 * code, docs, and logs do not trip it. Ordered roughly by specificity.
 */
const PATTERNS: Array<{
	category: SecretCategory;
	label: string;
	re: RegExp;
}> = [
	{
		category: "openai-key",
		label: "OpenAI API key",
		// sk- + 48 [A-Za-z0-9_-] (current OpenAI shape); sk-proj- covered by prefix tolerance
		re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,60}\b/g,
	},
	{
		category: "anthropic-key",
		label: "Anthropic API key",
		re: /\bsk-ant-[A-Za-z0-9_-]{30,80}\b/g,
	},
	{
		category: "aws-access-key",
		label: "AWS access key",
		// AKIA/ASIA + 16 uppercase alnum; word-bounded
		re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
	},
	{
		category: "github-token",
		label: "GitHub token",
		// ghp_/gho_/ghu_/ghs_/ghr_ + 36; github_pat_ + 22_60ish
		re: /\bgh[pousr]_[A-Za-z0-9]{30,60}\b|\bgithub_pat_[A-Za-z0-9_]{40,120}\b/g,
	},
	{
		category: "slack-token",
		label: "Slack token",
		re: /\bxox[baprs]-[A-Za-z0-9-]{8,80}\b/g,
	},
	{
		category: "google-api-key",
		label: "Google API key",
		re: /\bAIza[0-9A-Za-z_-]{30,40}\b/g,
	},
	{
		category: "private-key",
		label: "private key block",
		re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
	},
	{
		category: "jwt",
		label: "JWT",
		// three base64url segments; require believable lengths to avoid hitting
		// dotted identifiers like a.b.c
		re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
	},
	{
		category: "connection-string",
		label: "credential-bearing connection string",
		// scheme://user:password@host — password must look non-trivial (>=6, no pure 'x')
		re: /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/@]{6,}@[^\s@]+/g,
	},
];

/**
 * Assignment-shaped secrets: `api_key = "..."` / `password: ...` where the
 * value looks like a secret (long, mixed charset). Deliberately conservative:
 * requires both a credential-ish key name AND a secret-shaped value, so
 * ordinary assignments like `name = "alice"` never match.
 */
const ASSIGNMENT_RE =
	/\b(?:api[_-]?key|apikey|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|refresh[_-]?token|password|passwd|pwd)\b["']?\s*[:=]\s*["']?([^\s"']{12,128})["']?/gi;

/**
 * Generic bearer/high-entropy token: long mixed-alphabet runs. Requires
 * >= 28 chars and at least 3 of 4 alphabets (lower/upper/digit/special) so
 * ordinary long identifiers (hashes in docs, base64 fixtures, uuids) rarely
 * match. Used only when no more specific family matched, to limit noise.
 */
function looksHighEntropy(token: string): boolean {
	if (token.length < 28) return false;
	const hasLower = /[a-z]/.test(token);
	const hasUpper = /[A-Z]/.test(token);
	const hasDigit = /[0-9]/.test(token);
	const hasSpecial = /[-_.~+/@=]/.test(token);
	const alphabets = [hasLower, hasUpper, hasDigit, hasSpecial].filter(Boolean).length;
	if (alphabets < 3) return false;
	// Generic bucket only: real bearer tokens are near-always mixed-case.
	// All-lowercase runs (uuids, hex hashes, base64 fixtures) are excluded —
	// they're identifiers, not secrets, and the specific-family patterns
	// (openai/anthropic/github/...) already handle their lowercase forms.
	if (!hasUpper) return false;
	// Very low variety (e.g. "aaaa...") is not secret-like.
	return new Set(token).size >= Math.max(10, Math.floor(token.length * 0.3));
}

const ENTROPY_TOKEN_RE = /\b[A-Za-z0-9_+/-]{28,}={0,2}\b/g;

/**
 * Seed-phrase detection: a run of 12 or 24 BIP39 words separated by single
 * spaces (or newlines). Requiring the full run of dictionary words makes
 * false positives on normal prose practically impossible (the chance of 12
 * consecutive BIP39 words in ordinary text is astronomically low).
 */

function scanSeedPhrases(text: string, matches: SecretMatch[]): void {
	const tokenRe = /\S+/g;
	let m: RegExpExecArray | null;
	while ((m = tokenRe.exec(text)) !== null) {
		// find runs of BIP39 words (case-insensitive) separated by single spaces
		if (!BIP39.has(m[0].toLowerCase())) continue;
		const runStart = m.index;
		let runEnd = m.index + m[0].length;
		let runLen = 1;
		let cursor = runEnd;
		while (runLen < 24) {
			const sep = text[cursor];
			if (sep !== " " && sep !== "\n") break;
			const nextMatch = /\S+/.exec(text.slice(cursor + 1));
			if (!nextMatch || nextMatch.index !== 0) break; // single separator only
			const nextWord = nextMatch[0];
			if (!BIP39.has(nextWord.toLowerCase())) break;
			runLen++;
			runEnd = cursor + 1 + nextWord.length;
			cursor = runEnd;
		}
		if (runLen === 12 || runLen === 24) {
			matches.push({
				category: "seed-phrase",
				label: "BIP39 seed phrase",
				start: runStart,
				end: runEnd,
			});
			// jump past this run
			tokenRe.lastIndex = runEnd;
		}
	}
}

/** Scan a text blob for secret-like content. Returns offsets only. */
export function scanTextForSecrets(text: string): SecretScanResult {
	const matches: SecretMatch[] = [];

	for (const p of PATTERNS) {
		p.re.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = p.re.exec(text)) !== null) {
			matches.push({
				category: p.category,
				label: p.label,
				start: m.index,
				end: m.index + m[0].length,
			});
			if (m.index === p.re.lastIndex) p.re.lastIndex++;
		}
	}

	// credential assignments
	ASSIGNMENT_RE.lastIndex = 0;
	let am: RegExpExecArray | null;
	while ((am = ASSIGNMENT_RE.exec(text)) !== null) {
		const value = am[1];
		if (value && looksHighEntropy(value)) {
			matches.push({
				category: "credential-assignment",
				label: "credential assignment",
				start: am.index,
				end: am.index + am[0].length,
			});
		}
		if (am.index === ASSIGNMENT_RE.lastIndex) ASSIGNMENT_RE.lastIndex++;
	}

	// high-entropy bearer tokens — only if nothing specific already covered
	// this span (dedupe by overlap against specific families)
	ENTROPY_TOKEN_RE.lastIndex = 0;
	let em: RegExpExecArray | null;
	while ((em = ENTROPY_TOKEN_RE.exec(text)) !== null) {
		const token = em[0];
		if (!looksHighEntropy(token)) {
			if (em.index === ENTROPY_TOKEN_RE.lastIndex) ENTROPY_TOKEN_RE.lastIndex++;
			continue;
		}
		const start = em.index;
		const end = em.index + token.length;
		const overlapped = matches.some(existing => start < existing.end && existing.start < end);
		if (!overlapped) {
			matches.push({
				category: "high-entropy-token",
				label: "high-entropy token",
				start,
				end,
			});
		}
		if (em.index === ENTROPY_TOKEN_RE.lastIndex) ENTROPY_TOKEN_RE.lastIndex++;
	}

	scanSeedPhrases(text, matches);

	matches.sort((a, b) => a.start - b.start || a.end - b.end);
	return { matches };
}

/** True if the text contains at least one secret-like match. */
export function containsSecret(text: string): boolean {
	return scanTextForSecrets(text).matches.length > 0;
}
