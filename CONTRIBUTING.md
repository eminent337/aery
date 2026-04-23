# Contributing to Aery

Thanks for your interest in contributing to Aery!

## The One Rule

**You must understand your code.** If you cannot explain what your changes do and how they interact with the rest of the system, your PR will be closed.

Using AI to write code is fine. Submitting AI-generated code without understanding it is not.

## Before You Start

1. **Open an issue first** — discuss the change before writing code
2. **Keep it small** — focused PRs get merged faster
3. **Follow the existing style** — match the codebase conventions

## Development Setup

```bash
git clone https://github.com/eminent337/aery.git
cd aery
npm install
```

## Before Submitting a PR

Run these commands from the repo root:

```bash
npm run check
./test.sh
```

Both must pass.

**Do not edit CHANGELOG.md** — changelog entries are added by maintainers.

## What Belongs Where

- **Core changes** — bug fixes, performance improvements, essential features
- **Extensions** — new commands, tools, integrations → submit to [aery-extensions](https://github.com/eminent337/aery-extensions)
- **Themes** — new color schemes → add to `packages/coding-agent/src/modes/interactive/theme/`

Aery's core is minimal. If your feature doesn't belong in the core, it should be an extension.

## Extension Contributions

To contribute an extension:

1. Fork [aery-extensions](https://github.com/eminent337/aery-extensions)
2. Add your extension to the appropriate pack (`core/`, `packs/full/`, or create a new pack)
3. Update `registry.json` if adding a new pack
4. Submit a PR

## Questions?

- **Issues** — [github.com/eminent337/aery/issues](https://github.com/eminent337/aery/issues)
- **Discussions** — [github.com/eminent337/aery/discussions](https://github.com/eminent337/aery/discussions)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
