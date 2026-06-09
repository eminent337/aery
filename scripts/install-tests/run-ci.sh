#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT_DIR="$(pwd)"
WORK_DIR="$(mktemp -d)"
TMP_WORK_DIR="$WORK_DIR/tmp"
mkdir -p "$TMP_WORK_DIR"
export TMPDIR="$TMP_WORK_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

section() {
   echo ""
   echo "=== $1 ==="
}

smoke_cli() {
   local aery_bin="$1"
   local runtime_dir
   runtime_dir="$(mktemp -d "$WORK_DIR/compiled-runtime.XXXXXX")"
   XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$aery_bin" --version
   XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$aery_bin" --help >/dev/null
   XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$aery_bin" stats --summary >/dev/null
   # Spawns the stats sync worker via `new Worker(...)` and waits for a pong.
   # Regression probe for #1011 (browser tab worker) and #1027 (stats sync
   # worker) — both broke silently in compiled binaries because the `with
   # { type: "file" }` import pattern only copies the worker as a raw asset
   # without bundling its imports. `stats --summary` doesn't catch this on a
   # fresh install (no session files = no Worker spawn).
   XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$aery_bin" --smoke-test
}

find_tarball() {
   local pattern="$1"
   local matches=()
   shopt -s nullglob
   matches=("$pattern")
   shopt -u nullglob

   if [ "${#matches[@]}" -ne 1 ]; then
      echo "Expected exactly one tarball matching: $pattern"
      exit 1
   fi

   echo "${matches[0]}"
}

section "Binary install smoke"
bun --cwd=packages/aery-engine run build
bun --cwd=packages/coding-agent run build

BINARY_DIR="$WORK_DIR/binary-bin"
mkdir -p "$BINARY_DIR"
cp packages/coding-agent/dist/aery "$BINARY_DIR/aery"
smoke_cli "$BINARY_DIR/aery"

section "Source install smoke"
SOURCE_BUN_HOME="$WORK_DIR/bun-source"
(
   export BUN_INSTALL="$SOURCE_BUN_HOME"
   export PATH="$BUN_INSTALL/bin:$PATH"
   bun --cwd="$ROOT_DIR/packages/coding-agent" link
   smoke_cli "$BUN_INSTALL/bin/aery"
)

