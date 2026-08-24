/**
 * Types for the Settings-style Plugins & Marketplace Hub.
 */

export type HubTabId = "marketplace" | "installed" | "updates";

export type ExtensionTier = "core" | "verified" | "community";

export type ExtensionScope = "user" | "project" | "npm";

export interface HubExtensionItem {
	/** Unique identifier (e.g., name or package id) */
	id: string;
	/** Display name */
	name: string;
	/** Version string */
	version: string;
	/** Available latest version (if update available) */
	latestVersion?: string;
	/** Short description */
	description: string;
	/** Extension tier (badge) */
	tier?: ExtensionTier;
	/** Author or publisher */
	author?: string;
	/** Whether installed locally or in project */
	installed: boolean;
	/** Whether active/enabled */
	enabled: boolean;
	/** Installation scope */
	scope?: ExtensionScope;
	/** Provided capability tags (e.g. ['tool:ruff_check', 'rule:python']) */
	capabilities?: string[];
	/** Shadowed by another version/scope */
	shadowedBy?: string;
	/** Raw manifest or pack object */
	raw?: unknown;
}

export interface HubState {
	activeTab: HubTabId;
	searchQuery: string;
	items: HubExtensionItem[];
	filteredItems: HubExtensionItem[];
	selectedIndex: number;
	selectedItem: HubExtensionItem | null;
	isLoading: boolean;
	statusMessage?: string;
}
