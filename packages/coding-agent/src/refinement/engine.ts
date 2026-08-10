/**
 * Refinement Engine
 *
 * Reviews trajectory and produces refinement decisions.
 */

import { Snowflake } from "@aryee337/aery-utils";
import type {
	RefinementDecision,
	RefinementEvidence,
	RefinementHost,
	RefinementScope,
	RefinementTarget,
	TrajectoryReview,
} from "./types.js";

export class RefinementEngine {
	readonly #host: RefinementHost;

	constructor(host: RefinementHost) {
		this.#host = host;
	}

	/**
	 * Review trajectory and produce decisions.
	 */
	async review(): Promise<TrajectoryReview> {
		const trajectory = await this.#host.getTrajectory();
		const memories = await this.#host.getMemories();
		const prompts = await this.#host.getPrompts();
		const skills = await this.#host.getSkills();

		// Generate decisions based on trajectory analysis
		const decisions: RefinementDecision[] = [];
		const suggestions: string[] = [];

		// Analyze trajectory for refinement opportunities
		const analysis = this.#analyzeTrajectory(trajectory, memories, prompts, skills);
		decisions.push(...analysis.decisions);
		suggestions.push(...analysis.suggestions);

		return {
			summary: this.#generateSummary(trajectory, decisions),
			decisions,
			suggestions,
		};
	}

	/**
	 * Apply refinement decisions.
	 */
	async apply(decisions: RefinementDecision[]): Promise<{ applied: number; failed: number }> {
		let applied = 0;
		let failed = 0;

		for (const decision of decisions) {
			try {
				switch (decision.action) {
					case "create": {
						const id = await this.#host.createArtifact(decision.target, decision.reasoning, decision.scope);
						if (id) applied++;
						else failed++;
						break;
					}
					case "update": {
						if (decision.targetId) {
							const ok = await this.#host.updateArtifact(decision.target, decision.targetId, decision.reasoning);
							if (ok) applied++;
							else failed++;
						} else {
							failed++;
						}
						break;
					}
					case "delete": {
						if (decision.targetId) {
							const ok = await this.#host.deleteArtifact(decision.target, decision.targetId);
							if (ok) applied++;
							else failed++;
						} else {
							failed++;
						}
						break;
					}
					case "keep":
						// No action needed
						break;
				}
			} catch {
				failed++;
			}
		}

		return { applied, failed };
	}

	/**
	 * Analyze trajectory for refinement opportunities.
	 */
	#analyzeTrajectory(
		trajectory: string,
		memories: Array<{ id: string; content: string; scope: RefinementScope }>,
		prompts: Array<{ id: string; content: string; scope: RefinementScope }>,
		skills: Array<{ id: string; content: string; scope: RefinementScope }>,
	): { decisions: RefinementDecision[]; suggestions: string[] } {
		const decisions: RefinementDecision[] = [];
		const suggestions: string[] = [];

		// Simple heuristic analysis - in production, this would use LLM
		const trajectoryLower = trajectory.toLowerCase();

		// Check for recurring patterns
		if (trajectoryLower.includes("error") || trajectoryLower.includes("bug")) {
			suggestions.push("Consider adding error handling to memory");
			decisions.push(
				this.#createDecision(
					"memory",
					undefined,
					"local",
					"create",
					"Add error handling memory based on trajectory",
					[this.#createEvidence("trajectory", "Found error patterns in trajectory")],
				),
			);
		}

		if (trajectoryLower.includes("repeated") || trajectoryLower.includes("again")) {
			suggestions.push("Consider creating a skill for repeated operations");
			decisions.push(
				this.#createDecision("skill", undefined, "global", "create", "Create skill for repeated operations", [
					this.#createEvidence("trajectory", "Found repeated patterns in trajectory"),
				]),
			);
		}

		return { decisions, suggestions };
	}

	/**
	 * Generate summary.
	 */
	#generateSummary(trajectory: string, decisions: RefinementDecision[]): string {
		const stats = {
			memory: decisions.filter(d => d.target === "memory").length,
			prompt: decisions.filter(d => d.target === "prompt").length,
			skill: decisions.filter(d => d.target === "skill").length,
			create: decisions.filter(d => d.action === "create").length,
			update: decisions.filter(d => d.action === "update").length,
			delete: decisions.filter(d => d.action === "delete").length,
		};

		return (
			`Refinement complete: ${decisions.length} decisions made\n` +
			`- Memory: ${stats.memory} (create: ${stats.create}, update: ${stats.update}, delete: ${stats.delete})\n` +
			`- Prompt: ${stats.prompt}\n` +
			`- Skill: ${stats.skill}`
		);
	}

	/**
	 * Create a refinement decision.
	 */
	#createDecision(
		target: RefinementTarget,
		targetId: string | undefined,
		scope: RefinementScope,
		action: "create" | "update" | "delete" | "keep",
		reasoning: string,
		evidence: RefinementEvidence[],
	): RefinementDecision {
		return {
			id: String(Snowflake.next()),
			target,
			targetId,
			scope,
			action,
			reasoning,
			evidence,
			createdAt: Date.now(),
		};
	}

	/**
	 * Create evidence.
	 */
	#createEvidence(source: string, content: string): RefinementEvidence {
		return {
			source,
			content,
			timestamp: Date.now(),
		};
	}
}

/**
 * Create a refinement engine instance.
 */
export function createRefinementEngine(host: RefinementHost): RefinementEngine {
	return new RefinementEngine(host);
}
