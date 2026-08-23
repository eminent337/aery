# Aery Release Notes — v1.0.0

## 🎉 Release Overview

Aery is a TypeScript coding agent with deep interactive terminal capabilities, intelligent memory, and a robust tool ecosystem. This release consolidates all features and ensures everything is functional.

## ✨ New Features

### Interactive Terminal (PTY) Workflow
- **PTY Auto-Detection**: Commands starting with `sudo`, `su`, `passwd`, `ssh`, `gpg`, `mysql`, `psql` are automatically promoted to interactive mode
- **`send_input` Tool**: Send stdin to a running background command (passwords, passphrases, yes/no prompts)
- **`bash_output` Tool**: Read streaming output from background jobs without blocking
- **Combined Workflow**: `bash` → `bash_output` → `send_input` → `bash_output` for full interactive command handling

### Tool System
- **Tool Execution Waterfalls**: Pre/post execute hooks for policy enforcement, logging, and metrics
- **`ToolDenyError`**: Hook-based tool call denial
- **Global Hooks**: `"*"` wildcard hooks apply to all tools

### Event-Sourced Session Log
- **Append-Only Event Store**: JSONL-based per-session event log
- **Event Types**: user/message, assistant/message, tool/call, tool/result, tool/error, system/*
- **`deriveMessages()`**: Reconstruct model-visible `AgentMessage[]` from events
- **Query API**: Filter by type, timestamp, session

### Ambient Scheduler
- **Priority Queue**: Schedule tasks with `low`, `normal`, `high` priority
- **Polling Loop**: Background delivery via EventBus (10s interval)
- **Session-Shared**: Single scheduler per session

## ✅ Verified Working

All 15 core features tested and functional:

| Feature | Status |
|---------|--------|
| Bash / PTY / Interactive commands | ✅ |
| Background job management | ✅ |
| Parallel tool calls (shared/exclusive) | ✅ |
| Smart compaction & pruning | ✅ |
| Cross-session memory (Mnemopi) | ✅ |
| Memory graph (link/related/BFS) | ✅ |
| Conversation search (BM25) | ✅ |
| Search context with confidence | ✅ |
| Endorsed skills catalog | ✅ |
| Checkpoints & rewind | ✅ |
| Tool hooks (pre/post execute) | ✅ |
| Event-sourced session log | ✅ |
| Ambient scheduler | ✅ |
| send_input / bash_output | ✅ |
| PTY auto-detection | ✅ |

## 🔧 Fixes

- **Event Log Wiring**: `EventStore` now instantiated in `AgentSession` constructor with `#logEventToStore` handler
- **Ambient Scheduler**: Fixed to reuse scheduler per session with background polling (was creating new instance per call)
- **Tool Hooks**: Wired into dispatch path at `agent-session.ts`

## 📊 Test Results

- **923 tests pass** across 1227 total tests
- **35 new tests** for event log, tool hooks, bash_output, send_input, interactive session
- **check:ts EXIT 0** across all 11 workspaces

## 🏗️ Architecture

- **Pure TypeScript**: No native compilation required
- **11 workspaces**: Modular monorepo structure
- **~50 tools**: Comprehensive tool ecosystem
- **Event-sourced**: Append-only log enables replay, audit, and undo

---

**Tag**: `v1.0.0`
**Commit**: `6861352503`
