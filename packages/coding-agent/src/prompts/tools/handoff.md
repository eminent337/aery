Generate a handoff document from the current session and start a fresh session with it as context.

Use this when handing work to a successor: the current task is complete or you are yielding to a different agent/persona, and the next session needs a concise summary of context, decisions, open questions, and next steps.

WARNING — destructive: this starts a new session and resets the agent. It is permission-gated and will prompt for approval.

- `customInstructions` (required): what the next session should know — context, decisions made, open questions, and concrete next steps.
- `autoTriggered` (optional): internal maintenance flows only; leave unset for normal use.

The tool refuses when:
- a handoff is already generating;
- the session has fewer than 2 messages (nothing to hand off);
- a handoff was just completed with no new work since (prevents loop).
