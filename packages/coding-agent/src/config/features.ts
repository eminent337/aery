import { settings as globalSettings, type Settings } from "./settings";

export type FeatureStage = "stable" | "experimental" | "under development" | "deprecated";

export interface FeatureDefinition {
	name: string;
	stage: FeatureStage;
	defaultValue: boolean;
	description: string;
}

export const KNOWN_FEATURES: FeatureDefinition[] = [
	{
		name: "swarm",
		stage: "stable",
		defaultValue: true,
		description: "Native multi-agent blackboard swarm collaboration",
	},
	{
		name: "coordinator_mode",
		stage: "stable",
		defaultValue: true,
		description: "AGY-style subagent delegation for complex work",
	},
	{
		name: "auto_compact",
		stage: "stable",
		defaultValue: true,
		description: "Automated conversation context compaction",
	},
	{
		name: "fast_mode",
		stage: "stable",
		defaultValue: true,
		description: "Priority service tier execution routing",
	},
	{
		name: "plan_mode",
		stage: "stable",
		defaultValue: true,
		description: "Two-phase plan drafting and execution",
	},
	{
		name: "goal_mode",
		stage: "stable",
		defaultValue: true,
		description: "Autonomous goal continuation loop",
	},
	{
		name: "loop_mode",
		stage: "stable",
		defaultValue: true,
		description: "Continuous prompt iteration loop",
	},
	{
		name: "shell_snapshot",
		stage: "stable",
		defaultValue: true,
		description: "Developer shell environment capture",
	},
	{
		name: "progressive_memory",
		stage: "stable",
		defaultValue: true,
		description: "Observation distillation and memory graph recall",
	},
	{
		name: "browser_use",
		stage: "stable",
		defaultValue: true,
		description: "Headless browser automation via CDP",
	},
	{
		name: "code_mode",
		stage: "experimental",
		defaultValue: false,
		description: "Isolated code-mode execution host",
	},
	{
		name: "mcp",
		stage: "stable",
		defaultValue: true,
		description: "Model Context Protocol server integration",
	},
	{
		name: "advisor",
		stage: "stable",
		defaultValue: true,
		description: "Dual-model background review advisor",
	},
	{
		name: "chronicle",
		stage: "under development",
		defaultValue: false,
		description: "Long-term structured execution timeline",
	},
];

export interface FeatureStatus extends FeatureDefinition {
	effective: boolean;
}

export class FeatureManager {
	constructor(private settingsInstance: Settings = globalSettings) {}

	list(): FeatureStatus[] {
		const configured = (this.settingsInstance.get("features") ?? {}) as Record<string, boolean>;
		return KNOWN_FEATURES.map(feat => {
			const effective = configured[feat.name] !== undefined ? configured[feat.name] : feat.defaultValue;
			return {
				...feat,
				effective: Boolean(effective),
			};
		});
	}

	get(name: string): FeatureStatus | undefined {
		return this.list().find(f => f.name === name);
	}

	isEnabled(name: string): boolean {
		const feat = this.get(name);
		return feat ? feat.effective : false;
	}

	async set(name: string, enabled: boolean): Promise<boolean> {
		const known = KNOWN_FEATURES.find(f => f.name === name);
		if (!known) {
			return false;
		}
		const current = ((await this.settingsInstance.get("features")) ?? {}) as Record<string, boolean>;
		const updated = {
			...current,
			[name]: enabled,
		};
		await this.settingsInstance.set("features", updated);
		return true;
	}
}

export const features = new FeatureManager();
