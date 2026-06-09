import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import { isCompiledBinary } from "@aryee337/aery-utils";

const IS_COMPILED_BINARY = isCompiledBinary();

// Canonical scope for in-process packages. All plugins are remapped to this
// scope and resolved against the bundled copy inside the aery binary so they
// share a single module registry and tool registry regardless of their
// peerDependencies.
const CANONICAL_UPSTREAM_SCOPE = "@aery";

// Scope aliases that are redirected to the canonical scope. Direct imports
// using these aliases pass through the host-bundled package resolution path
// instead of pulling a duplicate copy from plugin node_modules.
const LEGACY_SCOPE_ALIASES = ["aery"] as const;

// Aery-native package basenames bundled inside the aery binary.
const AERY_PACKAGE_NAMES = [
	"aery-core",
	"aery-ai",
	"aery-coding-agent",
	"aery-engine",
	"aery-tui",
	"aery-utils",
	"aery-sdk",
] as const;

const AERY_SCOPE_ALTERNATION = LEGACY_SCOPE_ALIASES.join("|");
const AERY_PACKAGE_ALTERNATION = AERY_PACKAGE_NAMES.join("|");

// Subpath remaps: `<pkg>/<from>` → `<pkg>/<to>` after the scope has been
// canonicalised, so plugins importing relocated subpaths still resolve to a
// real file in the bundled copy. Add new entries whenever a plugin surfaces a
// subpath that has been moved inside the bundled packages.
const AERY_SUBPATH_REMAPS: ReadonlyMap<string, string> = new Map<string, string>([
	// aery-ai/oauth re-exported `./utils/oauth/index.js`.
	// The bundled copy keeps the implementation under `utils/oauth` but never
	// added a root-level re-export, so map the short subpath onto it directly.
	["aery-ai/oauth", "aery-ai/utils/oauth"],
	// aery-sdk/tools lives under src/tools in the bundled package.
	["aery-sdk/tools", "aery-sdk/src/tools"],
]);

const AERY_MODULE_SPECIFIER_FILTER = new RegExp(
	`^@(?:${AERY_SCOPE_ALTERNATION})/(?:${AERY_PACKAGE_ALTERNATION})(?:/.*)?$`,
);
const AERY_IMPORT_SPECIFIER_REGEX = new RegExp(
	`((?:from\\s+|import\\s*\\(\\s*)["'])(@(?:${AERY_SCOPE_ALTERNATION})/(?:${AERY_PACKAGE_ALTERNATION})(?:/[^"'()\\s]+)?)(["'])`,
	"g",
);
const resolvedAerySpecifierCache = new Map<string, string>();

// Extensions that imported `@sinclair/typebox` directly used to resolve
// against a real `@sinclair/typebox` install. The runtime dep was replaced
// with the Zod-backed shim under `extensibility/typebox.ts`; plugins still
// importing the public name are redirected to that shim so existing extensions
// keep working without code changes. Submodules like
// `@sinclair/typebox/compiler` are intentionally not remapped — those expose
// TypeBox-only APIs the shim does not provide and plugins relying on them must
// vendor `@sinclair/typebox` directly.
const TYPEBOX_SPECIFIER_FILTER = /^@sinclair\/typebox$/;

// Compat shim and bundled-package paths used in compiled-binary mode. The shim
// paths must point at files that ship inside the bunfs root; in dev /
// source-link / installed-package mode the canonical specifier resolves via
// `Bun.resolveSync` so only the shim files need explicit paths there.
//
// `BUNFS_PACKAGE_ROOT` is derived from `import.meta.dir` rather than hardcoded
// as `/$bunfs/root/packages` so the prefix stays platform-native: on Windows
// the bunfs mount appears as `<drive>:\~BUN\root\…` (see oven-sh/bun#15766),
// and a hardcoded POSIX literal would normalize to `\$bunfs\root\…` and fail
// to resolve. Compiled Bun modules currently report the bunfs root itself from
// `import.meta.dir`, so appending `packages` lands on the `--root ../..`
// package directory used by `scripts/build-binary.ts`.
//
// Every shim listed below must also be registered as an explicit `--compile`
// entrypoint in `scripts/build-binary.ts` or release builds fail with
// missing-module errors. Non-shim bundled packages are resolved via
// `Bun.resolveSync` (see `resolveCanonicalAerySpecifier`) outside compiled
// mode, so they keep working when on-disk layout differs from the monorepo
// tree.
/**
 * Compute the bunfs package root from the compiled binary's `import.meta.dir`
 * (or any stand-in supplied by tests). Bun 1.3 reports the bunfs mount root
 * (`/$bunfs/root` or `<drive>:\~BUN\root`) for imported modules as well as the
 * entrypoint, so the normal path is `<root>/packages`.
 *
 * The suffix branch preserves correctness if a future Bun release switches to
 * module-specific `import.meta.dir` values inside compiled binaries, matching
 * the source layout:
 * `<bunfs>/packages/coding-agent/src/extensibility/plugins`.
 *
 * Exported for tests; production callers use `BUNFS_PACKAGE_ROOT` below.
 */
