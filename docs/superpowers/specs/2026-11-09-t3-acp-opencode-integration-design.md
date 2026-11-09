# T3-Style Agent Client Protocol (ACP) & OpenCode Multi-Endpoint Integration Design

## 1. Overview & Objective

This specification defines the architecture for porting T3 Code's (`pingdotgg/t3code`) multi-agent harness pattern to Aery.

Instead of directly communicating with cloud endpoints or reverse-engineering cloud APIs and session headers, Aery integrates with local coding agents via the **Agent Client Protocol (ACP)** over `stdio` using JSON-RPC 2.0.

This enables Aery to:
1. Dynamically spawn and control locally installed agents (such as OpenCode via `opencode acp`, Claude Code, or Codex).
2. Inherit and reuse active subscriptions and free model access (e.g. OpenCode Zen free models like Qwen, DeepSeek, GLM, MiniMax) with zero-configuration token handling.
3. Preserve full conversation context and session history across turns using ACP `session/new`, `session/load`, and `session/prompt`.
4. Delegate token-heavy or specialized tasks to background subagents in isolated git worktrees, streaming live updates and diffs back into Aery's main timeline.

---

## 2. Architecture & Components

```
+--------------------------------------------------------------------------------+
|                                  AERY CORE                                     |
|                                                                                |
|  +--------------------+        +---------------------+        +-------------+  |
|  | Main Agent Session | <----> | DamageControl & ACL | <----> | TUI/Stream  |  |
|  +--------------------+        +---------------------+        +-------------+  |
|            |                                                                   |
|            v                                                                   |
|  +--------------------+                                                        |
|  | invoke_subagent    |                                                        |
|  | TypeName: opencode |                                                        |
|  +--------------------+                                                        |
|            |                                                                   |
+------------|-------------------------------------------------------------------+
             |
             v
+--------------------------------------------------------------------------------+
|                         ACP CLIENT LAYER (packages/coding-agent/src/acp)       |
|                                                                                |
|  +--------------------+        +---------------------+        +-------------+  |
|  |   AcpClient        | <----> | AcpSessionManager   | <----> | Permission  |  |
|  |   (JSON-RPC 2.0)   |        | (new/load/prompt)   |        | Relaying    |  |
|  +--------------------+        +---------------------+        +-------------+  |
|            |                                                                   |
+------------|-------------------------------------------------------------------+
             |  stdio (JSON-RPC)
             v
+--------------------------------------------------------------------------------+
|                     EXTERNAL AGENT HARNESS (opencode acp)                      |
|                                                                                |
|  /home/aryee/.npm-global/bin/opencode acp                                      |
|  - Uses local login: ~/.local/share/opencode/opencode.db                       |
|  - Free models: qwen3.6-plus-free, minimax-m2.5-free, glm-5-free, deepseek     |
|  - Isolated execution in dedicated git worktree                                |
+--------------------------------------------------------------------------------+
```

---

## 3. Detailed Component Specifications

### 3.1 ACP Client Core (`packages/coding-agent/src/acp/client.ts`)
The `AcpClient` class manages the child process and protocol framing:
- **Transport:** Spawns child process with `stdio: ["pipe", "pipe", "pipe"]` and `detached: process.platform !== "win32"`.
- **Process Group Termination:** Implements `killProcessGroup()` with `SIGKILL` to prevent orphaned child processes.
- **Framing:** Line-delimited JSON-RPC 2.0 messages over stdout/stdin.
- **Methods:**
  - `initialize(params)`: Sends protocol handshake (`protocolVersion: 1`), receives capabilities and auth methods.
  - `sessionNew(params)`: Sends `session/new` with `cwd` and optional `mcpServers`. Returns `sessionId`.
  - `sessionLoad(params)`: Sends `session/load` with `sessionId` and `cwd` to restore existing conversation history.
  - `sessionPrompt(params, onUpdate)`: Sends user prompt turns (`ContentBlock[]`), listens for `session/update` notifications, and resolves when the turn concludes.
  - `sessionCancel(params)`: Sends cancellation for an ongoing turn.
- **Error Handling:** Safe timeout handling, process crash detection, and clean disconnects.

### 3.2 OpenCode Adapter (`packages/coding-agent/src/acp/adapters/opencode.ts`)
Specialized configuration and runner for OpenCode:
- **Binary Resolution:** Resolves `/home/aryee/.npm-global/bin/opencode` or searches `$PATH`.
- **Environment Normalization:** Ensures `XDG_DATA_HOME` and `HOME` are set safely to avoid sandbox permission errors with log files.
- **Model Resolution:** Maps friendly model names to OpenCode's format (e.g. `opencode/qwen3.6-plus-free` -> `qwen3.6-plus-free`).
- **Session Caching:** Stores active session IDs so turns within the same task reuse context.

### 3.3 Swarm Subagent Integration (`packages/coding-agent/src/registry/builtin-subagents.ts`)
Register `opencode` as a first-class subagent:
- **Definition:**
  - `name: "opencode"`
  - `description: "Autonomous OpenCode worker agent running via ACP. Executes tasks with local free models and returns diffs."`
- **Execution Lifecycle in `subagent-runner.ts`:**
  - Spawns worktree isolation when `Workspace: "branch"` is specified.
  - Instantiates `AcpClient` with OpenCode adapter.
  - Streams tool progress and text chunks to Aery's `AgentRegistry`.
  - Captures final git diff and assistant response upon completion.
  - Notifies parent agent with structured outcome.

### 3.4 Damage Control & Permission Interception
When OpenCode requests tool execution permissions over ACP (`session/request_permission` or tool call events):
- Routed through Aery's `DamageControl` policy engine.
- Operations that mutate `.git/` or destructive commands are intercepted according to `blockGitWrites`.
- Decisions are recorded in `~/.aery/logs/security-audit.jsonl`.

---

## 4. Verification and Testing Plan

1. **Unit Tests (`packages/coding-agent/test/acp/client.test.ts`):**
   - Test JSON-RPC serialization, request/response correlation, and notification streaming using an in-process mock ACP server.
   - Test timeout enforcement, process termination, and error handling.
   - Test pre-aborted signal cancellation.
2. **OpenCode Adapter Tests (`packages/coding-agent/test/acp/opencode-adapter.test.ts`):**
   - Test binary resolution, parameter normalization, and command args.
3. **Subagent Integration Test (`packages/coding-agent/test/acp/opencode-subagent.test.ts`):**
   - Test end-to-end task dispatch via `invoke_subagent` with mock ACP runner.
   - Test worktree isolation and diff extraction.
4. **Dash Law Compliance:**
   - 0 Unicode em dashes (\u2014) and 0 en dashes (\u2013) across all code, tests, and comments.
