/**
 * Wake Word and Intent Extraction Engine for Aerys.
 *
 * Modeled after isair/jarvis wake_detection.py:
 * Listens for "Aerys" or "Aery" (and phonetic variations like "Aries" / "Airy")
 * using exact and token-level fuzzy matching.
 */

const PRIMARY_WAKE_WORDS = ["aerys", "aery", "aeries"];
const PHONETIC_ALIASES = [
	"aeries",
	"aries",
	"airy",
	"eris",
	"aris",
	"eyries",
	"ayres",
	"aeris",
	"eriss",
	"paris",
	"areas",
	"ares",
	"iris",
	"harris",
	"airis",
	"aerie",
	"ariss",
	"erice",
];

const ALL_VARIANTS = [...PRIMARY_WAKE_WORDS, ...PHONETIC_ALIASES];
/** Simple string similarity (Levenshtein-based ratio) */
function similarityRatio(s1: string, s2: string): number {
	if (s1 === s2) return 1.0;
	if (s1.length === 0 || s2.length === 0) return 0.0;

	const longer = s1.length > s2.length ? s1 : s2;
	const shorter = s1.length > s2.length ? s2 : s1;

	// Wagner-Fischer algorithm
	const costs = new Int32Array(shorter.length + 1);
	for (let j = 0; j <= shorter.length; j++) costs[j] = j;

	for (let i = 1; i <= longer.length; i++) {
		let nw = i - 1;
		costs[0] = i;
		for (let j = 1; j <= shorter.length; j++) {
			const cost = longer[i - 1] === shorter[j - 1] ? 0 : 1;
			const c = Math.min(costs[j] + 1, costs[j - 1] + 1, nw + cost);
			nw = costs[j];
			costs[j] = c;
		}
	}

	return (longer.length - costs[shorter.length]) / longer.length;
}

export interface WakeDetectionResult {
	detected: boolean;
	matchedWord?: string;
	query: string;
}

/**
 * Checks if a transcribed text contains the wake word and extracts the query.
 *
 * Examples:
 * - "Aerys, what is the git status?" -> { detected: true, query: "what is the git status?" }
 * - "Can you hear me, Aery?"        -> { detected: true, query: "Can you hear me" }
 * - "Talking to a friend on phone"   -> { detected: false, query: "" }
 */
export function detectWakeWord(rawText: string, fuzzyThreshold = 0.70): WakeDetectionResult {
	if (!rawText || !rawText.trim()) {
		return { detected: false, query: "" };
	}

	const normalized = rawText.toLowerCase().trim();
	const tokens = normalized
		.replace(/[.,!?;:()\[\]{}"'`\-_/]/g, " ")
		.split(/\s+/)
		.filter(t => t.length > 0);

	if (tokens.length === 0) {
		return { detected: false, query: "" };
	}

	const first = tokens[0];
	const second = tokens.length > 1 ? tokens[1] : undefined;
	const last = tokens.length > 1 ? tokens[tokens.length - 1] : undefined;
	const isGreeting = first === "hey" || first === "hi" || first === "hello" || first === "ok" || first === "okay";

	const candidates: string[] = [isGreeting && second ? second : first];
	if (last && last !== candidates[0]) {
		candidates.push(last);
	}

	let matchedToken: string | undefined;

	// 1. Check exact match on leading or trailing candidate
	for (const candidate of candidates) {
		if (ALL_VARIANTS.includes(candidate)) {
			matchedToken = candidate;
			break;
		}
	}

	// 2. Fall back to fuzzy match only on the candidates
	if (!matchedToken) {
		for (const candidate of candidates) {
			for (const variant of ALL_VARIANTS) {
				if (similarityRatio(candidate, variant) >= fuzzyThreshold) {
					matchedToken = candidate;
					break;
				}
			}
			if (matchedToken) break;
		}
	}
	if (!matchedToken) {
		return { detected: false, query: "" };
	}

	// Remove the matched word from the raw text and clean up punctuation artifacts
	const regex = new RegExp(`\\b${matchedToken}\\b`, "gi");
	let query = rawText.replace(regex, " ").trim();
	query = query.replace(/^[,.!?:;\s]+/, "");
	query = query.replace(/,\s*\?$/, "?");
	query = query.replace(/,\s*\.$/, ".");
	query = query.replace(/\s+([?.!])/g, "$1");
	if (query.replace(/^[,.!?:;\s]+$/, "") === "") {
		query = "";
	}

	return {
		detected: true,
		matchedWord: matchedToken,
		query: query.trim(),
	};
}
