export interface MarketplaceCapabilities {
	tools?: string[];
	events?: string[];
	requires?: string[];
}

export interface PackMetadata {
	description: string;
	source: string;
	file: string;
	type: "extension" | "plugin" | "theme";
	tier: "core" | "verified" | "community";
	capabilities?: MarketplaceCapabilities;
	version: string;
	changelog?: string;
}

export interface MarketplaceRegistry {
	version: string;
	packs: Record<string, PackMetadata>;
}