section "Tarball install smoke"
TARBALL_DIR="$WORK_DIR/tarballs"
mkdir -p "$TARBALL_DIR"
host_tag="$(bun -e "process.stdout.write(\`\${process.platform}-\${process.arch}\`)")"

# Native addon split: the published core ships only the loader (no `.node`); the
# prebuilt binary lives in a per-platform leaf package pulled in as an optional
# dependency. Reproduce that exact published topology so this smoke proves the
# installed core resolves its addon through the leaf, not a bundled binary.

# 1. Generate + pack the host-platform leaf (carries the built `.node`).
bun --cwd=packages/aery-engine run gen:npm --tag "$host_tag" >/dev/null
(
   cd "$ROOT_DIR/packages/aery-engine/npm/$host_tag"
   bun pm pack --destination "$TARBALL_DIR" --quiet >/dev/null
)

# 2. Pack the core with its *published* manifest: the same rewrite release uses
#    drops `.node` from `files` and adds the leaf `optionalDependencies`. Always
#    restore the working-tree manifest so local runs aren't left mutated.
natives_pkg_backup="$WORK_DIR/natives-package.json.orig"
cp "$ROOT_DIR/packages/aery-engine/package.json" "$natives_pkg_backup"
core_rc=0
{
   bun -e 'import { prepareNativeCorePackage } from "./scripts/ci-release-publish.ts"; await prepareNativeCorePackage("packages/aery-engine", true);' &&
      (cd "$ROOT_DIR/packages/aery-engine" && bun pm pack --destination "$TARBALL_DIR" --quiet >/dev/null)
} || core_rc=$?
cp "$natives_pkg_backup" "$ROOT_DIR/packages/aery-engine/package.json"
[ "$core_rc" -eq 0 ] || exit "$core_rc"

# 3. Pack the remaining workspace packages (natives core handled above).
for pkg in utils hashline ai mnemopi agent tui stats aery-sdk aery-extensions coding-agent; do
   (
      cd "$ROOT_DIR/packages/$pkg"
      bun pm pack --destination "$TARBALL_DIR" --quiet >/dev/null
   )
done

utils_tgz="$(find_tarball "$TARBALL_DIR"/aryee337-aery-utils-*.tgz)"
natives_tgz="$(find_tarball "$TARBALL_DIR"/aryee337-aery-engine-[0-9]*.tgz)"
natives_leaf_tgz="$(find_tarball "$TARBALL_DIR"/aryee337-aery-engine-"$host_tag"-*.tgz)"
hashline_tgz="$(find_tarball "$TARBALL_DIR"/aryee337-hashline-*.tgz)"
ai_tgz="$(find_tarball "$TARBALL_DIR"/aryee337-aery-ai-*.tgz)"
mnemopi_tgz="$(find_tarball "$TARBALL_DIR"/aryee337-aery-mnemopi-*.tgz)"
agent_tgz="$(find_tarball "$TARBALL_DIR"/aryee337-aery-core-*.tgz)"
tui_tgz="$(find_tarball "$TARBALL_DIR"/aryee337-aery-tui-*.tgz)"
stats_tgz="$(find_tarball "$TARBALL_DIR"/aryee337-aery-stats-*.tgz)"
sdk_tgz="$(find_tarball "$TARBALL_DIR"/aryee337-aery-sdk-*.tgz)"
extensions_tgz="$(find_tarball "$TARBALL_DIR"/aryee337-aery-extensions-*.tgz)"
coding_agent_tgz="$(find_tarball "$TARBALL_DIR"/aryee337-aery-[0-9]*.tgz)"

TARBALL_APP_DIR="$WORK_DIR/tarball-install"
mkdir -p "$TARBALL_APP_DIR"
(
   cd "$TARBALL_APP_DIR"
   bun init -y >/dev/null

   # Write overrides so bun resolves inter-package deps from tarballs, not the registry
   # (version 12.x.y hasn't been published yet when CI runs pre-release)
   node -e "
		const pkg = JSON.parse(require('fs').readFileSync('package.json', 'utf8'));
		pkg.overrides = {
			'@aryee337/aery-utils': '$utils_tgz',
			'@aryee337/aery-engine': '$natives_tgz',
			'@aryee337/aery-engine-$host_tag': '$natives_leaf_tgz',
			'@aryee337/hashline': '$hashline_tgz',
			'@aryee337/aery-ai': '$ai_tgz',
			'@aryee337/aery-mnemopi': '$mnemopi_tgz',
			'@aryee337/aery-core': '$agent_tgz',
			'@aryee337/aery-tui': '$tui_tgz',
			'@aryee337/aery-stats': '$stats_tgz',
			'@aryee337/aery-sdk': '$sdk_tgz',
			'@aryee337/aery-extensions': '$extensions_tgz',
			'@aryee337/aery': '$coding_agent_tgz'
		};
		require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2));
	"

   bun add "$utils_tgz" "$natives_tgz" "$hashline_tgz" "$ai_tgz" "$mnemopi_tgz" "$agent_tgz" "$tui_tgz" "$stats_tgz" "$sdk_tgz" "$extensions_tgz" "$coding_agent_tgz"
   # The platform leaf must arrive through the core's optionalDependencies +
   # override, not as a direct dependency — assert it landed before smoking so a
   # resolution regression is distinguishable from a runtime loader bug.
   leaf_dir="node_modules/@aryee337/aery-engine-$host_tag"
   [ -d "$leaf_dir" ] || {
      echo "Platform leaf package not installed: $leaf_dir"
      exit 1
   }
   smoke_cli ./node_modules/.bin/aery
)

echo ""
echo "All install method smoke tests passed"
