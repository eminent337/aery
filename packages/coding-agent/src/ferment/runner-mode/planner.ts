/**
 * FasPlanner — builds a Ferment plan by driving the agent to scope and plan.
 *
 * The planner sends a structured prompt to the agent session asking for a JSON plan,
 * then parses the response and constructs a Ferment object.
 */

import * as yaml from "yaml";
import type { AgentSession } from "../../session/agent-session.js";
import { addCard } from "../../task/kanban/board.js";
import type { FermentCommand, ScopePhaseInput } from "../commands.js";
import { applyTransition } from "../state-machine.js";
import { FermentStore } from "../store.js";
import type { Ferment } from "../types.js";

// ─── Planner prompt template ──────────────────────────────────────────────────

const PLANNER_PROMPT = `You are a project planner. Given the goal below, create a structured plan.

Goal: {goal}

If the goal is large, complex, and can be parallelized, generate a Swarm YAML workflow.
Otherwise, produce a standard linear plan in JSON.

OPTION 1: Standard Linear Plan (JSON)
Produce STRICT JSON in this format (no markdown code blocks):
{{
  "title": "...",
  "goal": "...",
  "successCriteria": "...",
  "constraints": "...",
  "phases": [
    {{
      "name": "Phase name",
      "goal": "Phase goal",
      "steps": [
        {{ "description": "Step description", "verification": {{ "command": "bash command to verify" }} }}
      ]
    }}
  ]
}}

OPTION 2: Swarm Workflow (YAML)
Output a STRICT YAML block (wrapped in \`\`\`yaml) that defines a Swarm workflow. The workflow should break the goal down into parallelizable tasks.
\`\`\`yaml
name: Workflow name
maxConcurrency: 3
tasks:
  - id: step1
    agent: coder
    assignment: "..."
  - id: step2
    agent: coder
    assignment: "..."
    needs: [step1]
\`\`\`
`;

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface PlannerConfig {
	goal: string;
	modelProvider?: string;
	thinkingLevel?: string;
	onProgress?: (msg: string) => void;
}

export interface PlannedPhase {
	name: string;
	goal: string;
	steps: Array<{
		description: string;
		verification?: { command: string };
	}>;
}

export interface PlanOutput {
	title: string;
	goal: string;
	successCriteria: string;
	constraints: string;
	phases: PlannedPhase[];
}

export type PlanExtraction = { type: "linear"; plan: PlanOutput };

// ─── JSON parsing helpers ─────────────────────────────────────────────────────

/**
 * Strip markdown code block wrappers (e.g., ```json ... ```) from text.
 */
function stripMarkdownJson(text: string): string {
	// Remove triple-backtick blocks with optional language tag
	const tripleBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (tripleBlock) {
		return tripleBlock[1].trim();
	}
	// Remove single backtick code spans
	const singleBlock = text.match(/`([^`]+)`/);
	if (singleBlock) {
		return singleBlock[1].trim();
	}
	return text.trim();
}

/**
 * Extract JSON or YAML from agent response text.
 */
function extractPlan(text: string): PlanExtraction {
	const stripped = stripMarkdownJson(text);
	// Try to find JSON object in the text
	const jsonMatch = stripped.match(/\{[\s\S]*\}/);
	if (!jsonMatch) {
		throw new Error(`No JSON or YAML found in response:\n${text.slice(0, 500)}`);
	}
	try {
		return { type: "linear", plan: JSON.parse(jsonMatch[0]) as PlanOutput };
	} catch {
		throw new Error(`Failed to parse JSON from response:\n${jsonMatch[0].slice(0, 500)}`);
	}
}

// ─── Ferment builder ─────────────────────────────────────────────────────────

function generateId(): string {
	return `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildInitialFerment(config: PlannerConfig): Ferment {
	const now = new Date().toISOString();
	return {
		id: generateId(),
		name: config.goal.slice(0, 60),
		status: "draft",
		goal: config.goal,
		successCriteria: [],
		constraints: [],
		worktree: { path: process.cwd() },
		scoping: {},
		phases: [],
		decisions: [],
		memories: [],
		createdAt: now,
		updatedAt: now,
	};
}

function buildScopePhases(phases: PlannedPhase[]): ScopePhaseInput[] {
	return phases.map(p => ({
		name: p.name,
		goal: p.goal,
		steps: p.steps.map(s => ({
			description: s.description,
			verify: s.verification?.command,
		})),
	}));
}

