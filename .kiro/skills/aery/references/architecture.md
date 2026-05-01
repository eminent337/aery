# Aery Architecture

## Monorepo layout

```
aery/
├── packages/
│   ├── ai/            # LLM provider abstraction layer
│   ├── agent/         # Core agent loop (tool execution, message handling)
│   ├── coding-agent/  # CLI entry point, modes, tools, extensions
│   ├── tui/           # Terminal UI (Ink/React-based, called "pi")
│   ├── web-ui/        # Browser UI (Lit web components)
│   ├── mom/           # Multi-agent orchestration / message passing
│   └── pods/          # Sandboxed execution environments
```

## Package responsibilities

**`packages/ai`**
- Unified streaming API over all LLM providers (Anthropic, OpenAI, Bedrock, Ollama, Mistral, etc.)
- `stream<Provider>(options)` → `AssistantMessageEventStream`
- Events: `text`, `tool_call`, `thinking`, `usage`, `stop`
- Model registry in `src/models.generated.ts` (auto-generated)
- Provider implementations in `src/providers/`

**`packages/agent`**
- Core agent loop: send message → receive events → execute tools → loop
- Tool result handling, context management, abort signals

**`packages/coding-agent`**
- CLI args parsing (`src/cli/args.ts`)
- Interactive mode (`src/modes/interactive/`)
- Model resolver (`src/core/model-resolver.ts`)
- Extension system (examples in `packages/coding-agent/examples/extensions/`)
- Test suite in `test/suite/` using faux provider (no real API calls)

**`packages/tui`**
- Terminal UI built with Ink
- Keybindings: `DEFAULT_EDITOR_KEYBINDINGS`, `DEFAULT_APP_KEYBINDINGS`
- Test with tmux: `tmux new-session -d -s pi-test -x 80 -y 24`

**`packages/mom`**
- Slack bot powered by an LLM (self-managing)
- Responds to @mentions in channels and DMs
- Executes bash, reads/writes files, self-installs tools (apk, npm, etc.)
- Writes its own CLI skills for workflow automation
- Runs in Docker sandbox (recommended) or host mode
- Persistent workspace, working memory, events/scheduling
- Artifacts server for HTML/JS visualizations
- Key env vars: `MOM_SLACK_APP_TOKEN`, `MOM_SLACK_BOT_TOKEN`
- Docker: `packages/mom/docker.sh`, `packages/mom/dev.sh`

**`packages/pods`**
- CLI tool (`pi`) for deploying and managing LLMs on GPU pods
- Sets up vLLM on fresh Ubuntu pods (DataCrunch, etc.)
- Auto-configures tool calling for agentic models (Qwen, GPT-OSS, GLM, etc.)
- Multi-model management with smart GPU allocation
- OpenAI-compatible API endpoints per model
- Interactive agent with file system tools for testing
- Key env vars: `HF_TOKEN` (HuggingFace), `PI_API_KEY` (API auth)

## Data flow

```
User input
  → coding-agent CLI (args.ts)
  → interactive mode / non-interactive mode
  → agent loop (packages/agent)
  → packages/ai stream<Provider>()
  → LLM API
  → events (text/tool_call/thinking/usage/stop)
  → tool execution
  → loop until stop
  → TUI render (packages/tui) or stdout
```

## Adding a provider (7-step checklist)

1. **`packages/ai/src/types.ts`** — add to `Api` union, create options interface, add to `ApiOptionsMap`, add to `KnownProvider`
2. **`packages/ai/src/providers/<name>.ts`** — implement `stream()`, `streamSimple()`, message/tool conversion, emit standard events
3. **`packages/ai/package.json`** — add subpath export; **`src/index.ts`** — add `export type`; **`src/providers/register-builtins.ts`** — lazy register (no static import); **`src/env-api-keys.ts`** — credential detection
4. **`packages/ai/scripts/generate-models.ts`** — fetch/parse models, map to `Model` interface
5. **`packages/ai/test/`** — add to `stream.test.ts` + full matrix: `tokens`, `abort`, `empty`, `context-overflow`, `image-limits`, `unicode-surrogate`, `tool-call-without-result`, `image-tool-result`, `total-tokens`, `cross-provider-handoff`
6. **`packages/coding-agent/`** — `model-resolver.ts` default model, `interactive-mode.ts` login display name, `args.ts` env var docs, `README.md` + `docs/providers.md`
7. **Docs** — `packages/ai/README.md` providers table, `packages/ai/CHANGELOG.md`

## Versioning

Lockstep: all packages share the same version. `npm run release:patch` or `release:minor`.
- patch = bug fixes + new features
- minor = API breaking changes