export function __computeBunfsPackageRoot(metaDir: string, pathImpl: typeof path = path): string {
	const pluginsDirSuffix = pathImpl.join("packages", "coding-agent", "src", "extensibility", "plugins");
	const normalizedMetaDir = pathImpl.normalize(metaDir);
	if (normalizedMetaDir.endsWith(pluginsDirSuffix)) {
		return pathImpl.resolve(metaDir, "..", "..", "..", "..");
	}
	return pathImpl.join(metaDir, "packages");
}

const BUNFS_PACKAGE_ROOT = IS_COMPILED_BINARY ? __computeBunfsPackageRoot(import.meta.dir) : null;

function bunfsPath(...segments: string[]): string {
	if (!BUNFS_PACKAGE_ROOT) {
		throw new Error("bunfsPath is only valid in compiled-binary mode");
	}
	return path.join(BUNFS_PACKAGE_ROOT, ...segments);
}

const TYPEBOX_SHIM_PATH = BUNFS_PACKAGE_ROOT
	? bunfsPath("coding-agent", "src", "extensibility", "typebox.js")
	: path.resolve(import.meta.dir, "../typebox.ts");

// Legacy extensions historically imported `Type` (and `Static`/`TSchema`)
// from the package root of `@(scope)/aery-ai`. aery-ai 15.1.0 removed the
// runtime `Type` export, so the bare canonical specifier no longer satisfies
// those imports. The override below redirects only the bare aery-ai package
// root onto a sibling shim that re-exports the canonical surface plus the
// borrowed `Type` runtime from the Zod-backed TypeBox shim. Subpath imports
// such as `@aryee337/aery-ai/utils/oauth` continue to resolve directly against
// the bundled aery-ai package.
const AERY_AI_SHIM_PATH = BUNFS_PACKAGE_ROOT
	? bunfsPath("coding-agent", "src", "extensibility", "upstream-ai-shim.js")
	: path.resolve(import.meta.dir, "../upstream-ai-shim.ts");

// The coding-agent's own `./src/index.ts` cannot be listed as an extra
// `bun --compile` entrypoint alongside the CLI entry without breaking binary
// startup (issue #1474 follow-up). Legacy `@(scope)/aery-coding-agent` root
// imports therefore resolve through a sibling shim whose distinct file path
// avoids that collision while re-exporting the canonical package surface.
const AERY_CODING_AGENT_SHIM_PATH = BUNFS_PACKAGE_ROOT
	? bunfsPath("coding-agent", "src", "extensibility", "upstream-coding-agent-shim.js")
	: path.resolve(import.meta.dir, "../upstream-coding-agent-shim.ts");

