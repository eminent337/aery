/**
 * Free-tier model detection for the privacy firewall.
 *
 * Beyond the opencode-zen free tier, aery's bundled catalog exposes free
 * aliases through several aggregator/gateway providers:
 *   - openrouter: `openrouter/free`, `openai/gpt-oss-20b:free`, `...:free`
 *   - kilo / litellm / zenmux: mirrors of the same `:free` pool plus
 *     `kilo-auto/free` / `kilo/auto-free` and `*-free` ids (deepseek, glm,
 *     mimo, kat-coder, ...)
 *   - legacy `opencode` provider: `glm-5-free`, `kimi-k2.5-free` (same zen
 *     gateway, covered by the -free marker below).
 *
 * Free tiers of third-party aggregators do not carry the same
 * zero-retention guarantee as paid/openai/anthropic keys, so the firewall
 * treats any model whose routing id carries an unambiguous free marker as
 * data-collecting. Non-free ids (gpt-4o, claude-*, deepseek-v4-flash
 * without :free, azure/gpt-4o, local ollama) never match, so the warm path
 * for ordinary models stays a couple of string checks.
 *
 * Marker rules (model routing ids, case-insensitive):
 *   - alias: `openrouter/free`, `kilo-auto/free`, `kilo/auto-free`
 *   - suffix `:free` — e.g. `openai/gpt-oss-20b:free`,
 *     `x-ai/grok-code-fast-1:optimized:free`
 *   - suffix `-free` — e.g. `muse-spark-1.2-contributor-free`,
 *     `deepseek-v4-flash-free`, `glm-5-free`, `google/gemini-3.5-flash-free`
 */

const FREE_ALIASES = new Set(["openrouter/free", "kilo-auto/free", "kilo/auto-free"]);

/**
 * True when the model routing id carries a free-tier marker.
 *
 * @param modelId Model routing id (case-insensitive).
 * @param alreadyLower Pass `true` when the caller has already lowercased the
 *   id (hot path in policy.ts) to skip a redundant toLowerCase().
 */
export function isFreeTierModelId(modelId: string, alreadyLower = false): boolean {
	const lower = alreadyLower ? modelId : modelId.toLowerCase();
	if (FREE_ALIASES.has(lower)) return true;
	return lower.endsWith(":free") || lower.endsWith("-free");
}
