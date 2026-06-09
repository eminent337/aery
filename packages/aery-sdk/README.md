# @aryee337/aery-sdk

> **Official Plugin SDK for the Aery OS** — build extensions, custom tools, slash commands, and swarm-aware agents with full TypeScript support.

[![npm](https://img.shields.io/npm/v/@aryee337/aery-sdk)](https://www.npmjs.com/package/@aryee337/aery-sdk)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![bun](https://img.shields.io/badge/bun-%3E%3D1.3.14-orange)](https://bun.sh)

---

## What is `@aryee337/aery-sdk`?

`@aryee337/aery-sdk` is the official TypeScript SDK for building first- and third-party extensions that run inside the **Aery** AI OS. It is the official SDK for building Aery-native extensions.

With the SDK you can:

- 🔧 **Register agent tools** — give the agent new capabilities it can invoke autonomously
- 💬 **Register slash commands** — add `/my-command` entries to the user's command palette
- 📡 **Subscribe to lifecycle events** — react to session starts, turns, tool calls, and more
- 🤖 **Participate in agent swarms** — send and receive messages between coordinated agents
- 🐚 **Execute shell commands** — with timeout control and working directory support

---

## Installation

```sh
bun add @aryee337/aery-sdk
```

> **Bun ≥ 1.3.14** is required.

---

## Quick Start — Basic Extension

```ts
// my-extension/index.ts
import type { AeryExtension } from "@aryee337/aery-sdk";
import { defineTool, parseArgs } from "@aryee337/aery-sdk";

const extension: AeryExtension = async (api) => {
  // ── Lifecycle events ──────────────────────────────────────────────────────
  api.on("session_start", () => {
    api.sendUserMessage("👋 **my-extension** is loaded and ready.");
  });

  api.on("turn_end", (event) => {
    console.log(`[my-extension] Turn ended in session ${event.sessionId}`);
  });

  // ── Custom tool ───────────────────────────────────────────────────────────
  api.registerTool(
    defineTool({
      name: "word_count",
      description: "Count the number of words in a given string.",
      parameters: {
        text: {
          type: "string",
          description: "The text to count words in.",
          required: true,
        },
      },
      isReadOnly: true,
      execute: async ({ text }) => ({
        content: `${String(text).trim().split(/\s+/).length} words`,
      }),
    }),
  );

  // ── Slash command ─────────────────────────────────────────────────────────
  api.registerCommand("greet", {
    description: "Send a greeting from my-extension",
    handler: (args) => {
      const { flags } = parseArgs(args);
      const name = typeof flags.name === "string" ? flags.name : "world";
      api.sendUserMessage(`Hello, **${name}**! 👋`);
    },
  });
};

export default extension;
```

---

## Swarm-Aware Extension

Aery's multi-agent swarm support is the feature that sets it apart. Extensions that declare a swarm role can coordinate with other specialised agents running in the same session:

```ts
// reviewer-extension/index.ts
import type { AeryExtension } from "@aryee337/aery-sdk";
import type { SwarmAwareExtensionAPI } from "@aryee337/aery-sdk/swarm";

const extension: AeryExtension = async (api) => {
  const swarmApi = api as typeof api & SwarmAwareExtensionAPI;

  // Declare this agent's role in the swarm
  swarmApi.declareSwarmRole({
    role: "code-reviewer",
    capabilities: ["review_pr", "suggest_refactors", "check_types"],
    receivesBroadcast: true,
  });

  // React to turn starts — read any waiting swarm messages
  api.on("turn_start", async () => {
    const messages = await swarmApi.swarmRead("code-reviewer");

    for (const msg of messages) {
      if (msg.payload && typeof msg.payload === "object" && "pr_url" in msg.payload) {
        const pr = (msg.payload as { pr_url: string }).pr_url;
        api.sendUserMessage(`📋 Reviewing PR from **${msg.from}**: ${pr}`);

        // Notify the requester when done
        await swarmApi.swarmSend(msg.from, { status: "review_complete", pr_url: pr });
      }
    }
  });

  // Broadcast a ready signal to all swarm participants
  api.on("session_start", async () => {
    await swarmApi.swarmBroadcast({ type: "agent_ready", role: "code-reviewer" });
  });
};

export default extension;
```

---

## API Reference

### `ExtensionAPI`

| Method | Description |
|---|---|
| `registerTool(tool)` | Add a tool to the agent's palette |
| `registerCommand(name, handler)` | Add a `/name` slash command |
| `on(event, handler)` | Subscribe to a lifecycle event |
| `sendUserMessage(msg)` | Inject a message into the chat thread |
| `exec(cmd, args, opts?)` | Run a shell command |
| `sessionId` | Current session ID (readonly) |
| `extensionName` | This extension's name (readonly) |

### `SwarmAwareExtensionAPI`

| Method | Description |
|---|---|
| `declareSwarmRole(capability)` | Announce this agent's role and capabilities |
| `swarmSend(to, payload)` | Send a direct message to another swarm role |
| `swarmRead(role)` | Read all messages in this role's inbox |
| `swarmBroadcast(payload)` | Broadcast to all `receivesBroadcast=true` agents |

### Lifecycle Events (`AeryEventName`)

| Event | When it fires |
|---|---|
| `session_start` | A new session is created |
| `session_shutdown` | The session is shutting down |
| `session_before_compact` / `session_compact` | Before / after context compaction |
| `before_agent_start` / `agent_start` / `agent_end` | Agent run lifecycle |
| `turn_start` / `turn_end` | Each agent turn |
| `input` | User input received |
| `context` | Context window updated |
| `before_provider_request` / `after_provider_response` | LLM request lifecycle |
| `tool_call` / `tool_result` | Tool invocation and response |
| `tool_execution_start` / `tool_execution_end` | Tool side-effect lifecycle |
| `resources_discover` | Resource discovery phase |

### Helper Functions

```ts
import { defineTool, defineCommand, parseArgs } from "@aryee337/aery-sdk";
```

| Helper | Description |
|---|---|
| `defineTool(tool)` | Identity helper with full TypeScript inference |
| `defineCommand(api, name, handler)` | Register a command ergonomically |
| `parseArgs(raw)` | Parse `--flag=value` argument strings |

---

## Subpath Exports

For tree-shaking-friendly imports, use the subpath exports:

```ts
import type { AeryTool } from "@aryee337/aery-sdk/tools";
import type { AeryEventName } from "@aryee337/aery-sdk/events";
import type { SwarmAwareExtensionAPI } from "@aryee337/aery-sdk/swarm";
```

---

## Examples

Browse real-world extensions in the **[aery-extensions](https://github.com/eminent337/aery-extensions)** repository.

---

## License

MIT © Aryee — see [LICENSE](../../LICENSE).
