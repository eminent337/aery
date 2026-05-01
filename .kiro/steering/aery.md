---
inclusion: always
---

aery: The Aery monorepo lives in `aery/`. It's a TypeScript AI coding agent (called "pi"). Packages: `ai` (LLM providers), `agent` (core loop), `coding-agent` (CLI/extensions), `tui` (terminal UI), `web-ui` (browser UI), `mom` (Slack bot / multi-agent), `pods` (GPU pod management).

Critical rules that always apply:
- Run `npm run check` after every code change (full output, fix all errors/warnings/infos)
- Never run `npm run dev`, `npm run build`, or `npm test`
- No `any` types, no inline imports, no hardcoded keybindings
- Never `git add -A` — stage only specific files you changed
- Never commit unless the user asks

Use `/aery` or switch to an aery-* agent for focused work:
- `aery-core` — cross-package, git, issues, PRs, root config
- `aery-ai` — packages/ai, LLM providers, model registry
- `aery-agent` — packages/agent, core loop, tool execution
- `aery-tui` — packages/tui, packages/web-ui, keybindings
- `aery-mom` — packages/mom, Slack bot, multi-agent orchestration
- `aery-pods` — packages/pods, GPU pod management, vLLM
- `aery-review` — read-only code review, PR analysis
