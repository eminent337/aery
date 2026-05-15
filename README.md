# Aery

**AI coding agent for the terminal.** One key, every model, your codebase as a knowledge graph.

[![npm version](https://img.shields.io/npm/v/@eminent337/aery?color=8abeb7&label=version)](https://www.npmjs.com/package/@eminent337/aery)
[![npm downloads](https://img.shields.io/npm/dm/@eminent337/aery?color=8abeb7&label=downloads)](https://www.npmjs.com/package/@eminent337/aery)
[![license](https://img.shields.io/npm/l/@eminent337/aery?color=8abeb7)](LICENSE)

```bash
npm install -g @eminent337/aery
aery
```

## What Aery does

Aery lives in your terminal and works on your codebase the way you think about it — not file by file, but as a connected system.

- **Reads, edits, and runs** — files, shell commands, git, tests, all through natural language
- **Knows your codebase** — builds a persistent knowledge graph so it understands architecture, not just syntax
- **One key, all providers** — store your Anthropic, OpenAI, and other keys once at [aery-web.pages.dev](https://aery-web.pages.dev), get one Aery key that works everywhere
- **Never stops** — automatic failover across 300+ models when a provider goes down
- **Multi-agent** — spawn parallel agents, chain tasks, coordinate teams

## Get started

**Option A — Use the Aery Gateway (recommended)**

1. Go to [aery-web.pages.dev](https://aery-web.pages.dev), enter your provider keys, get an Aery key
2. In Aery: `/login` → **Aery Gateway** → paste your key → pick a model

**Option B — Use your own API keys directly**

```bash
aery
# /login → pick a provider → enter your API key
```

## What makes it different

**Knowledge graph** — run `/graphify` on any project and Aery builds a persistent graph of your codebase. God nodes, community detection, cross-file connections. Ask architecture questions weeks later without re-reading everything.

**Multi-agent** — `/agent spawn` creates parallel agents working on different parts of the same problem. `/agent-chain` sequences tasks. `/agent-teams` coordinates specialist agents.

**Circuit breaker** — when a provider returns errors, Aery automatically routes to the next available model. Your work continues uninterrupted.

**Extensions** — everything is extensible. Drop a `.ts` file in `~/.aery/extensions/` and it loads on next start.

## Providers

Anthropic, OpenAI, Google Gemini, AWS Bedrock, Azure OpenAI, Mistral, Groq, Fireworks, Together AI, OpenRouter, Cloudflare Workers AI, xAI, Moonshot, Xiaomi MiMo, Codex, GitHub Copilot, and more.

## License

MIT
