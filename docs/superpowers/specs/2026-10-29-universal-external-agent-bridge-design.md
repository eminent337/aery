# Universal External Agent Bridge Design Spec

**Date**: 2026-10-29  
**Status**: Approved by User  
**Scope**: Aery Coding Agent (`@aryee337/aery-coding-agent`)

---

## 1. Overview & Goals

Developers often have multiple AI coding agents installed on their machine (e.g. `agy` [Google Antigravity CLI], `codex` [OpenAI Codex CLI], `opencode`, `claude`, `aider`, `pi`, `gh copilot`). Today, these agents operate in isolation.

The **Universal External Agent Bridge** enables Aery to:
1. Automatically scan the host machine's `PATH` to discover installed AI coding agents.
2. Provide a first-class tool, `call_external_agent`, allowing Aery to delegate subtasks, prompt instructions, and code reviews directly to any installed agent.
3. Support both **synchronous execution** (waiting for output/diff) and **background execution** (via Aery's `AsyncJobManager` and `manage_task` system).
4. Provide pre-configured adapters with known non-interactive and auto-approval flags for major agents, alongside a universal fallback (`custom`) for arbitrary binaries and user-defined configurations.

---

## 2. Architecture & Components

```
+-------------------------------------------------------------------------+
|                              Aery Session                               |
+-------------------------------------------------------------------------+
                                    |
                                    v
+-------------------------------------------------------------------------+
|                  Tool: call_external_agent                              |
|                                                                         |
|  - agent: "agy" | "codex" | "opencode" | "claude" | "aider" | "custom"   |
|  - prompt: string                                                       |
|  - cwd?: string                                                         |
|  - background?: boolean                                                 |
|  - extraArgs?: string[]                                                 |
|  - customBinary?: string                                                |
+-------------------------------------------------------------------------+
                                    |
                                    v
+-------------------------------------------------------------------------+
|                     ExternalAgentManager / Registry                     |
|                                                                         |
|  + detectExternalAgents(): scans PATH for installed CLIs                |
|  + getAdapter(name): retrieves runner configuration                     |
|  + resolveCommand(agent, prompt, options): builds executable argv       |
+-------------------------------------------------------------------------+
                                    |
          +-------------------------+-------------------------+
          |                                                   |
          v                                                   v
  [Synchronous Exec]                                 [Background Exec]
  - child_process.spawn                              - AsyncJobManager.register()
  - stdout / stderr stream capture                   - Returns jobId + PID
  - exit code, timing, output                        - Trackable via manage_task
```

### 2.1 File Structure
All new files are placed cleanly within `packages/coding-agent/src/extensibility/external-agents/` and `packages/coding-agent/src/tools/`:

- `packages/coding-agent/src/extensibility/external-agents/types.ts`:
  Type interfaces for adapters, discovery results, execution options, and results.
- `packages/coding-agent/src/extensibility/external-agents/adapters.ts`:
  Definitions for known agents (`agy`, `codex`, `opencode`, `claude`, `aider`, `pi`, `gh`, `custom`).
- `packages/coding-agent/src/extensibility/external-agents/discovery.ts`:
  PATH scanning, executable detection, version probing, and settings override merging.
- `packages/coding-agent/src/extensibility/external-agents/runner.ts`:
  Process spawning, timeout handling, output capture, and background task dispatching.
- `packages/coding-agent/src/tools/external-agent.ts`:
  Implementation of the `call_external_agent` tool adhering to `AgentTool`.
- `packages/coding-agent/src/tools/index.ts`:
  Registers `call_external_agent` in `BUILTIN_TOOLS`.

---

## 3. Agent Adapters & Flag Templates

Each agent adapter specifies:
- `id`: unique string identifier.
- `displayName`: human-readable label.
- `defaultBinary`: executable name expected on `PATH`.
- `buildArgs(prompt: string, options: ExternalAgentExecutionOptions)`: returns the command-line argument array.
- `versionCheckArgs`: CLI flag to query version (e.g. `["--version"]` or `["-v"]`).

### Standard Adapters

1. **`agy` (Google Antigravity CLI)**
   - Default binary: `agy`
   - Invocation args: `["-p", prompt, "--dangerously-skip-permissions"]`
   - If `extraArgs` supplied: appended to argv.
2. **`codex` (OpenAI Codex CLI)**
   - Default binary: `codex`
   - Invocation args: `["exec", prompt, "--dangerously-bypass-approvals-and-sandbox"]`
3. **`opencode`**
   - Default binary: `opencode`
   - Invocation args: `["run", prompt, "--auto"]`
4. **`claude` (Anthropic Claude Code CLI)**
   - Default binary: `claude`
   - Invocation args: `["-p", prompt, "--dangerously-skip-permissions"]`
5. **`aider`**
   - Default binary: `aider`
   - Invocation args: `["--message", prompt, "--yes"]`
6. **`pi` (Pi Coding Agent)**
   - Default binary: `pi`
   - Invocation args: `["-p", prompt]`
7. **`gh` (GitHub Copilot CLI)**
   - Default binary: `gh`
   - Invocation args: `["copilot", "suggest", prompt]`
8. **`custom` (Universal Fallback)**
   - Binary: `customBinary ?? "agent"`
   - Invocation args: `[...extraArgs, prompt]`

---

## 4. Tool Specification: `call_external_agent`

### 4.1 Schema
```json
{
  "name": "call_external_agent",
  "description": "Execute a task using an external AI coding agent installed on this machine (e.g. agy, codex, opencode, claude, aider) or query available installed agents with agent: 'list'.",
  "parameters": {
    "type": "object",
    "properties": {
      "agent": {
        "type": "string",
        "description": "The external agent to invoke ('agy', 'codex', 'opencode', 'claude', 'aider', 'pi', 'custom') or 'list' to inspect available agents on the host machine."
      },
      "prompt": {
        "type": "string",
        "description": "The task instructions or prompt to deliver to the external agent."
      },
      "cwd": {
        "type": "string",
        "description": "Working directory for the agent execution. Defaults to current workspace directory."
      },
      "background": {
        "type": "boolean",
        "description": "If true, dispatches the task as a background job and returns immediately with a jobId. Defaults to false."
      },
      "extraArgs": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Optional extra CLI arguments or flags to pass to the agent."
      },
      "customBinary": {
        "type": "string",
        "description": "Required when agent is 'custom' or to specify an exact absolute path to the binary."
      },
      "timeoutMs": {
        "type": "number",
        "description": "Optional timeout in milliseconds (default: 300000 / 5 minutes)."
      }
    },
    "required": ["agent"]
  }
}
```

### 4.2 Behavior
- **Listing Mode (`agent: "list"`)**:
  Performs dynamic detection of all supported adapters on `process.env.PATH` and returns:
  ```json
  {
    "installedAgents": [
      { "id": "agy", "displayName": "Google Antigravity", "binaryPath": "/home/aryee/.local/bin/agy", "version": "1.4.10" },
      { "id": "codex", "displayName": "OpenAI Codex", "binaryPath": "/usr/bin/codex", "version": "0.147.0" },
      { "id": "opencode", "displayName": "OpenCode", "binaryPath": "/usr/bin/opencode", "version": "1.18.18" }
    ],
    "uninstalledAgents": ["claude", "aider", "pi"]
  }
  ```
- **Sync Execution (`background: false`)**:
  Executes the process, collects stdout and stderr, tracks duration, and returns:
  ```json
  {
    "agent": "codex",
    "exitCode": 0,
    "stdout": "...",
    "stderr": "...",
    "durationMs": 4520,
    "timedOut": false
  }
  ```
- **Async Execution (`background: true`)**:
  Spawns process in background, registers job with `AsyncJobManager` under type `"external-agent"`, and returns:
  ```json
  {
    "agent": "agy",
    "jobId": "job-12345",
    "pid": 54321,
    "status": "running",
    "message": "Task dispatched to agy in the background. Check status or output using manage_task."
  }
  ```

---

## 5. Settings & Custom Configuration

Users can customize agents in Aery's configuration (`settings.json` or `.aery/settings.json`):
```json
{
  "externalAgents": {
    "enabled": true,
    "customAgents": {
      "goose": {
        "displayName": "Goose Agent",
        "binary": "goose",
        "defaultArgs": ["run", "--prompt"]
      }
    },
    "overrides": {
      "agy": {
        "binary": "/custom/path/to/agy",
        "extraArgs": ["--model", "gemini-2.5-pro"]
      }
    }
  }
}
```

---

## 6. Testing & Verification

1. **Unit Tests**:
   - `packages/coding-agent/test/external-agents-discovery.test.ts`:
     - Tests PATH scanning, binary resolution, and version querying.
     - Tests handling of missing binaries gracefully.
   - `packages/coding-agent/test/external-agents-adapters.test.ts`:
     - Verifies correct argument construction for `agy`, `codex`, `opencode`, `claude`, `aider`, and `custom`.
   - `packages/coding-agent/test/call-external-agent-tool.test.ts`:
     - Tests `agent: "list"` returns installed agents.
     - Tests synchronous invocation (mocking child process).
     - Tests background job dispatching and cancel signal handling.
2. **Type Checking**:
   - Run `bun run check:types` across `packages/coding-agent`.
3. **Live Verification**:
   - Run live discovery check against the machine's actual `agy`, `codex`, and `opencode` installations.
