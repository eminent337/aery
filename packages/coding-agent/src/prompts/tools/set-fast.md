Enable or disable fast mode (the priority service tier), or report the current fast-mode state.

Use this when you want to trade depth for speed on the current model/provider, or to check whether fast mode is actually active.

- `enabled` (optional): set to `true` to enable fast mode, `false` to disable. Omit to report the current state without changing it.

The result reports two things that can differ:
- `Enabled (setting)` — whether the fast-mode setting is on.
- `Active (current model/provider)` — whether the current model's provider actually resolves to the priority tier.

If fast mode is enabled but not active, the provider or model does not support the priority tier for the current selection.
