# hello-extension

A minimal `aery` extension that demonstrates the two most common authoring patterns: subscribing to `session_start` to notify on load, and registering a `/hello` slash command that sends a greeting into the conversation. It is intentionally small — use it as a copy-paste starting point for your own extension.

## Install

**Option A — drop into user extensions directory:**

```
cp -r . ~/.aery/agent/extensions/hello-extension
```

Restart `aery`. You will see the startup notification immediately.

**Option B — point the settings `extensions` array at it:**

```yaml
# ~/.aery/agent/config.yml
extensions:
  - /path/to/hello-extension
```

**Option C — load once via CLI flag:**

```
aery --extension ./hello-extension
```

## Usage

After loading, type `/hello` or `/hello Ada` in the aery prompt. The command sends a visible greeting custom message into the conversation and shows a "Message sent!" notification.

## What it demonstrates

- Default export factory receiving `ExtensionAPI`
- `aery.on("session_start", ...)` — session lifecycle hook
- `aery.registerCommand(...)` — slash command registration
- `ctx.ui.notify(...)` — user-facing notification
- `package.json` with `aery.extensions` manifest field
