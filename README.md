<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/icon.svg">
    <img src="assets/icon.svg" alt="Aery Logo" width="128" height="128">
  </picture>
</p>

<h1 align="center">Aery</h1>

<p align="center">
  <strong>The terminal-native AI coding agent built for speed, depth, and precision.</strong><br>
  <em>1:1 Google Antigravity (AGY) parity · In-memory differential TUI · Rust native acceleration</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@aryee337/aery"><img src="https://img.shields.io/npm/v/@aryee337/aery?style=flat-square&colorA=1a1a2e&colorB=f97316" alt="npm version"></a>
  <a href="https://github.com/eminent337/aery/blob/main/LICENSE"><img src="https://img.shields.io/github/license/eminent337/aery?style=flat-square&colorA=1a1a2e&colorB=f97316" alt="License"></a>
  <a href="https://github.com/eminent337/aery/actions"><img src="https://img.shields.io/github/actions/workflow/status/eminent337/aery/ci.yml?style=flat-square&colorA=1a1a2e&colorB=10b981" alt="CI"></a>
  <a href="https://discord.gg/4NMW9cdXZa"><img src="https://img.shields.io/badge/Discord-join-5865F2?style=flat-square&logo=discord&logoColor=white" alt="Discord"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> · <a href="#install">Install</a> · <a href="#features">Features</a> · <a href="#antigravity-parity">AGY Parity</a> · <a href="#tools">Tools</a> · <a href="#providers">Providers</a> · <a href="#architecture">Architecture</a> · <a href="https://aery.sh/docs">Docs</a>
</p>

---

**Aery** is an open-source, terminal-native AI coding agent built in TypeScript and Rust. Designed with exact 1:1 behavioral alignment to Google Antigravity (`agy`), Aery combines deep autonomous reasoning, multi-agent coordination, sub-millisecond differential terminal rendering, and native system integration into a single self-updating static binary.

**40+ LLM Providers** · **35+ Built-In Tools** · **13 LSP Ops** · **27 DAP Ops** · **~27k Lines of Native Rust Core**

---

## Quick Start

```sh
# Launch the interactive terminal TUI
aery

# Execute a one-shot task
aery -p "Find and fix the memory leak in the worker pool"

# Resume the previous session
aery --resume

# Check for updates or update in-place
aery update
```

### Shell Completions

```sh
# zsh
eval "$(aery completions zsh)"

# bash
eval "$(aery completions bash)"

# fish
aery completions fish > ~/.config/fish/completions/aery.fish
```

---

## Install

### Standalone Executable (macOS / Linux)

```sh
curl -fsSL https://aery.sh/install | sh
```

### Windows (PowerShell)

```powershell
irm https://aery.sh/install.ps1 | iex
```

### Package Managers

```sh
# Bun (recommended)
bun install -g @aryee337/aery

# npm
npm install -g @aryee337/aery
```

### From Source

```sh
git clone https://github.com/eminent337/aery.git && cd aery
bun install
bun run build
```
*Requires **bun ≥ 1.3.14** and **cargo/rust ≥ 1.82**.*

---

## Antigravity (AGY) Parity

Aery provides full behavioral, operational, and structural parity with Google Antigravity (`agy`):

* ⚡ **Live Background Compaction**: Conversation history is snapshotted and summarized in the background without pausing active execution, aborting running tools, or freezing the UI.
* 🤖 **Autonomous `image-generator` Subagent**: Creative briefs are delegated to a built-in subagent with a 3-attempt self-inspection loop, artifact file persistence, and automatic markdown embedding.
* 👁️ **Visual Perception ("The Eye")**: `live_eye` features focus-first window framing to eliminate whole-desktop downscale blur, ephemeral context glance sweeping, and semantic OCR click-target resolution.
* 🎥 **Multimodal Video & Media Inspection**: Native inspection of `.mp4`, `.mov`, `.webm`, `.ogv`, `.m4a`, and `.opus` recordings with keyframe extraction and audio track parsing.
* 📊 **Real-Time Subagent Footer Observation**: Live progress and active tool actions (`run_command`, `read_file`, `thinking`) stream in the bottom status line.
* 🔄 **Atomic In-Place Updates**: Single-command self-updating (`aery update`) with atomic binary replacement, automatic rollback, and 24-hour cached background release checks.
* 🎯 **Strict Slash Command Alignment**: Exactly 9 official workflow commands:
  * `/goal`: Thorough, long-running overnight autonomous loops.
  * `/compact`: Context summarization and memory pruning.
  * `/schedule`: Timers, recurring cron tasks, and reminders.
  * `/browser`: Web navigation and headless tab automation.
  * `/plan`: Multi-step architectural implementation plans.
  * `/grill-me`: Interactive discovery interviews for requirements refinement.
  * `/teamwork`: Multi-agent swarm collaboration.
  * `/learn`: Persist patterns, fixes, and rules into project context.
  * `/boost`: Dynamic thinking-level amplification for complex tasks.

