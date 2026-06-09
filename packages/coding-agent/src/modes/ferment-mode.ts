import { logger } from "@aryee337/aery-utils";
import { FasEngine } from "../ferment/runner-mode/engine.js";
import { FasPlanner, type PlannerConfig } from "../ferment/runner-mode/planner.js";
import { FasRunner } from "../ferment/runner-mode/runner.js";
import { FasState } from "../ferment/runner-mode/state.js";
import type { AgentSession } from "../session/agent-session";

export interface FermentModeOptions {
	goal: string;
	modelProvider?: string;
	thinkingLevel?: string;
}

export async function runFermentMode(session: AgentSession, options: FermentModeOptions): Promise<void> {
	logger.info("Ferment mode", { goal: options.goal });

	const config: PlannerConfig = {
		goal: options.goal,
		modelProvider: options.modelProvider,
		thinkingLevel: options.thinkingLevel,
		onProgress: (msg: string) => logger.info("Ferment", { msg }),
	};

	const planner = new FasPlanner(session, config);
	const state = new FasState();
	const engine = new FasEngine({ id: "init", status: "draft" } as any);
	const runner = new FasRunner({ session, state, engine, planner });

	const ferment = await runner.run(options.goal);

	logger.info("Ferment complete", {
		id: ferment.id,
		name: ferment.name,
		status: ferment.status,
		grade: ferment.grade,
		phases: ferment.phases.length,
	});

	// Print final summary to stdout
	if (ferment.grade) {
		process.stdout.write(`\nGrade: ${ferment.grade}\n`);
	}
	const summaries = ferment.phases.map(p => p.summary).filter(Boolean);
	if (summaries.length > 0) {
		process.stdout.write(`Summary: ${summaries.join(" → ")}\n`);
	}
}
