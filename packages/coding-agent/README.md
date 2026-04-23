> 🌐 **[eminent337.github.io](https://eminent337.github.io)** — Landing page

# Aery

> AI coding agent for the terminal. Built by Aryee.

[![npm version](https://img.shields.io/npm/v/@eminent337/aery?color=7eb8d4&label=version)](https://www.npmjs.com/package/@eminent337/aery)
[![npm downloads](https://img.shields.io/npm/dm/@eminent337/aery?color=7eb8d4&label=downloads)](https://www.npmjs.com/package/@eminent337/aery)
[![license](https://img.shields.io/npm/l/@eminent337/aery?color=7eb8d4)](https://github.com/eminent337/aery/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/eminent337/aery?color=7eb8d4)](https://github.com/eminent337/aery)

Aery is a powerful, extensible AI coding agent that lives in your terminal. It reads your codebase, edits files, runs commands, and manages git workflows through natural language — with automatic model failover across 300+ providers.

## Install

```bash
npm install -g @eminent337/aery
```

Or from source:

```bash
git clone https://github.com/eminent337/aery && cd aery && ./install.sh
```

## Quick Start

```bash
aery
```

## Why Aery?

- **Multi-provider** — works with NVIDIA, OpenRouter, Anthropic, OpenAI, Gemini, and 300+ more
- **Auto-router** — automatically picks the best model for each task (simple vs complex)
- **Model failover** — switches to next working model on rate limits or errors (402/429)
- **Free model support** — works with free OpenRouter models, handles their limitations automatically
- **27 extensions** — agent teams, loop scheduler, session memory, health scoring, and more

## Extensions

All features are implemented as extensions in `~/.aery/agent/extensions/`. Add your own or modify existing ones without touching the core.

## Configuration

```
~/.aery/agent/
├── settings.json    — theme, extensions, defaults
├── auth.json        — API keys
├── profiles.json    — provider profiles
├── models.json      — custom model definitions
└── AGENTS.md        — system prompt injected every session
```

## Key Commands

```
/provider     — switch provider/model profile
/loop 1h ...  — schedule recurring agent task
/health       — run code quality checks
/checkpoint   — save/restore working state
```

## License

MIT — see [LICENSE](LICENSE)