// Package-root overrides. Shim entries are always applied because they replace
// (or augment) the canonical surface even in non-compiled installs. The bunfs
// entries are added only in compiled-binary mode — in dev / source-link /
// installed-package mode the canonical specifier resolves cleanly through
// `Bun.resolveSync`, and hardcoding a relative source-tree path would break
// installs where the bundled packages live at `node_modules/@aryee337/aery-*`
// rather than `packages/*`.
const AERY_PACKAGE_ROOT_OVERRIDES: Record<string, string> = {
	[`${CANONICAL_UPSTREAM_SCOPE}/aery-ai`]: AERY_AI_SHIM_PATH,
	[`${CANONICAL_UPSTREAM_SCOPE}/aery-coding-agent`]: AERY_CODING_AGENT_SHIM_PATH,
	...(BUNFS_PACKAGE_ROOT
		? {
				[`${CANONICAL_UPSTREAM_SCOPE}/aery-core`]: bunfsPath("agent", "src", "index.js"),
				[`${CANONICAL_UPSTREAM_SCOPE}/aery-engine`]: bunfsPath("natives", "native", "index.js"),
				[`${CANONICAL_UPSTREAM_SCOPE}/aery-tui`]: bunfsPath("tui", "src", "index.js"),
				[`${CANONICAL_UPSTREAM_SCOPE}/aery-utils`]: bunfsPath("utils", "src", "index.js"),
			}
		: {}),
};

let isAeryModuleResolverInstalled = false;

function remapAeryModuleSpecifier(specifier: string): string | null {
	if (!AERY_MODULE_SPECIFIER_FILTER.test(specifier)) {
		return null;
	}
	const slashIdx = specifier.indexOf("/", 1);
	// Filter guarantees a slash exists, but guard anyway to keep the type narrow.
	if (slashIdx === -1) {
		return null;
	}
	const rest = specifier.slice(slashIdx + 1);
	const remappedSubpath = AERY_SUBPATH_REMAPS.get(rest) ?? rest;
	return `${CANONICAL_UPSTREAM_SCOPE}/${remappedSubpath}`;
}

function getResolvedSpecifier(specifier: string): string {
	const cached = resolvedAerySpecifierCache.get(specifier);
	if (cached) {
		return cached;
	}

	const resolved = Bun.resolveSync(specifier, import.meta.dir);
	resolvedAerySpecifierCache.set(specifier, resolved);
	return resolved;
}

/**
 * Resolve a canonical `@aryee337/*` specifier to a filesystem path, preferring
 * a bundled compat shim when one is registered for the package root.
 *
 * Falls back to `getResolvedSpecifier` (which may throw under compiled binary
 * mode); callers handle that the same way they would for non-overridden
 * specifiers.
 */
function resolveCanonicalAerySpecifier(remappedSpecifier: string): string {
	const override = AERY_PACKAGE_ROOT_OVERRIDES[remappedSpecifier];
	if (override) {
		return override;
	}
	return getResolvedSpecifier(remappedSpecifier);
}

function toImportSpecifier(resolvedPath: string): string {
	return url.pathToFileURL(resolvedPath).href;
}

function rewriteAeryModuleImports(source: string): string {
	return source.replace(AERY_IMPORT_SPECIFIER_REGEX, (match, prefix: string, specifier: string, suffix: string) => {
		const remappedSpecifier = remapAeryModuleSpecifier(specifier);
		if (!remappedSpecifier) {
			return match;
		}

		try {
			return `${prefix}${toImportSpecifier(resolveCanonicalAerySpecifier(remappedSpecifier))}${suffix}`;
		} catch {
			// Resolution failed — typically in compiled binary mode where
			// Bun.resolveSync cannot walk up from /$bunfs/root to find the
			// bundled node_modules. Leave the specifier unchanged so Bun
			// resolves it natively against the extension's own peer deps.
			return match;
		}
	});
}

