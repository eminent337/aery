import type { PrivacyMode, PrivacyPolicy } from "@aryee337/aery-ai";

/**
 * Build the runtime privacy policy from aery settings.
 *
 * Semantics:
 *  - enabled=false is the master kill switch: NOTHING is scanned and the
 *    mode/extras/allowlist are ignored. (We must NOT fall back to the ai
 *    package's default policy here — its default blocks data-collecting
 *    models, which is exactly what "off" must not do.)
 *  - enabled=true: allowlisted ids always pass; data-collecting models get
 *    the configured mode (block/warn/off); everything else is untouched.
 *
 * Kept as a pure function so the settings->policy mapping is unit-testable
 * without constructing an AgentSession.
 */
export function buildPrivacyPolicy(
	enabled: boolean,
	mode: PrivacyMode,
	extras: readonly string[],
	allowlist: readonly string[],
): PrivacyPolicy {
	if (!enabled) {
		return {
			resolveMode: () => "off",
			extraDataCollecting: new Set<string>(),
		};
	}
	const allowSet = new Set(allowlist.map(id => id.toLowerCase()));
	const extraSet = new Set(extras.map(id => id.toLowerCase()));
	return {
		resolveMode: (modelId, tier) => {
			if (allowSet.has(modelId.toLowerCase())) return "off";
			return tier === "data-collecting" ? mode : "off";
		},
		extraDataCollecting: extraSet,
	};
}
