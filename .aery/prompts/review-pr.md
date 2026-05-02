---
name: review-pr
description: Review a pull request against Aery's rules. Pass the PR number or description.
---

Use aery-review to audit this PR:

PR: {task}

agent: aery-review
task: Review PR: {task}

Fetch the diff with `gh pr diff {task}` if it's a number, or analyze the described changes.

Check against the full Aery review checklist:
- No `any` types, no inline imports, no hardcoded keybindings
- npm run check passes
- Tests added for new functionality
- CHANGELOG.md updated under [Unreleased]
- Commit messages include fixes/closes references
- For new providers: all 7 steps complete

Report: blocking issues first, then non-blocking, then nits.
