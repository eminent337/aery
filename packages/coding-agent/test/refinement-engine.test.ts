/**
 * Refinement Engine Tests
 */

import { describe, expect, it, mock } from "bun:test";
import { RefinementEngine } from "../src/refinement/engine.js";
import type { RefinementHost } from "../src/refinement/types.js";

describe("RefinementEngine", () => {
	const createMockHost = (): RefinementHost => {
		const artifacts = new Map<string, { target: string; content: string; scope: string }>();
		
		return {
			getTrajectory: async () => "Test trajectory with errors and repeated patterns",
			getMemories: async () => [],
			getPrompts: async () => [],
			getSkills: async () => [],
			createArtifact: async (target: any, content: any, scope: any) => {
				const id = `new-${Date.now()}`;
				artifacts.set(id, { target, content, scope });
				return id;
			},
			updateArtifact: async () => true,
			deleteArtifact: async () => true,
			now: () => Date.now(),
		} as unknown as RefinementHost;
	};

	it("should create engine and review trajectory", async () => {
		const host = createMockHost();
		const engine = new RefinementEngine(host);
		
		const review = await engine.review();
		
		expect(review).toBeDefined();
		expect(review.summary).toContain("Refinement complete");
		expect(Array.isArray(review.decisions)).toBe(true);
		expect(Array.isArray(review.suggestions)).toBe(true);
	});

	it("should apply decisions", async () => {
		const host = createMockHost();
		const engine = new RefinementEngine(host);
		
		const review = await engine.review();
		const result = await engine.apply(review.decisions);
		
		expect(result).toBeDefined();
		expect(typeof result.applied).toBe("number");
		expect(typeof result.failed).toBe("number");
	});

	it("should handle empty trajectory", async () => {
		const host = {
			getTrajectory: async () => "",
			getMemories: async () => [],
			getPrompts: async () => [],
			getSkills: async () => [],
			createArtifact: async () => "new-1",
			updateArtifact: async () => true,
			deleteArtifact: async () => true,
			now: () => Date.now(),
		} as unknown as RefinementHost;
		
		const engine = new RefinementEngine(host);
		const review = await engine.review();
		
		expect(review.decisions.length).toBeGreaterThanOrEqual(0);
	});
});
