import type { SecretCategory } from "./secret-detector";
import type { SensitiveContentKind } from "./sensitive-content";

/**
 * Thrown by the stream() chokepoint when a request bound for a
 * data-collecting model contains credential-shaped or sensitive-file
 * content. Carries just enough structured info for the UI to render a
 * helpful message; never carries the secret itself.
 */
export class PrivacyFirewallError extends Error {
	readonly modelId: string;
	readonly categories: SecretCategory[];
	readonly sensitiveKinds: SensitiveContentKind[];
	readonly modelTier: "data-collecting";

	constructor(opts: {
		modelId: string;
		categories: SecretCategory[];
		sensitiveKinds: SensitiveContentKind[];
	}) {
		const catLabel = opts.categories.length > 0 ? opts.categories.join(", ") : opts.sensitiveKinds.join(", ");
		super(
			`Privacy firewall: blocked request to data-collecting model "${opts.modelId}" ` +
				`containing ${catLabel}. This model's provider may retain/use transmitted content, ` +
				`so credentials and sensitive files are never sent to it. ` +
				`Re-run with the secret redacted, switch to a zero-retention model, ` +
				`or disable the privacy guard for this model.`,
		);
		this.name = "PrivacyFirewallError";
		this.modelId = opts.modelId;
		this.categories = opts.categories;
		this.sensitiveKinds = opts.sensitiveKinds;
		this.modelTier = "data-collecting";
	}
}

/** Type guard for callers that want to branch on the firewall instead of message text. */
export function isPrivacyFirewallError(err: unknown): err is PrivacyFirewallError {
	return err instanceof PrivacyFirewallError;
}
