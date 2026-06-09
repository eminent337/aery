<p align="center">
  <img src="https://github.com/eminent337/aery/blob/main/assets/hero.png?raw=true" alt="Aery — AI Coding Agent" width="100%">
</p>

<h3 align="center">The terminal coding agent that ships.</h3>

<p align="center">
  <a href="https://www.npmjs.com/package/@aryee337/aery"><img src="https://img.shields.io/npm/v/@aryee337/aery?style=flat-square&colorA=1a1a2e&colorB=f97316" alt="npm version"></a>
  <a href="https://github.com/eminent337/aery/blob/main/LICENSE"><img src="https://img.shields.io/github/license/eminent337/aery?style=flat-square&colorA=1a1a2e&colorB=f97316" alt="License"></a>
  <a href="https://github.com/eminent337/aery/actions"><img src="https://img.shields.io/github/actions/workflow/status/eminent337/aery/ci.yml?style=flat-square&colorA=1a1a2e&colorB=10b981" alt="CI"></a>
  <a href="https://discord.gg/4NMW9cdXZa"><img src="https://img.shields.io/badge/Discord-join-5865F2?style=flat-square&logo=discord&logoColor=white" alt="Discord"></a>
</p>

<p align="center">
  <a href="#install">Install</a> · <a href="#quick-start">Quick Start</a> · <a href="#features">Features</a> · <a href="#tools">Tools</a> · <a href="#providers">Providers</a> · <a href="#extensibility">Extensibility</a> · <a href="https://aery.sh/docs">Docs</a>
</p>

---

**Aery** is a terminal-native coding agent built in TypeScript and Rust. It reads your codebase, executes commands, drives a real debugger, searches the web, spawns subagents, and talks to 40+ LLM providers — all from a single binary.

**40+ providers** · **32 built-in tools** · **13 LSP ops** · **27 DAP ops** · **~27k lines of Rust core**

## Install

**macOS / Linux**

```sh
curl -fsSL https://aery.sh/install | sh
```

**Bun (recommended)**

```sh
bun install -g @aryee337/aery
```

**npm**

```sh
npm install -g @aryee337/aery
```

**Windows (PowerShell)**

```powershell
irm https://aery.sh/install.ps1 | iex
```

**From source**

```sh
git clone https://github.com/eminent337/aery && cd aery
bun install
bun run build
```

Requires **bun ≥ 1.3.14**.

## Quick Start

```sh
# Start a session in your project
aery

# One-shot prompt
aery -p "explain this codebase"

# Resume last session
aery --resume
```

### Shell completions

```sh
# zsh
eval "$(aery completions zsh)"

# bash
eval "$(aery completions bash)"

# fish
aery completions fish > ~/.config/fish/completions/aery.fish
```

## Features

### Code execution with tool-calling

Persistent Python and Bun kernels that call back into the agent's own tools. The agent loads a CSV with `read` from inside Python, charts it from JavaScript, and never leaves the cell.

### LSP wired into every write

Ask for a rename and you get a rename. The call goes through `workspace/willRenameFiles`, so re-exports, barrel files, and aliased imports update before the file moves.

### Drives a real debugger

Attach lldb, dlv, or debugpy. Set breakpoints, step through code, inspect variables. Most agents are still sprinkling print statements.

### Subagents

Split a job across workers and get typed results back. `task` fans out into isolated worktrees, each worker runs its own tool surface, and the final yield is a schema-validated object.

### Time-traveling stream rules

Your rules sit dormant until the model goes off-script. A regex match aborts the stream mid-token, injects the rule as a system reminder, and retries from the same point.

### Code review

Get a clear verdict with every issue ranked P0–P3 and scored for confidence. `/review` spawns dedicated reviewer subagents that sweep branches in parallel.

### Hashline edits

Perfect edits, fewer tokens. The model points at anchors instead of retyping lines. Edit a stale file and the anchors diverge — the patch is rejected before it corrupts anything.

### Web search

One query across 14 providers, returning structured markdown with anchors intact. Arxiv PDFs, GitHub pages, Stack Overflow — all through the same `read` tool surface.

### Git integration

Read PRs, resolve conflicts, and commit with atomic splits. `pr://`, `issue://`, and `conflict://` URLs resolve through the same `read` interface.

### Browser automation

Drive a real browser with stealth mode on by default. Pages see a normal user instead of a headless bot.

### Hindsight memory

The agent remembers your codebase between sessions. Write facts with `retain`, pull them back with `recall`, and compress each session into a mental model.

---

## Tools

32 tools live in the same namespace as `read` and `bash`. Pin the active set with `--tools read,edit,bash,…`.

### Files & Search

| Tool | Description |
|------|-------------|
| `read` | Files, dirs, archives, SQLite, PDFs, notebooks, URLs, and internal `://` schemes |
| `write` | Create or overwrite a file, archive entry, or SQLite row |
| `edit` | Hashline patches with content-hash anchors |
| `ast_edit` | Structural rewrites via ast-grep, previewed before apply |
| `ast_grep` | Structural code queries over 50+ tree-sitter grammars |
| `search` | Regex over files, globs, and internal URLs |
| `find` | Glob-based path lookup |

### Runtime

