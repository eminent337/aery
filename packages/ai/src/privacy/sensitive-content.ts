import { scanTextForSecrets } from "./secret-detector";

/**
 * Sensitive-content heuristics for outbound LLM payloads.
 *
 * Complementary to secret-detector.ts: secrets are *values* that look like
 * credentials (sk-…, AKIA…). This module detects *context* that indicates
 * sensitive material is present even when the secret value itself is not
 * obviously secret-shaped — e.g. a tool result headed by a hashline marker
 * for `~/.env`, a user message pasting a `credentials.json`, or a block of
 * lines that structurally resemble a dotenv file.
 *
 * Path markers are carried in context blocks two ways:
 *  - Hashline headers `¶<displayPath>#<tag>` inside tool-result text (the
 *    read tool emits these; the display path is often repo-relative like
 *    `src/foo.ts` or `.env`).
 *  - Explicit path mentions in user/developer message text.
 *
 * All heuristics are local regex, with no network access and no secret
 * retention (offsets/labels only).
 */

/** Families of sensitive source material recognized by path shape. */
export type SensitiveContentKind = "dotenv" | "credentials" | "private-key-file" | "auth-db" | "models-yml";

/** A single sensitive-content finding: kind + offsets into scanned text. */
export interface SensitiveContentFinding {
	kind: SensitiveContentKind;
	/** Start offset of the offending marker within the scanned string. */
	start: number;
	/** End offset (exclusive) of the offending marker. */
	end: number;
	/** Human label, safe to show/log. */
	label: string;
	/**
	 * "path" — the marker appeared in a real path context (hashline header
	 * `¶.env#tag`, `src/.env`, `~/.env`, `read .env`): the file's contents
	 * are plausibly being transmitted. Escalates to block with a secret.
	 * "prose" — a mere textual mention (`the models.yml file`, `install via
	 * .env.example`) with no path context: warn-level only, never blocks.
	 */
	context: "path" | "prose";
}

export interface SensitiveContentScanResult {
	findings: SensitiveContentFinding[];
}

/**
 * Per-family compiled patterns. Leading boundary is start-of-string,
 * whitespace, a path separator (both slashes), or the `¶` hashline header
 * char — so `¶.env#A1B2`, `src/.env`, `cat .env`, and `the .env file` all
 * match, while `process.env` and `NODE_ENV` do not. Trailing boundary is
 * end-of-string, `#tag`, `.`, `?`, `\`, or whitespace.
 *
 * The `¶` boundary is safe only because the scan loop advances `lastIndex`
 * past any zero-width match (`Math.max(lastIndex, start+1)`); without that,
 * a boundary-only match re-anchors onto the same `¶` and loops forever.
 *
 * Deliberate exclusions:
 *  - `.env.example`, `.env.sample`, `.env.template`, `.env.dist` are
 *    committed template files and carry no secrets — must NOT trip.
 *  - Bare `env` is a common source identifier (`env.ts`) — not sensitive.
 *  - `config.json` is ubiquitous — not sensitive.
 */
