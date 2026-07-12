import { describe, expect, it } from "bun:test";
import { parseSwarmYaml } from "../../src/task/swarm/parser";
import { SwarmScheduler, topologicalSort } from "../../src/task/swarm/scheduler";
import type { SwarmTask } from "../../src/task/swarm/types";

describe("Swarm Custom YAML Parser", () => {
	it("parses name, concurrency, and tasks correctly", () => {
		const yamlContent = `
name: "Pipeline Test"
maxConcurrency: 5
tasks:
  - id: "taskA"
    agent: "explore"
    assignment: "Do analysis"
  - id: "taskB"
    agent: "task"
    assignment: "Refactor code"
    needs: ["taskA"]
`;
		const workflow = parseSwarmYaml(yamlContent);
		expect(workflow.name).toBe("Pipeline Test");
		expect(workflow.maxConcurrency).toBe(5);
		expect(workflow.tasks.length).toBe(2);
		expect(workflow.tasks[0].id).toBe("taskA");
		expect(workflow.tasks[1].needs).toEqual(["taskA"]);
	});
});

describe("Swarm DAG Topological Sort", () => {
	it("sorts linear dependencies correctly", () => {
		const tasks: SwarmTask[] = [
			{ id: "taskC", agent: "task", assignment: "C", needs: ["taskB"] },
			{ id: "taskA", agent: "task", assignment: "A" },
			{ id: "taskB", agent: "task", assignment: "B", needs: ["taskA"] },
		];
		const sorted = topologicalSort(tasks);
		expect(sorted.map(t => t.id)).toEqual(["taskA", "taskB", "taskC"]);
	});

	it("throws error on circular dependency", () => {
		const tasks: SwarmTask[] = [
			{ id: "taskA", agent: "task", assignment: "A", needs: ["taskB"] },
			{ id: "taskB", agent: "task", assignment: "B", needs: ["taskA"] },
		];
		expect(() => topologicalSort(tasks)).toThrow("Circular dependency detected");
	});
});

describe("SwarmScheduler States & Constructor", () => {
	it("initializes states for all workflow tasks with pending status", () => {
		const workflow = {
			name: "Test",
			tasks: [
				{ id: "taskA", agent: "task", assignment: "A", maxRetries: 3 },
				{ id: "taskB", agent: "task", assignment: "B", needs: ["taskA"] },
			],
		};
		const scheduler = new SwarmScheduler(workflow);
		expect(scheduler.taskStates.size).toBe(2);
		expect(scheduler.taskStates.get("taskA")).toEqual({
			id: "taskA",
			status: "pending",
			attempts: 0,
			maxRetries: 3,
		});
		expect(scheduler.taskStates.get("taskB")).toEqual({
			id: "taskB",
			status: "pending",
			attempts: 0,
			maxRetries: 0,
		});
	});
});
