Switch the active model for the current session, by model id, provider/id, or role name.

Use this when you need a different capability tier for the remaining work — e.g. switching to a faster/smaller model for mechanical edits, a stronger model for a hard problem, or the model assigned to a role (default, smol, slow, vision, plan, designer, commit, task, advisor, or a custom role).

- `model`: model id (e.g. `claude-sonnet-4-6`), `provider/id` (e.g. `anthropic/claude-sonnet-4-6`), or a role name to switch to that role's model.
- `role` (optional): persist the assignment under this role so future sessions/role routing use it.
- `persist` (optional): persist the switch to settings. Default false = session-scoped only.

The switch takes effect on the next turn — existing conversation context is preserved. Unknown models are rejected with the list of valid options.
