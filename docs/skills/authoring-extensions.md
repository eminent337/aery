---
name: authoring-extensions
description: Use when creating a new aery extension. Covers ExtensionAPI, factory signature, tool/command/event registration, and local-dev testing.
---

# Authoring Extensions

Extensions are the primary way to add capabilities to `aery`. A single extension module can register tools the LLM can call, slash commands users can invoke, and event handlers that run throughout the session lifecycle — all from one TypeScript file.

## Minimum viable extension

```ts
import type { ExtensionAPI } from "@aryee337/aery-coding-agent";

export default function (aery: ExtensionAPI) {
  aery.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("My extension loaded!", "info");
  });
}
```

That is a working extension. Drop it into `~/.aery/agent/extensions/hello.ts` and restart aery to see the notification.

## Full example

The following extension registers a slash command, a tool, and a session-start hook:

```ts
import type { ExtensionAPI } from "@aryee337/aery-coding-agent";

export default function myExtension(aery: ExtensionAPI) {
  const z = aery.zod;

  // Runs once when the session loads
  aery.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(`Session ready in ${ctx.cwd}`, "info");
  });

  // Slash command: /greet
  aery.registerCommand("greet", {
    description: "Send a greeting into the conversation",
    handler: async (args, ctx) => {
      const name = args.trim() || "world";
      aery.sendMessage(
        {
          customType: "greeting",
          content: `Hello, ${name}!`,
          display: true,
          attribution: "user",
        },
        { triggerTurn: false }
      );
      ctx.ui.notify(`Greeted ${name}`, "info");
    },
  });

  // LLM-callable tool
  aery.registerTool({
    name: "word_count",
    label: "Word Count",
    description: "Count the words in a string",
    parameters: z.object({
      text: z.string().describe("Text to count"),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const count = params.text.split(/\s+/).filter(Boolean).length;
      return {
        content: [{ type: "text", text: String(count) }],
        details: { count },
      };
    },
  });
}
```

## Discovery paths

aery loads extension modules from these sources:

1. Native `.aery` locations discovered through the capability system:
   - `<cwd>/.aery/extensions/`
   - `~/.aery/agent/extensions/`
   - legacy extension paths listed in `.aery/settings.json#extensions` or `~/.aery/agent/settings.json#extensions`
2. Marketplace-installed plugins from the AERY and Claude plugin registries.
3. Explicit configured paths passed by the CLI (`aery --extension ./my-ext.ts`, also `-e`; `--hook` is treated as an alias) and by the `extensions:` setting in config.

The runtime de-duplicates by resolved absolute path — first seen wins.

When a path points to a directory, aery resolves the entry point in this order:

1. `package.json` with `aery.extensions` (or legacy `aery.extensions`) field
2. `index.ts`
3. `index.js`

When scanning an `extensions/` directory, aery also loads direct `*.ts`/`*.js` files and one-level subdirectories that have `index.ts`, `index.js`, or a manifest.

Extension packages can also bundle sibling capability directories. When a package is loaded through `extensions:` or `--extension`/`-e`, the `aery-plugins` provider discovers its `skills/`, `hooks/pre|post/`, `tools/`, `commands/`, `rules/`, `prompts/`, and `.mcp.json`.

## package.json manifest

To package an extension as an installable plugin, add an `aery` field to `package.json`:

```json
{
  "name": "my-aery-extension",
  "aery": {
    "extensions": ["./src/main.ts"]
  }
}
```

The legacy `aery` key is also accepted for backwards compatibility:

```json
{
  "aery": {
    "extensions": ["./index.ts"]
  }
}
```

Multiple entry points are supported:

