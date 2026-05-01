# Aery Conventions

## Code style

- No `any` types unless absolutely necessary
- No inline imports: no `await import("./foo")`, no `import("pkg").Type` in type positions
- No dynamic imports for types — always top-level imports
- Never remove/downgrade code to fix type errors from outdated deps; upgrade the dep
- Always ask before removing intentional functionality
- No backward compatibility unless explicitly requested
- No hardcoded keybindings — all go in `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS`

## Commands

```bash
npm run check          # lint + typecheck + browser smoke — run after every code change
                       # get FULL output, never tail. Fix ALL errors/warnings/infos.
```

Never run: `npm run dev`, `npm run build`, `npm test`

Run specific tests from the package root:
```bash
npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts
```

## Git rules (CRITICAL — parallel agents may be working)

```bash
# Safe workflow
git status                          # check first
git add <specific-file-paths>       # ONLY your files
git commit -m "fix(pkg): message"   # include fixes #N if applicable
git pull --rebase && git push
```

**Never:**
- `git add -A` or `git add .`
- `git reset --hard`, `git checkout .`, `git clean -fd`
- `git stash` (stashes ALL agents' work)
- `git commit --no-verify`
- Force push

If rebase conflict is in a file you didn't modify — abort and ask the user.

## Commit messages

- `fix(pkg): description` for bug fixes
- `feat(pkg): description` for features
- Include `fixes #N` or `closes #N` when there's a related issue/PR
- No emojis, no fluff

## Issues and PRs

- Add `pkg:*` labels: `pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:mom`, `pkg:pods`, `pkg:tui`, `pkg:web-ui`
- Write comments to a temp file, post with `gh issue comment --body-file`
- Never pass multi-line markdown via `--body` in shell
- Post exactly one final comment unless user asks for more
- Never open PRs yourself — work in feature branches, merge to main when user approves

## Testing

- `packages/coding-agent/test/suite/` — use `harness.ts` + faux provider, no real API keys
- Issue regressions: `test/suite/regressions/<issue-number>-<short-slug>.test.ts`
- If you create/modify a test file, run it and iterate until it passes

## CHANGELOG format

Location: `packages/*/CHANGELOG.md`

Sections under `## [Unreleased]`:
- `### Breaking Changes`
- `### Added`
- `### Changed`
- `### Fixed`
- `### Removed`

Rules:
- New entries always under `## [Unreleased]`
- Append to existing subsections, never duplicate
- Never modify released version sections
- Internal: `Fixed foo ([#123](https://github.com/eminent337/aery/issues/123))`
- External: `Added X ([#456](...) by [@user](...))`

## Communication style

- Short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff ("Thanks so much!" → "Thanks @user")
- Technical prose only