// ─── FasPlanner ──────────────────────────────────────────────────────────────

export class FasPlanner {
	#session: AgentSession;
	#config: PlannerConfig;

	constructor(session: AgentSession, config: PlannerConfig) {
		this.#session = session;
		this.#config = config;
	}

	/**
	 * Drive the agent to scope and plan a new ferment.
	 * Sends a structured prompt, parses the JSON or YAML response, builds a Ferment or SwarmWorkflow,
	 * and applies the scope transition to move it to "planned" status.
	 */
	async create(): Promise<Ferment> {
		this.#config.onProgress?.("Starting planner: scoping goal...");

		// Build the planner prompt with the goal
		const promptText = PLANNER_PROMPT.replace("{goal}", this.#config.goal);

		// Send prompt to the agent. The agent will produce a JSON plan.
		// We use synthetic=true so it's treated as a system/developer message.
		await this.#session.prompt(promptText, { synthetic: true });

		this.#config.onProgress?.("Parsing agent response...");

		// After prompt resolves, we need to get the agent's text response.
		// The session stores messages internally; we access via the session's
		// getLastAssistantMessage() method if available, or fall back to a
		// tool-based approach.
		const responseText = this.#getAgentResponseText();

		let extraction: PlanExtraction;
		try {
			extraction = extractPlan(responseText);
		} catch (err) {
			throw new Error(
				`Failed to parse plan from agent response. ${err instanceof Error ? err.message : String(err)}\n\nRaw response:\n${responseText.slice(0, 1000)}`,
			);
		}

		if (extraction.type === "swarm") {
			this.#config.onProgress?.(`Swarm workflow received: ${extraction.workflow.tasks?.length ?? 0} tasks.`);
			return extraction;
		}

		const plan = extraction.plan;
		this.#config.onProgress?.(`Plan received: ${plan.phases.length} phases.`);

		// Build initial draft ferment
		const ferment = buildInitialFerment(this.#config);
		ferment.name = plan.title || ferment.name;

		// Build scope phases for the transition
		const scopePhases = buildScopePhases(plan.phases);

		// Apply scope transition to move from draft → planned
		const scopeCmd: Extract<FermentCommand, { type: "scope" }> = {
			type: "scope",
			title: plan.title,
			goal: plan.goal,
			successCriteria: plan.successCriteria
				? plan.successCriteria.split("\n").filter((s: string) => s.trim())
				: undefined,
			constraints: plan.constraints ? plan.constraints.split("\n").filter((s: string) => s.trim()) : undefined,
			phases: scopePhases,
		};

		const result = applyTransition(ferment, scopeCmd);
		if ("error" in result) {
			throw new Error(`Scope transition failed: ${result.error}`);
		}

		// Persist the scoped ferment
		const store = FermentStore.open();
		store.save(result);

		// Add kanban cards for all newly planned steps
		for (const phase of result.phases) {
			for (const step of phase.steps) {
				addCard(`[${phase.name}] ${step.description}`, step.id);
			}
		}

		this.#config.onProgress?.(`Ferment "${result.name}" created with ${result.phases.length} phases.`);

		return result;
	}

	/**
	 * Load a persisted ferment by its ID.
	 */
	async load(fermentId: string): Promise<Ferment | null> {
		const store = FermentStore.open();
		const ferment = store.get(fermentId);
		return ferment as Ferment | null;
	}

	/**
	 * Extract the agent's text response after a prompt was sent.
	 * Uses the session's internal message history to retrieve the last
	 * assistant message content.
	 */
	#getAgentResponseText(): string {
		// Access the session's message history via the agent's state.
		// The agent stores messages in its state.messageHistory.
		const messages = (this.#session.agent as unknown as { state: { messageHistory: unknown[] } }).state
			.messageHistory as Array<{ role: string; content: unknown }>;
		if (!messages || messages.length === 0) {
			return "";
		}
		// Find the last assistant message
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				if (typeof msg.content === "string") {
					return msg.content;
				}
				// Handle content blocks (array format)
				if (Array.isArray(msg.content)) {
					return msg.content
						.map(block => (typeof block === "string" ? block : ((block as { text?: string }).text ?? "")))
						.join("");
				}
			}
		}
		return "";
	}
}
