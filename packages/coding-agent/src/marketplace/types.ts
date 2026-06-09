/**
 * Aery Marketplace — Type Definitions
 * Defines the shape of packs, registry, capabilities, and install records.
 */

export type PackTier = "core" | "verified" | "community";
export type PackType = "extension" | "skills" | "bundle";

export interface PackCapabilities {
	/** Tools registered by this extension */
	tools?: string[];
	/** Lifecycle events subscribed to */
	events?: string[];
	/** Other pack names this pack depends on */
	requires?: string[];
	/** Required environment variables */
	env?: string[];
	/** Whether this extension participates in the swarm grid */
	swarm?: boolean;
}

export interface Pack {
	description: string;
	source: string;
	install?: string;
	file?: string;
	postInstall?: string;
	extensions?: string[];
	auto?: boolean;
	coming_soon?: boolean;
	type?: PackType;
	tier?: PackTier;
	version?: string;
	changelog?: string;
	capabilities?: PackCapabilities;
	tags?: string[];
}

export interface Registry {
	version: string;
	packs: Record<string, Pack>;
}

export interface InstalledPack {
	name: string;
	source: string;
	file?: string;
	installedAt: string;
	pinnedCommit?: string;
	version?: string;
}

export interface MarketplaceSettings {
	extensions?: string[];
	packages?: string[];
	installed?: InstalledPack[];
}