```json
{
  "aery": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

## Registering commands

```ts
aery.registerCommand("my-cmd", {
  description: "What the command does",
  handler: async (args, ctx) => {
    // args: everything the user typed after /my-cmd
    // ctx: ExtensionCommandContext — includes ctx.ui, ctx.cwd, session controls
    ctx.ui.notify("Running!", "info");
    await ctx.waitForIdle();
    await ctx.newSession();
  },
});
```

`ExtensionCommandContext` session-control methods (safe to call from commands only):

| Method | Effect |
|---|---|
| `waitForIdle()` | Wait for the agent to finish streaming |
| `newSession(opts?)` | Open a fresh session |
| `switchSession(path)` | Switch to an existing session file |
| `branch(entryId)` | Fork from a specific history entry |
| `navigateTree(id, opts?)` | Jump to a different point in the session tree |
| `reload()` | Reload the session runtime |
| `compact(opts?)` | Compact the current context |

## Registering tools

Tools are called by the LLM. Parameters use [Zod](https://zod.dev) schemas, available at `aery.zod`:

```ts
const z = aery.zod;

aery.registerTool({
  name: "search_notes",           // snake_case, unique
  label: "Search Notes",          // human-readable label for TUI
  description: "Full-text search through project notes",
  parameters: z.object({
    query: z.string().describe("Search query"),
    limit: z.number().default(10).describe("Max results").optional(),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }] };
    }
    onUpdate?.({ content: [{ type: "text", text: "Searching..." }] });
    // ... do work ...
    return {
      content: [{ type: "text", text: `Found N results for "${params.query}"` }],
      details: { query: params.query, count: 0 },
    };
  },
});
```

## Subscribing to events

```ts
aery.on("tool_call", async (event, ctx) => {
  // event.toolName, event.input, event.toolCallId
  if (event.toolName !== "bash") return;

  const command = String((event.input as { command?: unknown }).command ?? "");
  if (command.includes("rm -rf /")) {
    return { block: true, reason: "Blocked by safety policy" };
  }
});

aery.on("turn_end", async (_event, ctx) => {
  ctx.ui.setStatus("tokens", `~${ctx.getContextUsage()?.tokens ?? "?"} tokens`);
});
```

Full event catalog: see [hooks authoring guide](./authoring-hooks.md).

## Extension vs hook — when to use which

| Need | Use |
|---|---|
| Tools + commands + events in one module | **Extension** (`ExtensionAPI`) |
| Pure event interception (policy, redaction) | **Extension** or **Hook** (both work; extension is preferred) |
| Legacy hook module already exists | **Hook** (`HookAPI` from `@aryee337/aery-coding-agent/extensibility/hooks`) |
| Registering provider / custom message renderer | **Extension only** |
| Shipping as a marketplace plugin | **Extension** (use `package.json` manifest) |

Extensions are a strict superset of hooks. New authoring should use `ExtensionAPI`.

## Debugging

Start aery with `--log-level debug` to see extension load diagnostics:

```
aery --log-level debug
```

Failed extension loads are logged with their path and error. Loaded extensions may also emit their own debug logs via `aery.logger`.

To temporarily disable a specific extension module by name without removing the file:

```yaml
# ~/.aery/agent/config.yml
disabledExtensions:
  - extension-module:my-ext
```

The derived name is the filename stem (or directory name for `index.ts`-style entries): `/path/to/my-ext.ts` → `my-ext`.

## Important constraints

- **Do not call runtime actions during load.** Methods like `aery.sendMessage()` throw `ExtensionRuntimeNotInitializedError` if called synchronously during module evaluation (before a session is active). Register handlers/tools/commands during load; perform runtime actions only from event handlers, tools, or commands.
- **`tool_call` errors are fail-closed.** If a `tool_call` handler throws, the tool is blocked.
- **Command names must not clash with built-ins.** Conflicts are skipped with a diagnostic log.
- **Reserved shortcuts are ignored** (`ctrl+c`, `ctrl+d`, `ctrl+z`, `ctrl+k`, `ctrl+p`, `ctrl+l`, `ctrl+o`, `ctrl+t`, `ctrl+g`, `shift+tab`, `shift+ctrl+p`, `alt+enter`, `escape`, `enter`).

## Further reading

- `docs/extensions.md` — runtime internals and full API surface reference
- `docs/extension-loading.md` — detailed path resolution rules
- `docs/hooks.md` — hook subsystem internals
- `docs/skills/examples/hello-extension/` — complete working example
