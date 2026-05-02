---
name: aery
description: Aery monorepo assistant. Use when working on Aery — building features, fixing bugs, adding LLM providers, reviewing PRs, or making architectural decisions. Also activates for questions about packages ai, agent, coding-agent, tui, web-ui, mom, or pods.
---

# Aery

Aery is a TypeScript monorepo for an AI coding agent. Packages: `ai`, `agent`, `coding-agent`, `tui`, `web-ui`, `mom`, `pods`.

## Critical rules (always apply)

- `npm run check` after every code change — fix ALL errors/warnings/infos
- Never run `npm run dev`, `npm run build`, or `npm test` directly
- No `any` types. No inline imports. No hardcoded keybindings
- Never `git add -A` — stage only specific files you changed
- Never commit unless the user asks

## Specialist agents

Use these for focused work (via the subagent tool or `/implement`):

| Agent | Scope |
|-------|-------|
| `aery-core` | Cross-package, git, issues, PRs, root config |
| `aery-ai` | packages/ai, LLM providers, model registry |
| `aery-agent` | packages/agent, core loop, tool execution |
| `aery-tui` | packages/tui, packages/web-ui, keybindings |
| `aery-mom` | packages/mom, Slack bot, multi-agent |
| `aery-pods` | packages/pods, GPU pod management, vLLM |
| `aery-review` | Read-only code review, PR analysis |

## Workflow commands

- `/implement <task>` — scout → implement → review chain
- `/add-provider <name>` — full 7-step provider addition chain
- `/review-pr <number>` — audit a PR against Aery rules

## Package map

```
packages/
├── ai/            # LLM provider abstraction (stream(), events)
├── agent/         # Core agent loop (tool execution, context)
├── coding-agent/  # CLI, interactive mode, extensions, skills
├── tui/           # Terminal UI (Ink/React)
├── web-ui/        # Browser UI (Lit web components)
├── mom/           # Slack bot + multi-agent orchestration
└── pods/          # GPU pod management + vLLM deployment
```

## Adding a new LLM provider (7 steps)

1. `types.ts` — Api union, options interface, ApiOptionsMap, KnownProvider
2. `providers/<name>.ts` — stream(), streamSimple(), standard events
3. Exports: package.json subpath, index.ts export type, register-builtins.ts lazy, env-api-keys.ts
4. `generate-models.ts` — fetch/parse/map to Model interface
5. Tests — stream.test.ts + full matrix
6. coding-agent: model-resolver.ts, interactive-mode.ts, args.ts, docs/providers.md
7. Docs: packages/ai/README.md, CHANGELOG.md
