# Aery Customizations

Aery is maintained as a product fork of an upstream AI coding agent. This file records intentional Aery-specific changes so upstream syncs can preserve them without turning the fork into untracked drift.

## Rules for Core Changes

- Prefer adding Aery logic in new modules, scripts, extensions, or workflow files.
- Touch upstream-owned core files only through small hook points.
- Do not rewrite upstream behavior unless the change is necessary for Aery users and has tests.
- Keep release, provider, branding, and extension behavior explicit in this file when it differs from upstream.
- Run `npm run check` before merging changes that affect TypeScript, package metadata, workflows, or release behavior.
- Keep this ledger valid; `npm run check` runs `scripts/check-aery-customizations.mjs`.
- Keep runtime source and tooling branded as Aery; `npm run check` runs `scripts/check-aery-branding.mjs`.
- Use `npm run ownership:report` before larger upstream merges or releases to review Aery-owned paths and recent changes.
- After upstream syncs, run `npm run release:verify` if package versions, tags, or release automation changed.

## Current Aery-Specific Areas

### Package and Release Identity

Aery publishes under the `@eminent337` npm scope. GitHub releases are expected to match the npm version.

Owned files and hooks:
- `package.json`
- `package-lock.json`
- `packages/*/package.json`
- `.github/workflows/*`
- `scripts/release.mjs`
- `scripts/verify-release.mjs`
- `scripts/check-aery-customizations.mjs`
- `scripts/check-aery-branding.mjs`
- `scripts/aery-ownership-report.mjs`

Verification:
- `npm run check`
- `npm run check:customizations`
- `npm run check:branding`
- `npm run ownership:report`
- `npm run release:verify`
- `npm view @eminent337/aery version`
- `gh release view v<version> --repo eminent337/aery`

### Core Extensions

Aery uses external core extensions from `aery-extensions`. Local health checks should detect missing extension files or missing settings entries without mutating user configuration unless a repair command explicitly does so.

Runtime/user config touched:
- `~/.aery/agent/settings.json`

Owned files and hooks:
- `packages/coding-agent/src/cli/doctor.ts`
- `packages/coding-agent/src/main.ts`
- `packages/coding-agent/src/cli/args.ts`
- `packages/coding-agent/src/core/slash-commands.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `packages/coding-agent/src/migrations.ts`

Verification:
- `AERY_OFFLINE=1 npx tsx packages/coding-agent/src/cli.ts doctor`
- `AERY_OFFLINE=1 npx tsx packages/coding-agent/src/cli.ts doctor --json`
- `npx vitest --run packages/coding-agent/test/doctor.test.ts`
- `npx vitest --run packages/coding-agent/test/slash-commands.test.ts`
- `npx vitest --run packages/coding-agent/test/core-extensions-migration.test.ts`

### Built-In Capability Visibility

Aery exposes a first-class capability report so users can inspect built-in tools, commands, resources, provider/model status, session intelligence, dynamic tool registration, and subagent/self-extension surfaces without treating Aery as only an extension host.
The report includes loaded extension names and exact extension load errors so extension health is inspectable from the CLI and JSON output.

Owned files and hooks:
- `packages/coding-agent/src/cli/capabilities.ts`
- `packages/coding-agent/src/cli/args.ts`
- `packages/coding-agent/src/main.ts`
- `packages/coding-agent/src/core/slash-commands.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

Verification:
- `AERY_OFFLINE=1 npx tsx packages/coding-agent/src/cli.ts capabilities`
- `AERY_OFFLINE=1 npx tsx packages/coding-agent/src/cli.ts capabilities --json`
- `npx vitest --run packages/coding-agent/test/capabilities.test.ts`

### Provider Setup and Cloudflare UX

Aery improves provider setup feedback, especially Cloudflare Workers AI, where both an API token and account ID are required. The `/login` flow should save credentials separately and report whether the provider exposes usable local models after authentication.
OpenAI-compatible provider errors should turn common authentication, billing/quota, rate-limit, and temporary server failures into actionable messages while preserving the raw provider error.

Owned files and hooks:
- `packages/coding-agent/src/core/provider-setup-check.ts`
- `packages/coding-agent/src/core/model-registry.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `packages/ai/src/providers/openai-completions.ts`

Verification:
- `npx vitest --run packages/coding-agent/test/provider-setup-check.test.ts`
- `npx vitest --run packages/coding-agent/test/model-registry.test.ts`
- `npx vitest --run packages/ai/test/openai-completions-thinking-as-text.test.ts`

### Upstream Sync

The upstream sync workflow should keep Aery changes on top of the upstream codebase. Sync conflict resolution should preserve this file's listed Aery behavior unless the maintainer intentionally removes or replaces it.

Owned files and hooks:
- `.github/workflows/upstream-sync.yml`

Verification:
- `gh workflow run "Upstream Sync" --repo eminent337/aery`
- `gh run watch --repo eminent337/aery <run-id> --exit-status`

### Intentional Upstream Compatibility

Some upstream names remain intentionally for compatibility with existing extensions, historical release notes, or sync automation. They are not Aery ownership drift.

Allowed compatibility:
- `pkg.pi` extension manifests remain accepted alongside `pkg.aery` so older extensions continue to load.
- Extension examples and tests may use a callback parameter named `pi` because that is part of the extension API vocabulary.
- Changelog and README history may reference upstream issue URLs or package names when describing inherited upstream changes.
- Upstream sync workflows may contain upstream repository names and rewrite rules because they are the controlled import path.

Owned files and hooks:
- `packages/coding-agent/src/core/package-manager.ts`
- `packages/coding-agent/src/core/extensions/loader.ts`
- `.github/workflows/upstream-sync.yml`
- `.github/workflows/backfill-upstream.yml`

Verification:
- `npm run check:branding`
- `npm run check`

## Adding New Aery Customizations

When adding an Aery-specific core behavior:

1. Put most logic in a new Aery-owned module when possible.
2. Keep upstream file edits minimal and easy to reapply.
3. Add a focused test for the Aery behavior.
4. Add or update a section in this file with owned files and verification commands.
5. Mention upstream sync risk in the PR or issue when the change touches upstream-owned files.

This keeps the fork useful without making future upstream updates expensive.
