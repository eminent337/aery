# T3-Style ACP & OpenCode Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a native Agent Client Protocol (ACP) client in Aery to connect to local coding agents like OpenCode (`opencode acp`), enabling seamless access to free models and multi-agent swarm delegation without losing context.

**Architecture:** A modular JSON-RPC 2.0 ACP client (`packages/coding-agent/src/acp`) communicates with locally installed agent harnesses over `stdio`. An OpenCode adapter handles binary resolution and environment isolation, and Aery's subagent runner registers `opencode` as an autonomous worker subagent that can be invoked via `invoke_subagent` inside isolated git worktrees.

**Tech Stack:** TypeScript, Node.js child_process (stdio), JSON-RPC 2.0, Bun test runner.

---

### File Structure Map

- Create: `packages/coding-agent/src/acp/types.ts` (ACP protocol interfaces and message shapes)
- Create: `packages/coding-agent/src/acp/transport.ts` (Line-delimited JSON-RPC stdio transport)
- Create: `packages/coding-agent/src/acp/client.ts` (High-level AcpClient with process management and session lifecycle)
- Create: `packages/coding-agent/src/acp/adapters/opencode.ts` (OpenCode binary discovery and environment launcher)
- Create: `packages/coding-agent/src/acp/index.ts` (Public module exports)
- Modify: `packages/coding-agent/src/registry/builtin-subagents.ts` (Register opencode subagent type)
- Modify: `packages/coding-agent/src/registry/subagent-runner.ts` (Execute ACP runner when type is opencode)
- Create: `packages/coding-agent/test/acp/transport.test.ts` (Unit tests for JSON-RPC transport)
- Create: `packages/coding-agent/test/acp/client.test.ts` (Unit tests for AcpClient lifecycle and streaming)
- Create: `packages/coding-agent/test/acp/opencode-adapter.test.ts` (Unit tests for OpenCode adapter)
- Create: `packages/coding-agent/test/acp/opencode-subagent.test.ts` (Integration tests for subagent invocation)

---

### Task 1: ACP Protocol Types and Stdio Transport

Implement the JSON-RPC 2.0 framing and request/response correlation layer.

**Files:**
- Create: `packages/coding-agent/src/acp/types.ts`
- Create: `packages/coding-agent/src/acp/transport.ts`
- Create: `packages/coding-agent/test/acp/transport.test.ts`

- [ ] **Step 1: Write failing tests for ACP transport**
  Test line-delimited message serialization and parsing.
  Test request correlation (`id` matching response).
  Test notification handling (incoming messages with no `id`).
  Test error responses (`code`, `message`, `data`).

- [ ] **Step 2: Run test to verify it fails**
  Run: `mkdir -p /tmp/fakehome/.aery/logs && HOME=/tmp/fakehome bun test packages/coding-agent/test/acp/transport.test.ts`
  Expected: FAIL

- [ ] **Step 3: Implement `types.ts` and `transport.ts`**
  Define ACP types (`AcpInitializeParams`, `AcpSessionNewParams`, `AcpSessionPromptParams`, etc.).
  Implement `AcpTransport` with `sendMessage`, `request`, and event emitters for notifications.

- [ ] **Step 4: Run test to verify it passes**
  Run: `mkdir -p /tmp/fakehome/.aery/logs && HOME=/tmp/fakehome bun test packages/coding-agent/test/acp/transport.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  Run: `git commit -m "feat(acp): implement acp protocol types and stdio transport"`

---

### Task 2: High-Level `AcpClient` Core

Implement subprocess lifecycle management, session initialization, turn execution, and streaming.

**Files:**
- Create: `packages/coding-agent/src/acp/client.ts`
- Create: `packages/coding-agent/test/acp/client.test.ts`

- [ ] **Step 1: Write failing tests for `AcpClient`**
  Test `initialize` handshake with protocol version 1.
  Test `sessionNew` returning unique `sessionId`.
  Test `sessionPrompt` streaming text chunks and tool events.
  Test timeout and abort signal process group termination (`SIGKILL`).

- [ ] **Step 2: Run test to verify it fails**
  Run: `mkdir -p /tmp/fakehome/.aery/logs && HOME=/tmp/fakehome bun test packages/coding-agent/test/acp/client.test.ts`
  Expected: FAIL

- [ ] **Step 3: Implement `AcpClient`**
  Spawn target process with `stdio: ["pipe", "pipe", "pipe"]` and `detached: process.platform !== "win32"`.
  Implement `initialize`, `sessionNew`, `sessionLoad`, `sessionPrompt`, and `sessionCancel`.
  Handle streaming updates (`session/update`) with callback dispatch.
  Implement clean process group termination via `process.kill(-child.pid, "SIGKILL")`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `mkdir -p /tmp/fakehome/.aery/logs && HOME=/tmp/fakehome bun test packages/coding-agent/test/acp/client.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  Run: `git commit -m "feat(acp): implement high-level acp client core"`