// Match the bare `@sinclair/typebox` import specifier (static + dynamic).
// Subpath imports like `@sinclair/typebox/compiler` are intentionally excluded —
// they expose TypeBox-only APIs the Zod-backed shim does not provide.
const TYPEBOX_IMPORT_SPECIFIER_REGEX = /((?:from\s+|import\s*\(\s*)["'])(@sinclair\/typebox)(["'])/g;

/**
 * Rewrite legacy package imports an Aery extension may contain:
 *  - Old scope aliases (`@(scope)/aery-*`) → absolute `file://` URLs pointing
 *    at the bundled package or compat shim.
 *  - Bare `@sinclair/typebox` root → the Zod-backed TypeBox shim.
 *  - Obsolete legacy scope references →
 *    `@aryee337/aery-*` equivalents.
 *  - Legacy OMP UI component names → Aery FlexBox component names.
 *
 * Every other specifier (relative siblings, the extension's own bare
 * dependencies) is left untouched so Bun resolves it natively from the
 * extension's real on-disk location.
 */
function rewriteLegacyExtensionSource(source: string): string {
	// Rewrite old npm-scope package references first, before the scope-alias
	// regex runs, so the output feeds cleanly into the next rewrite stage.
	const withOldScopes = source.replace(/@(?:aryee337)\/aery-(?:core|ai|coding-agent|tui|utils)/g, match => {
		const pkg = match.split("/")[1].replace("aery-", "aery-");
		return `@aryee337/${pkg}`;
	});

	const withAery = rewriteAeryModuleImports(withOldScopes);
	const withTypebox = withAery.replace(
		TYPEBOX_IMPORT_SPECIFIER_REGEX,
		(_match, prefix: string, _specifier: string, suffix: string) => {
			return `${prefix}${toImportSpecifier(TYPEBOX_SHIM_PATH)}${suffix}`;
		},
	);

	// Rewrite legacy OMP UI components to Aery FlexBox components.
	return withTypebox
		.replace(/\bContainer\b/g, "AeryScreen")
		.replace(/\bCustomEditor\b/g, "AeryScreen")
		.replace(/\bstatusContainer\b/g, "AeryBar");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Match relative import specifiers (static `from "./…"` and dynamic
// `import("./…")`). Used to walk an extension's own module graph; bare and
// absolute specifiers are deliberately excluded.
const RELATIVE_IMPORT_SPECIFIER_REGEX = /(?:from\s+|import\s*\(\s*)["'](\.\.\?\/[^"']+)["']/g;

// Extension entry realpaths that already have a load-time rewrite hook
// installed. Each `Bun.plugin()` registration is process-global and permanent,
// so we register at most one hook per entry.
const hookedExtensionEntries = new Set<string>();

/** Resolve symlinks in a path, falling back to the input if realpath fails. */
async function realpathOrSelf(p: string): Promise<string> {
	try {
		return await fs.realpath(p);
	} catch {
		return p;
	}
}

/**
 * Walk the extension's relative-import graph starting at `entryRealPath`,
 * returning the realpath of every reachable source module. Only relative
 * specifiers (`./`, `../`) are followed — bare and absolute imports are left to
 * Bun's native resolver — so the set is exactly the extension's own source,
 * wherever it physically lives (a `../src` sibling, a symlinked sub-tree, …).
 */
async function collectExtensionModules(entryRealPath: string): Promise<Set<string>> {
	const modules = new Set<string>();
	const queue = [entryRealPath];
	while (queue.length > 0) {
		const file = queue.pop();
		if (!file || modules.has(file)) {
			continue;
		}
		let source: string;
		try {
			source = await Bun.file(file).text();
		} catch {
			continue;
		}
		modules.add(file);
		const dir = path.dirname(file);
		for (const match of source.matchAll(RELATIVE_IMPORT_SPECIFIER_REGEX)) {
			try {
				const resolved = await realpathOrSelf(Bun.resolveSync(match[1], dir));
				if (!modules.has(resolved)) {
					queue.push(resolved);
				}
			} catch {
				// Unresolvable relative import (e.g. a type-only path); skip it.
			}
		}
	}
	return modules;
}

/**
 * Install a `Bun.plugin()` `onLoad` hook scoped to exactly the modules in an
 * extension's relative-import graph so their legacy `@(scope)/aery-*` and bare
 * `@sinclair/typebox` imports are rewritten at load time. A runtime `onLoad`
 * cannot fall through (Bun requires a result object), so the filter is an
 * exact-path alternation of the graph's realpaths — it never matches the host,
 * other extensions, `node_modules` deps, or unrelated project source.
 */
async function ensureExtensionGraphHook(entryRealPath: string): Promise<void> {
	if (hookedExtensionEntries.has(entryRealPath)) {
		return;
	}
	hookedExtensionEntries.add(entryRealPath);

	const modules = await collectExtensionModules(entryRealPath);
	const alternation = [...modules].map(escapeRegExp).join("|");
	const filter = new RegExp(`^(?:${alternation})$`);
	Bun.plugin({
		name: `aery:ext-loader:${Bun.hash(entryRealPath).toString(36)}`,
		setup(build) {
			build.onLoad({ filter, namespace: "file" }, async args => {
				// Re-read on every load so a `?mtime` reload picks up edited source.
				const raw = await Bun.file(args.path).text();
				return { contents: rewriteLegacyExtensionSource(raw), loader: getLoader(args.path) };
			});
		},
	});
}

/**
 * Load an Aery extension module from its real on-disk location.
 *
 * The extension runs in place, so its `import.meta.url` is the real source
 * file and `__dirname`-relative `readFileSync` asset loads (HTML/CSS bundled
 * next to the entry) resolve exactly as they do under the Aery runtime — no
 * temp-directory mirroring and no asset copying. An `onLoad` hook scoped to
 * the entry's relative-import graph rewrites only the legacy `@(scope)/aery-*`
 * and `@sinclair/typebox` imports in the extension's own source; everything
 * else resolves natively.
 */
export async function loadAeryExtensionModule(resolvedPath: string): Promise<unknown> {
	// Bun reports the realpath of a loaded module to `onLoad` and exposes it as
	// `import.meta.url`. Resolve symlinks here too (macOS `/var`→`/private/var`,
	// `bun link`/pnpm installs) so the rewrite filter matches the path Bun
	// actually hands the hook.
	const entryRealPath = await realpathOrSelf(path.resolve(resolvedPath));
	await ensureExtensionGraphHook(entryRealPath);
	// `?mtime` busts Bun's module cache so repeat loads pick up edited source.
	return import(`${toImportSpecifier(entryRealPath)}?mtime=${Date.now()}`);
}

function getLoader(filePath: string): "js" | "jsx" | "ts" | "tsx" {
	if (filePath.endsWith(".tsx")) {
		return "tsx";
	}
	if (filePath.endsWith(".jsx")) {
		return "jsx";
	}
	if (filePath.endsWith(".ts") || filePath.endsWith(".mts") || filePath.endsWith(".cts")) {
		return "ts";
	}
	return "js";
}

function resolveAeryModuleSpecifier(args: { path: string; importer: string }): { path: string } | undefined {
	const remappedSpecifier = remapAeryModuleSpecifier(args.path);
	if (!remappedSpecifier) {
		return undefined;
	}

	// Primary: resolve the canonical @aryee337/* specifier from the host binary
	// location. Works in dev mode and in source-link installs.
	try {
		return { path: resolveCanonicalAerySpecifier(remappedSpecifier) };
	} catch {
		// Fallback for compiled binary mode: the bundled packages live inside
		// /$bunfs/root and aren't reachable by filesystem resolution. Prefer the
		// canonical specifier against the importing file's directory when the
		// plugin installed @aery peer deps, then try the original specifier for
		// plugins that still vendor older scope peer deps.
		const importerDir = path.dirname(args.importer);
		try {
			return { path: Bun.resolveSync(remappedSpecifier, importerDir) };
		} catch {
			try {
				return { path: Bun.resolveSync(args.path, importerDir) };
			} catch {
				return undefined;
			}
		}
	}
}

function resolveTypeBoxSpecifier(): { path: string } {
	return { path: TYPEBOX_SHIM_PATH };
}

/**
 * Install the Aery module resolver as a process-global `Bun.plugin()`.
 *
 * Intercepts `@aery/<package>` import specifiers at the module level and
 * remaps them to the bundled `@aryee337/aery-*` packages so every extension
 * shares a single module registry and tool registry regardless of its own
 * peerDependencies. Also redirects bare `@sinclair/typebox` imports to the
 * Zod-backed shim. Safe to call multiple times — the plugin is registered only
 * once per process.
 */
export function installAeryModuleResolver(): void {
	if (isAeryModuleResolverInstalled) {
		return;
	}
	isAeryModuleResolverInstalled = true;

	Bun.plugin({
		name: "aery:module-resolver",
		setup(build) {
			build.onResolve({ filter: AERY_MODULE_SPECIFIER_FILTER, namespace: "file" }, resolveAeryModuleSpecifier);
			build.onResolve({ filter: TYPEBOX_SPECIFIER_FILTER, namespace: "file" }, resolveTypeBoxSpecifier);
		},
	});
}

/** Test seam: clears the memoised canonical specifier resolutions. */
export function __resetAeryModuleResolverCache(): void {
	resolvedAerySpecifierCache.clear();
}
