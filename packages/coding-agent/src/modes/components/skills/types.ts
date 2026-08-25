export type SkillTabId = "catalog" | "installed";

export interface SkillItem {
	name: string;
	description: string;
	category: string;
	source: string;
	installCmd: string | null;
	installed: boolean;
	filePath?: string;
}

export interface SkillsHubState {
	activeTab: SkillTabId;
	searchQuery: string;
	items: SkillItem[];
	filteredItems: SkillItem[];
	isLoading: boolean;
	statusMessage?: string;
}
