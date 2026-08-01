import * as crypto from "node:crypto";
import { $ } from "bun";
import * as _cronParser from "cron-parser";

const cronParser = _cronParser as any;

import { discoverAgents, getAgent } from "../discovery";
import { runSubprocessWithQa } from "../executor";
import type { ScheduledRun } from "./types";

export class AgentScheduler {
	private schedules: Map<string, ScheduledRun> = new Map();
	private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();

	public getSchedules(): ScheduledRun[] {
		return Array.from(this.schedules.values());
	}

	public getSchedule(id: string): ScheduledRun | undefined {
		return this.schedules.get(id);
	}

	public createSchedule(params: { name: string; cronPattern: string; prompt: string; agent?: string }): ScheduledRun {
		const id = crypto.randomUUID().slice(0, 8);
		const run: ScheduledRun = {
			id,
			...params,
			enabled: true,
			createdAt: Date.now(),
		};
		this.schedules.set(id, run);
		this.scheduleNextRun(id);
		return run;
	}

	public deleteSchedule(id: string): boolean {
		this.cancelTimer(id);
		return this.schedules.delete(id);
	}

	public pauseSchedule(id: string): ScheduledRun | undefined {
		const run = this.schedules.get(id);
		if (run) {
			run.enabled = false;
			this.cancelTimer(id);
		}
		return run;
	}

	public resumeSchedule(id: string): ScheduledRun | undefined {
		const run = this.schedules.get(id);
		if (run) {
			run.enabled = true;
			this.scheduleNextRun(id);
		}
		return run;
	}

	public async triggerSchedule(id: string, ctx: any): Promise<boolean> {
		const run = this.schedules.get(id);
		if (!run) return false;

		run.lastRunAt = Date.now();

		// Run as a background task via Aery's subprocess executor
		// We avoid awaiting it fully so it runs in the background
		void this.executeAgentTask(run, ctx).catch(err => {
			console.error(`Error running scheduled task ${id}:`, err);
		});

		return true;
	}

	private scheduleNextRun(id: string) {
		this.cancelTimer(id);
		const run = this.schedules.get(id);
		if (!run || !run.enabled) return;

		try {
			const interval = cronParser.parseExpression(run.cronPattern);
			const next = interval.next().getTime();
			run.nextRunAt = next;

			const delay = next - Date.now();
			if (delay > 0) {
				const timerId = setTimeout(() => {
					// We need the ctx to execute it, but we don't have it globally here.
					// We'll dispatch a custom event on the global object or expect the caller to trigger.
					// For now, we'll store a global ctx reference when the scheduler is accessed.
					const globalCtx = (globalThis as any).__aery_ctx;
					if (globalCtx) {
						this.triggerSchedule(id, globalCtx);
						this.scheduleNextRun(id); // schedule the next one
					}
				}, delay);
				this.timers.set(id, timerId);
			}
		} catch (err) {
			console.error(`Invalid cron pattern for ${id}: ${run.cronPattern}`, err);
			run.enabled = false;
		}
	}

	private cancelTimer(id: string) {
		const timer = this.timers.get(id);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(id);
		}
	}

	private async executeAgentTask(run: ScheduledRun, ctx: any): Promise<void> {
		const repoRoot = ctx.sessionManager.getCwd();
		const { agents } = await discoverAgents(repoRoot);

		let defaultBranch = "main";
		try {
			const result = await $`git -C ${repoRoot} symbolic-ref --short HEAD`.quiet();
			defaultBranch = result.stdout.toString().trim() || "main";
		} catch {
			// fallback
		}

		const branchName = `aery/schedule/${run.id}-${Date.now()}`;
		await $`git -C ${repoRoot} branch ${branchName} ${defaultBranch}`.quiet();

		const agentDef = getAgent(agents, run.agent ?? "task") ?? getAgent(agents, "task")!;

		const executorOpts = {
			cwd: repoRoot,
			agent: agentDef,
			task: run.prompt,
			assignment: run.prompt,
			index: 0,
			id: run.id,
			settings: ctx.settings,
			modelRegistry: ctx.session.modelRegistry,
		};

		await runSubprocessWithQa(executorOpts as any, agents, run.prompt);
	}
}

export const globalScheduler = new AgentScheduler();
