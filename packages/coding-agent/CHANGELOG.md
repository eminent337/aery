# Aery Changelog

## [Unreleased]

### Added
- Added `aery doctor` for non-mutating version, provider auth, and core extension health checks.
- Added a post-login provider setup check so `/login` confirms credentials expose usable local models.
- Added `/extensions doctor` in interactive mode for non-mutating core extension diagnostics.

## [0.1.14] - 2026-04-21

### Changed
- All packages renamed to `@eminent337` scope for consistency
- Published to npm: `npm install -g @eminent337/aery`

## [0.1.0] - 2026-04-20

### Initial Release
- First public release of Aery
- Built on aery 0.67.68 (upstream base)
- 27 extensions: auto-router, model failover, agent teams, loop scheduler, session memory, health scoring, damage control, circuit breaker, and more
- Aery theme (sky blue accents)
- Multi-provider support: NVIDIA, OpenRouter, Anthropic, OpenAI, Gemini, and more
- Automatic model failover on rate limits (402/429)
- Weekly upstream sync from upstream