---

## Features

### Non-Blocking Background Compaction
Unlike conventional agents that freeze execution when the context window fills up, Aery snapshots the conversation prefix and invokes summarization asynchronously. While older turns are compressed, the agent continues executing tools, running tests, and streaming responses uninterrupted.

### Real Code Debugging (DAP) & Language Server (LSP)
Connects directly to real language servers and debuggers (`delve`, `debugpy`, `lldb`). Perform variable inspection, stack traversal, and intelligent refactoring (`workspace/willRenameFiles`) with zero manual print debugging.

### Sandboxing & Policy Guardian
Enforces granular filesystem, process, and network access policies via Bubblewrap (`bwrap`) on Linux, sandboxed containers, and declarative `hooks.json` gates.

### High-Performance Differential Terminal TUI
Built with `@aryee337/aery-tui`, utilizing differential viewport updates, synchronized output brackets (`BSU`/`ESU`), and scrollback preservation to render flicker-free interfaces across Ghostty, Kitty, iTerm2, and WezTerm.

---

## Tools Reference

| Category | Tools | Capabilities |
| :--- | :--- | :--- |
| **Files & Search** | `read`, `write`, `edit_file`, `find`, `search` | Byte-exact file operations, hashline anchor edits, AST structural rewrites |
| **Execution** | `bash`, `eval`, `ssh`, `manage_task` | Interactive PTY shell sessions, persistent Python/JS cells, remote host control |
| **Visual & Desktop** | `live_eye`, `live_input`, `desktop_control`, `inspect_image` | Desktop automation, Catmull-Rom cursor glides, Tesseract OCR, window framing |
| **Intelligence** | `lsp`, `debug`, `ask_question`, `schedule` | Symbol definitions, DAP breakpoints, structured user prompts, cron jobs |
| **Coordination** | `invoke_subagent`, `manage_subagents`, `send_message` | Multi-agent orchestration, IPC message bus, typed structured outputs |
| **Creation** | `image_gen`, `video_gen`, `render_mermaid` | Image generation (Gemini/Imagen/Flux), async video rendering, diagram export |

---

## Supported Providers

Aery connects with **40+ LLM providers** through a unified streaming client:

* **Frontier APIs**: Anthropic (Claude 3.7 / 3.5), OpenAI (GPT-4o, o3-mini), Google Gemini (Gemini 2.5 Pro / Flash), xAI (Grok 2).
* **High-Throughput Cloud**: Groq, Cerebras, Together AI, Fireworks, OpenRouter, Mistral, Perplexity.
* **Coding Providers**: GitHub Copilot, Cursor, GitLab Duo, Kimi, MiniMax, Qwen.
* **Local & Private**: Ollama, LM Studio, llama.cpp, vLLM, LiteLLM.

Features path-scoped model routing, fallback chains on HTTP 429 rate limits, and round-robin credential pools.

---

## Architecture & Monorepo Packages

Aery is organized as a unified monorepo leveraging native Rust bindings via N-API:

| Package | Path | Responsibility |
| :--- | :--- | :--- |
| **`@aryee337/aery`** | [`packages/coding-agent`](packages/coding-agent) | Main CLI runtime, session orchestrator, interactive TUI, and subagent engine |
| **`@aryee337/aery-tui`** | [`packages/tui`](packages/tui) | In-memory differential terminal UI engine with synchronized ANSI renderers |
| **`@aryee337/aery-core`** | [`packages/agent`](packages/agent) | Agent loop state machine, tool dispatch lifecycle, and telemetry |
| **`@aryee337/aery-ai`** | [`packages/ai`](packages/ai) | Multi-provider streaming LLM adapter with token estimation and rate-limit backoff |
| **`@aryee337/aery-engine`** | [`packages/aery-engine`](packages/aery-engine) | High-performance N-API native bindings for tree-sitter AST, bash PTY, and regex |
| **`@aryee337/aery-stats`** | [`packages/stats`](packages/stats) | Telemetry, memory tracking, and session performance diagnostics |
| **`@aryee337/aery-utils`** | [`packages/utils`](packages/utils) | Shared file parsers, snowflake identifiers, and process abstractions |

---

## Community & Contributing

* 💬 **Discord**: [Join our Discord community](https://discord.gg/4NMW9cdXZa)
* 🐛 **Issues**: [GitHub Issue Tracker](https://github.com/eminent337/aery/issues)
* 📖 **Documentation**: [aery.sh/docs](https://aery.sh/docs)

```sh
# Run the test suite
bun test

# Type check across all packages
bun run check
```

---

## License

Distributed under the MIT License. See [`LICENSE`](LICENSE) for details.

<p align="center">
  <sub>Built with ❤️ by Aryee and the open-source community.</sub>
</p>