| Tool | Description |
|------|-------------|
| `bash` | Workspace shell with optional PTY or background-job dispatch |
| `eval` | Persistent Python and JavaScript cells with tool re-entry |
| `ssh` | One remote command against a configured host |

### Code Intelligence

| Tool | Description |
|------|-------------|
| `lsp` | Diagnostics, navigation, symbols, renames, code actions |
| `debug` | Drive a DAP session — breakpoints, stepping, threads, variables |

### Coordination

| Tool | Description |
|------|-------------|
| `task` | Fan out subagents in parallel, optionally workspace-isolated |
| `irc` | Short prose between live agents |
| `todo_write` | Ordered mutations over the session todo list |
| `ask` | Structured follow-up questions for interactive runs |

### Outside the Box

| Tool | Description |
|------|-------------|
| `browser` | Puppeteer tabs over headless Chromium or CDP-attached apps |
| `web_search` | One query across configured providers, with citations |
| `github` | GitHub CLI ops — repo, PR, issues, Actions |
| `generate_image` | Generate or edit images via Gemini |
| `inspect_image` | Vision-model analysis of local images |
| `render_mermaid` | Mermaid diagrams to terminal ASCII or PNG |

[Full tool reference →](https://aery.sh/docs/tools)

## Providers

**40+ providers**, hundreds of models, one `/model` away.

### Frontier APIs

Anthropic · OpenAI · Google Gemini · xAI · Mistral · Groq · Cerebras · Fireworks · Together · NVIDIA · OpenRouter · Perplexity

### Coding Plans

Cursor · GitHub Copilot · GitLab Duo · Kimi Code · MiniMax · Alibaba · Qwen · Z.AI · Xiaomi MiMo

### Local

Ollama · LM Studio · llama.cpp · vLLM · LiteLLM

### Routing

- **Custom providers** — anything that speaks OpenAI or Anthropic compatible APIs
- **Fallback chains** — per-role chains with automatic retry on 429s
- **Path-scoped roles** — pin heavier models on specific repos
- **Round-robin credentials** — stack API keys with session affinity

[Provider reference →](https://aery.sh/docs/providers)

## Extensibility

### Extensions

TypeScript modules with the same tool API, slash-command registry, and hotkey table the built-ins use. Nothing is reserved.

```sh
# Reload plugins
/reload-plugins
```

### Rule inheritance

On first run, Aery inherits rules from `.claude`, `.cursor`, `.windsurf`, `.gemini`, `.codex`, `.cline`, `.github/copilot`, and `.vscode`. No migration script.

### Entry points

| Mode | Command | Description |
|------|---------|-------------|
| Interactive | `aery` | Full TUI with cards, previews, and permission prompts |
| One-shot | `aery -p "prompt"` | Answer and exit |
| SDK | `@aryee337/aery` | Embed in Node/TypeScript |
| RPC | `aery --mode rpc` | Drive over stdio with NDJSON |
| ACP | `aery acp` | Agent Client Protocol for editors |

## Rust Core

~27,000 lines of Rust doing the work other harnesses shell out for. Search, shell, AST, highlight, PTY, image decode, BPE counting — all in-process.

| Module | What it does |
|--------|-------------|
| `shell` | Embedded bash · persistent sessions · timeout/abort |
| `grep` | Regex search · parallel · glob & type filters |
| `text` | ANSI-aware width · truncation · column slicing |
| `ast` | ast-grep pattern matching and structural rewrites |
| `highlight` | Syntax highlighting · 11 semantic categories |
| `pty` | Native PTY allocation for sudo, ssh |
| `glob` | Discovery with gitignore respect |
| `tokens` | O200k / Cl100k BPE token counting |

**Platforms:** `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`

## Monorepo Packages

| Package | Description |
|---------|-------------|
| [`@aryee337/aery`](packages/coding-agent) | Interactive coding agent CLI and SDK |
| [`@aryee337/aery-ai`](packages/ai) | Multi-provider LLM client with streaming |
| [`@aryee337/aery-core`](packages/agent) | Agent runtime with tool calling |
| [`@aryee337/aery-tui`](packages/tui) | Terminal UI with differential rendering |
| [`@aryee337/aery-engine`](packages/aery-engine) | N-API bindings for native operations |
| [`@aryee337/aery-stats`](packages/stats) | Local observability dashboard |
| [`@aryee337/aery-utils`](packages/utils) | Shared utilities |

## Development

```sh
git clone https://github.com/eminent337/aery && cd aery
bun install
bun run dev        # Start in development mode
bun run check      # Type check
bun run test       # Run tests
```

See [DEVELOPMENT.md](packages/coding-agent/DEVELOPMENT.md) for architecture and contribution guidelines.

## Community

- [Discord](https://discord.gg/4NMW9cdXZa) — Ask questions, share feedback
- [GitHub Issues](https://github.com/eminent337/aery/issues) — Bug reports, feature requests
- [Changelog](https://github.com/eminent337/aery/blob/main/packages/coding-agent/CHANGELOG.md) — What changed

## License

MIT © 2026 [Aryee](https://github.com/eminent337)

---

<p align="center">
  <a href="https://aery.sh">aery.sh</a> · <a href="https://github.com/eminent337/aery">GitHub</a> · <a href="https://www.npmjs.com/package/@aryee337/aery">npm</a> · <a href="https://discord.gg/4NMW9cdXZa">Discord</a>
</p>
