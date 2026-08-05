Manage and inspect the background advisor (a separate advisory agent that watches the session and provides guidance).

Use this when you want to turn the advisor on or off, check whether it is running, or review what it has said.

- `action` (optional): `enable`, `disable`, `status` (default), or `dump`.
- `compact` (optional): for `dump`, render the transcript compactly instead of the full dump.

The result reports:
- `configured` — whether the `advisor.enabled` setting is on.
- `active` — whether an advisor agent is actually running (it can be inactive even when configured, e.g. no model is assigned to the `advisor` role).
- `status` — a formatted status line with model, context usage, and spend.
- `history` — the advisor transcript (only for `dump`).
