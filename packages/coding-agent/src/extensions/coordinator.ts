/**
 * Coordinator Mode Extension
 *
 * Injects a system prompt supplement that guides the agent to work as a
 * coordinator when parallel delegation would be beneficial.
 *
 * The prompt is always available but only suggests delegation for tasks
 * that benefit from parallel execution. Simple tasks are handled inline.
 */

import type { BeforeAgentStartEventResult, ExtensionAPI } from "../extensibility/extensions/types";

const COORDINATOR_PROMPT = `## Parallel Delegation

You have access to background subagent delegation via \`invoke_subagent\`. Use it when parallel execution saves time:

**Delegate when:**
- Researching multiple independent areas simultaneously
- Code review needs multiple perspectives (use reviewer agent)
- Large refactors where different files can be modified concurrently
- Test writing across independent modules
- Any task with clearly independent subtasks

**Don't delegate when:**
- Task is simple and fast (under 30 seconds)
- Subtasks have dependencies (must be sequential)
- Only one subtask exists

**How:**
1. Call \`invoke_subagent\` with clear, self-contained prompts for each subtask
2. Continue your own work while subagents run
3. Results arrive automatically as system-notice messages
4. Use \`job\` to poll status or cancel if needed

**Agent types:** task (general), explore (read-only scout), reviewer (code review), designer (UI/UX), librarian (research), oracle (senior engineer), plan (architect), quick_task (mechanical)

### Tool Usage Reference (IMPORTANT — follow this exactly)

| Tool | Schema | Example |
|------|--------|---------|
| \`invoke_subagent\` | \`Subagents: [{Role, Prompt}]\` | \`Subagents: [{Role: "explore", Prompt: "find X"}]\` |
| \`task\` | \`tasks: [{agent, assignment}]\` | \`tasks: [{agent: "explore", assignment: "find X"}]\` |
| \`job\` | \`poll: [id] or cancel: [id] or list: true\` | \`job({poll: ["subagent:explore-1"]})\` |
| \`irc\` | \`op: "send", to: "id", message: "..."\` or \`op: "list"\` | \`irc({op: "send", to: "subagent:explore-1", message: "status?"})\` |

**Common mistakes to avoid:**
- \`task(agent: "explore", prompt: "...")\` — WRONG. \`task\` requires \`tasks: [{agent, assignment}]\` array, not individual parameters.
- \`invoke_subagent(Role: "...", Prompt: "...")\` — WRONG. Must be \`Subagents: [{Role, Prompt}]\` array.
- Mixing up \`task\` and \`invoke_subagent\` schemas — they have different parameter names and shapes.
- Sending IRC to an agent that hasn't finished — check with \`job({list: true})\` first.

**When to use which:**
- \`invoke_subagent\` — background execution, results arrive as system-notice. Use for most delegation.
- \`task\` — batch launcher, expects \`tasks\` array. Same effect but different schema.
- \`irc\` — live messaging to running agents mid-task. Use for follow-up questions or coordination.
- \`job\` — poll/cancel background jobs. Use to check status or kill stalled jobs.`;

export function createCoordinatorExtension() {
	return function coordinatorExtension(api: ExtensionAPI): void {
		api.on("before_agent_start", async (): Promise<BeforeAgentStartEventResult | undefined> => {
			return { systemPrompt: [COORDINATOR_PROMPT] };
		});
	};
}
