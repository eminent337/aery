import { $ } from "bun";
import { discoverAgents, getAgent } from "../discovery";
import { runSubprocessWithQa } from "../executor";
import { Semaphore } from "../parallel";
import type { SwarmTask, SwarmWorkflow } from "./types";

export function topologicalSort(tasks: SwarmTask[]): SwarmTask[] {
	const graph = new Map<string, string[]>();
	const inDegree = new Map<string, number>();
	const taskMap = new Map<string, SwarmTask>();

	for (const t of tasks) {
		taskMap.set(t.id, t);
		inDegree.set(t.id, 0);
		graph.set(t.id, []);
	}

	for (const t of tasks) {
		for (const need of t.needs ?? []) {
			if (!taskMap.has(need)) {
				throw new Error(`Prerequisite "${need}" for task "${t.id}" does not exist`);
			}
			graph.get(need)!.push(t.id);
			inDegree.set(t.id, inDegree.get(t.id)! + 1);
		}
	}

	const queue: string[] = [];
	for (const [id, deg] of inDegree.entries()) {
		if (deg === 0) queue.push(id);
	}

	const result: SwarmTask[] = [];
	while (queue.length > 0) {
		const curr = queue.shift()!;
		result.push(taskMap.get(curr)!);

		for (const neighbor of graph.get(curr)!) {
			inDegree.set(neighbor, inDegree.get(neighbor)! - 1);
			if (inDegree.get(neighbor) === 0) {
				queue.push(neighbor);
			}
		}
	}

	if (result.length !== tasks.length) {
		throw new Error("Circular dependency detected in Swarm Workflow!");
	}

	return result;
}

export class SwarmScheduler {
	#workflow: SwarmWorkflow;
	#sem: Semaphore;
	#completedBranches = new Map<string, string>(); // taskId -> branchName

	constructor(workflow: SwarmWorkflow) {
		this.#workflow = workflow;
		this.#sem = new Semaphore(workflow.maxConcurrency ?? 3);
	}

	async execute(session: any): Promise<void> {
		const tasks = topologicalSort(this.#workflow.tasks);
		const tasksMap = new Map<string, SwarmTask>();
		const inDegree = new Map<string, number>();
		const graph = new Map<string, string[]>();

		for (const t of tasks) {
			tasksMap.set(t.id, t);
			inDegree.set(t.id, (t.needs ?? []).length);
			graph.set(t.id, []);
		}

		for (const t of tasks) {
			for (const need of t.needs ?? []) {
				graph.get(need)!.push(t.id);
			}
		}

		const activePromises: Promise<void>[] = [];
		const queue: string[] = [];
		for (const [id, deg] of inDegree.entries()) {
			if (deg === 0) queue.push(id);
		}

		const runNode = async (taskId: string) => {
			const task = tasksMap.get(taskId)!;
			await this.#sem.acquire();
			try {
				const repoRoot = session.cwd;
				let parentBranch: string | undefined;

				// Resolve baseline branch based on dependencies
				if (task.needs && task.needs.length > 0) {
					if (task.needs.length === 1) {
						parentBranch = this.#completedBranches.get(task.needs[0]);
					} else {
						// Merge multiple parent branches
						parentBranch = `aery/task/merged-${task.id}`;
						const firstParent = this.#completedBranches.get(task.needs[0])!;
						await $`git -C ${repoRoot} branch ${parentBranch} ${firstParent}`.quiet();
						for (let i = 1; i < task.needs.length; i++) {
							const otherParent = this.#completedBranches.get(task.needs[i])!;
							await $`git -C ${repoRoot} merge ${otherParent} --no-edit`.quiet();
						}
					}
				}

				// Create isolated worktree branch
				const branchName = `aery/task/${task.id}`;
				const startPoint = parentBranch ?? "main";
				await $`git -C ${repoRoot} branch ${branchName} ${startPoint}`.quiet();

				// Setup isolated worktree directory
				const worktreePath = `${repoRoot}/.aery/worktrees/${task.id}`;
				if (parentBranch) {
					await $`git -C ${repoRoot} worktree add ${worktreePath} ${branchName}`.quiet();
				}

				// Resolve agent definition
				const { agents } = await discoverAgents(session.cwd);
				const agentDef = getAgent(agents, task.agent) ?? getAgent(agents, "task")!;

				const executorOpts = {
					cwd: session.cwd,
					agent: agentDef,
					task: task.assignment,
					assignment: task.assignment,
					index: 0,
					id: task.id,
					worktree: parentBranch ? worktreePath : undefined,
				};

				const result = await runSubprocessWithQa(executorOpts as any, agents, task.assignment);
				if (result.exitCode !== 0 || result.aborted) {
					throw new Error(`Task ${task.id} failed.`);
				}

				this.#completedBranches.set(task.id, branchName);

				// Unblock downstream nodes
				for (const neighbor of graph.get(task.id)!) {
					inDegree.set(neighbor, inDegree.get(neighbor)! - 1);
					if (inDegree.get(neighbor) === 0) {
						void runNode(neighbor);
					}
				}
			} finally {
				this.#sem.release();
			}
		};

		// Start execution
		for (const rootId of queue) {
			activePromises.push(runNode(rootId));
		}

		await Promise.all(activePromises);
	}
}
