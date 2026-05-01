---
name: aery
description: >
  Aery monorepo assistant. Use when working on the Aery project — building
  features, fixing bugs, adding LLM providers, writing tests, reviewing PRs,
  or making architectural decisions across packages (ai, agent, coding-agent,
  tui, web-ui, mom, pods). Activate with /aery or when user mentions Aery,
  pi, coding-agent, or any aery package.
metadata:
  author: aryee
  version: "1.0"
---

# Aery

Aery is a TypeScript monorepo for an AI coding agent (called "pi" in the TUI).
Packages: `ai`, `agent`, `coding-agent`, `tui`, `web-ui`, `mom`, `pods`.

See `references/architecture.md` for package responsibilities and data flow.
See `references/conventions.md` for code rules, git rules, and workflows.

## Specialist agents

Switch to the right agent for focused work:
- `aery-core` — cross-package, git, issues, PRs, root config
- `aery-ai` — packages/ai, LLM providers, model registry
- `aery-agent` — packages/agent, core loop, tool execution
- `aery-tui` — packages/tui, packages/web-ui, keybindings
- `aery-mom` — packages/mom, Slack bot, multi-agent orchestration
- `aery-pods` — packages/pods, GPU pod management, vLLM
- `aery-review` — read-only code review, PR analysis

## Key rules (always apply)

- `npm run check` after every code change. Fix all errors before stopping.
- Never run `npm run dev`, `npm run build`, or `npm test` directly.
- No `any` types. No inline/dynamic imports. No hardcoded keybindings.
- All keybindings go in `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS`.
- Never `git add -A` — stage only files you changed.
- Never commit unless the user asks.

## Adding a new LLM provider

Follow the 7-step checklist in `references/architecture.md#adding-a-provider`.

## Testing

Run specific test files from the package root:
```bash
npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts
```
Use `test/suite/harness.ts` + faux provider for coding-agent suite tests.
Never use real API keys in tests.