const SENSITIVE_FAMILIES: Array<{ kind: SensitiveContentKind; label: string; re: RegExp }> = [
	{
		kind: "dotenv",
		label: ".env",
		re: /(?:^|[\s/\\¶])\.env(?!\.(?:example|sample|template|dist)\b)(?:[.-][A-Za-z0-9_-]+)?(?:$|(?=[#?.\s]))/gi,
	},
	{
		kind: "credentials",
		label: "credentials file",
		re: /(?:^|[\s/\\¶])(?:credentials\.json|credential\.json|service-account(?:-key)?\.json|service_account\.json|gcloud-service-account\.json|client_secret\.json|client-secret\.json|wp-config\.php)(?:$|(?=[#?.\\\s]))/gi,
	},
	{
		kind: "private-key-file",
		label: "private key",
		re: /(?:^|[\s/\\¶])(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|[\w.-]+\.pem|[\w.-]+\.p12|[\w.-]+\.pfx|[\w.-]+\.ppk|[\w.-]+\.keychain)(?:$|(?=[#?.\\\s]))/gi,
	},
	{
		kind: "auth-db",
		label: "auth store",
		re: /(?:^|[\s/\\¶])(?:auth\.json|auth\.db|agent\.db|credentials\.db|keyring\.json|secrets\.json)(?:$|(?=[#?.\\\s]))/gi,
	},
	{
		kind: "models-yml",
		label: "models config",
		re: /(?:^|[\s/\\¶])(?:models\.ya?ml)(?:$|(?=[#?.\\\s]))/gi,
	},
];

/**
 * Dotenv-structure heuristic: >= 3 lines shaped like `KEY=value` where the
 * value looks like a secret (non-comment, non-empty, length >= 10). Used to
 * catch `.env` content that arrives in the payload *without* a path marker
 * (e.g. pasted from shell output, `cat .env`).
 */
const DOTENV_LINE_RE = /^[A-Za-z_][A-Za-z0-9_]*=(?:[^\s"']{10,}|["'][^"']{10,}["'])$/gm;

/** Kinds that escalate to block when co-located with a secret match. */
const ESCALATION_KINDS: ReadonlySet<SensitiveContentKind> = new Set<SensitiveContentKind>([
	"dotenv",
	"credentials",
	"auth-db",
	"private-key-file",
	"models-yml",
]);

/** Scan a text blob for sensitive-content markers (paths + structure). */
export function scanTextForSensitiveContent(text: string): SensitiveContentScanResult {
	const findings: SensitiveContentFinding[] = [];

	// 1. path markers — hashline headers & explicit mentions. Uses
	// String.matchAll (requires the `g` flag) so iteration is safe: each
	// regex in SENSITIVE_FAMILIES is created with `/gi` at module scope, and
	// matchAll internally clones the regex per call, so no shared lastIndex
	// state can cause the zero-progress infinite loop that manual `exec` +
	// lastIndex juggling suffers from.
	for (const fam of SENSITIVE_FAMILIES) {
		for (const pm of text.matchAll(fam.re)) {
			// The regex's leading-boundary group is part of the match (`¶.env`,
			// ` .env`, `/.env`), so the boundary char is pm[0][0], not the char
			// before pm.index. Inspect the raw boundary to classify context.
			const boundary = pm[0][0] ?? "";
			// For verb-anchored paths (`read .env`), the match starts at the
			// space; look at the text right before the match for the verb.
			const before = text.slice(Math.max(0, pm.index - 8), pm.index);
			const isPathContext =
				boundary === "¶" ||
				boundary === "/" ||
				boundary === "\\" ||
				boundary === "~" ||
				/(?:read|cat|open|edit|ls|vi|vim|nano|tail|head|less|more|curl|wget)\s+$/i.test(`${before}${boundary}`);
			findings.push({
				kind: fam.kind,
				label: fam.label,
				start: pm.index,
				end: pm.index + pm[0].length,
				context: isPathContext ? "path" : "prose",
			});
		}
	}

	// 2. dotenv structural heuristic — warn when >= 3 lines look dotenv-ish
	const lines = text.split("\n");
	let dotenvLineCount = 0;
	for (const line of lines) {
		DOTENV_LINE_RE.lastIndex = 0;
		if (DOTENV_LINE_RE.test(line)) dotenvLineCount++;
	}
	if (dotenvLineCount >= 3) {
		findings.push({
			kind: "dotenv",
			label: "dotenv structure",
			start: 0,
			end: Math.min(text.length, 32),
			context: "path",
		});
	}

	findings.sort((a, b) => a.start - b.start || a.end - b.end);
	return { findings };
}

/** True when the text contains at least one sensitive-content marker. */
export function containsSensitiveContent(text: string): boolean {
	return scanTextForSensitiveContent(text).findings.length > 0;
}

/**
 * Escalate to block when a sensitive-content marker co-occurs with a secret
 * match in the same text (path marker + secret within the same block is a
 * strong signal the file's *content* is being transmitted).
 */
export function shouldEscalateToBlock(text: string): boolean {
	const sensitive = scanTextForSensitiveContent(text);
	// A prose mention ("configure in models.yml") is never grounds for block;
	// only a real path-context marker (hashline header, `src/.env`, `read
	// .env`, `~/.env`) signals the file's contents may be transmitted.
	const hasPathContextFinding = sensitive.findings.some(f => f.context === "path" && ESCALATION_KINDS.has(f.kind));
	if (!hasPathContextFinding) return false;
	const { matches } = scanTextForSecrets(text);
	return matches.length > 0;
}