---

### Task 3: OpenCode ACP Adapter

Provide specialized discovery and process launcher for `/home/aryee/.npm-global/bin/opencode acp`.

**Files:**
- Create: `packages/coding-agent/src/acp/adapters/opencode.ts`
- Create: `packages/coding-agent/src/acp/index.ts`
- Create: `packages/coding-agent/test/acp/opencode-adapter.test.ts`

- [ ] **Step 1: Write failing tests for OpenCode adapter**
  Test resolution of `opencode` binary from environment or standard paths.
  Test environment sanitization (setting XDG data paths to avoid sandbox log errors).
  Test command arguments generation for `opencode acp`.

- [ ] **Step 2: Run test to verify it fails**
  Run: `mkdir -p /tmp/fakehome/.aery/logs && HOME=/tmp/fakehome bun test packages/coding-agent/test/acp/opencode-adapter.test.ts`
  Expected: FAIL

- [ ] **Step 3: Implement OpenCode adapter**
  Implement `resolveOpencodeBinary()`.
  Implement `createOpencodeAcpClient()` configuring standard env and fallback paths.
  Export public ACP interface in `packages/coding-agent/src/acp/index.ts`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `mkdir -p /tmp/fakehome/.aery/logs && HOME=/tmp/fakehome bun test packages/coding-agent/test/acp/opencode-adapter.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  Run: `git commit -m "feat(acp): implement opencode acp adapter"`

---

### Task 4: Subagent Swarm Integration (`invoke_subagent` for `opencode`)

Register `opencode` as an autonomous worker subagent type and wire it into Aery's background runner.

**Files:**
- Modify: `packages/coding-agent/src/registry/builtin-subagents.ts`
- Modify: `packages/coding-agent/src/registry/subagent-runner.ts`
- Create: `packages/coding-agent/test/acp/opencode-subagent.test.ts`

- [ ] **Step 1: Write failing test for opencode subagent invocation**
  Test `getSubagentDefinition("opencode")` returns correct definition and tools.
  Test launching `opencode` subagent via `SubagentRunner` spawns ACP client and records turn output.
  Test worktree branch isolation captures git diffs.

- [ ] **Step 2: Run test to verify it fails**
  Run: `mkdir -p /tmp/fakehome/.aery/logs && HOME=/tmp/fakehome bun test packages/coding-agent/test/acp/opencode-subagent.test.ts`
  Expected: FAIL

- [ ] **Step 3: Implement subagent registration and runner integration**
  Register `opencode` in `builtin-subagents.ts`.
  In `subagent-runner.ts`, add ACP execution branch when `typeName === "opencode"`.
  Stream assistant text chunks and tool progress to `AgentRegistry`.
  Extract git diff upon task completion and format return payload.

- [ ] **Step 4: Run test to verify it passes**
  Run: `mkdir -p /tmp/fakehome/.aery/logs && HOME=/tmp/fakehome bun test packages/coding-agent/test/acp/opencode-subagent.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  Run: `git commit -m "feat(subagents): add opencode acp worker subagent type"`

---

### Verification and Integration

- [ ] Run full test suite across touched packages.
- [ ] Verify zero AI dashes across all new and modified files.
- [ ] Verify live ACP handshake with local `opencode acp`.
