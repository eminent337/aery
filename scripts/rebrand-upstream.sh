#!/usr/bin/env bash
# rebrand-upstream.sh — Single source of truth for pi→aery rebranding rules.
# Used by both upstream-sync.yml and backfill-upstream.yml.
#
# Usage:
#   ./scripts/rebrand-upstream.sh                    # Rebrand files in packages/
#   ./scripts/rebrand-upstream.sh --patch /tmp/p.patch  # Rebrand a patch file

set -euo pipefail

apply_to_files() {
  find packages -name "*.ts" -o -name "*.json" -o -name "*.md" | \
    grep -v "node_modules\|dist\|CHANGELOG" | \
    xargs sed -i \
      -e 's|@mariozechner/pi-coding-agent|@eminent337/aery|g' \
      -e 's|@mariozechner/pi-agent-core|@eminent337/aery-core|g' \
      -e 's|@mariozechner/pi-ai|@eminent337/aery-ai|g' \
      -e 's|@earendil-works/pi-coding-agent|@eminent337/aery|g' \
      -e 's|@earendil-works/pi-agent-core|@eminent337/aery-core|g' \
      -e 's|@earendil-works/pi-ai|@eminent337/aery-ai|g' \
      -e 's|@mariozechner/pi-mom|@eminent337/aery-mom|g' \
      -e 's|@mariozechner/pi-web-ui|@eminent337/aery-web-ui|g' \
      -e 's|@mariozechner/pi-agent-old|@eminent337/aery-agent-old|g' \
      -e 's|@mariozechner/pi\b|@eminent337/aery-pods|g' \
      -e 's|badlogic/pi-mono|eminent337/aery|g' \
      -e 's|earendil-works/pi-mono|eminent337/aery|g' \
      -e 's|pi\.dev|eminent337.github.io|g' \
      -e 's|pi-extension-|aery-extension-|g' \
      -e 's|pi-debug\.log|aery-debug.log|g' \
      -e 's|pi-crash\.log|aery-crash.log|g' \
      -e 's|https://pi\.dev/api/latest-version|https://registry.npmjs.org/@eminent337/aery/latest|g' \
      -e 's|PI_CODING_AGENT_SESSION_DIR|AERY_CODING_AGENT_SESSION_DIR|g' \
      -e 's|PI_CODING_AGENT_DIR|AERY_CODING_AGENT_DIR|g' \
      -e 's|PI_CODING_AGENT\b|AERY_CODING_AGENT|g' \
      -e 's|PI_SKIP_VERSION_CHECK|AERY_SKIP_VERSION_CHECK|g' \
      -e 's|PI_OFFLINE|AERY_OFFLINE|g' \
      -e 's|PI_CONFIG_DIR|AERY_CONFIG_DIR|g' \
      -e 's|PI_AGENT_DIR|AERY_AGENT_DIR|g' \
      -e 's|PI_TELEMETRY|AERY_TELEMETRY|g' \
      -e 's|PI_PACKAGE_DIR|AERY_PACKAGE_DIR|g' \
      -e 's|PI_CACHE_RETENTION|AERY_CACHE_RETENTION|g' \
      -e 's|PI_HARDWARE_CURSOR|AERY_HARDWARE_CURSOR|g' \
      -e 's|PI_CLEAR_ON_SHRINK|AERY_CLEAR_ON_SHRINK|g' \
      -e 's|PI_DEBUG_REDRAW|AERY_DEBUG_REDRAW|g' \
      -e 's|PI_TUI_DEBUG|AERY_TUI_DEBUG|g' \
      -e 's|PI_TUI_WRITE_LOG|AERY_TUI_WRITE_LOG|g' \
      -e 's|PI_OAUTH_CALLBACK_HOST|AERY_OAUTH_CALLBACK_HOST|g' \
      -e 's|PI_AI_ANTIGRAVITY_VERSION|AERY_AI_ANTIGRAVITY_VERSION|g' \
      -e 's|PI_API_KEY|AERY_API_KEY|g' \
      -e 's|PI_SHARE_VIEWER_URL|AERY_SHARE_VIEWER_URL|g' \
      -e 's|PI_TIMING|AERY_TIMING|g' \
      -e 's|PI_WSL_CLIPBOARD_IMAGE_PATH|AERY_WSL_CLIPBOARD_IMAGE_PATH|g' \
      -e 's|PI_SPAWN_HOOK|AERY_SPAWN_HOOK|g' \
      -e 's|PI_NO_LOCAL_LLM|AERY_NO_LOCAL_LLM|g' \
      -e 's|PI_VERSION|AERY_VERSION|g' \
      -e 's|PI_STARTUP_BENCHMARK|AERY_STARTUP_BENCHMARK|g' \
      -e 's|PI_IMAGE_SAVE_MODE|AERY_IMAGE_SAVE_MODE|g' \
      -e 's|PI_IMAGE_SAVE_DIR|AERY_IMAGE_SAVE_DIR|g' \
      -e 's|interface PiManifest|interface AeryManifest|g' \
      -e 's|PiManifest\b|AeryManifest|g' \
      -e 's|readPiManifest\b|readAeryManifest|g' \
      -e 's|readPiManifestFile\b|readAeryManifestFile|g' \
      -e 's|piConfig\b|aeryConfig|g' \
      -e 's|piConfigName\b|aeryConfigName|g' \
      -e 's|pkg\.pi\b|pkg.aery|g' \
      -e 's|"X-OpenRouter-Title": "pi"|"X-OpenRouter-Title": "aery"|g' \
      -e 's|originator: string = "pi"|originator: string = "aery"|g' \
      -e 's|command: "pi"|command: "aery"|g' \
      -e 's|\.toBe("pi")|.toBe("aery")|g' \
      -e "s|\.toBe('pi')|.toBe('aery')|g" \
      -e 's|pi-test-auth|aery-test-auth|g' \
      -e 's|pi-test-model|aery-test-model|g' \
      -e 's|pi-test-prompts|aery-test-prompts|g' \
      -e 's|\.pi/extensions|.aery/extensions|g' \
      -e 's|\.pi/|.aery/|g' \
      -e 's|\.pi/skills|.aery/skills|g' \
      -e 's|\.pi/prompts|.aery/prompts|g' \
      -e 's|\.pi/themes|.aery/themes|g' \
      -e 's|\.pi/sessions|.aery/sessions|g' \
      -e 's|\.pi/settings|.aery/settings|g' \
      -e 's|\.pi/git|.aery/git|g' \
      -e 's|\.pi/npm|.aery/npm|g' \
      -e 's|\.pi/agents|.aery/agents|g' \
      -e 's|\.pi/hooks|.aery/hooks|g' \
      -e 's|\.pi/tools|.aery/tools|g' \
      -e 's|\.pi/commands|.aery/commands|g' \
      -e 's|\.pi/presets|.aery/presets|g' \
      -e 's|\.pi/sandbox|.aery/sandbox|g' \
      -e 's|\.pi/config|.aery/config|g' \
      -e 's|"\.pi"|".aery"|g' \
      -e "s|'\\.pi'|'.aery'|g" \
      -e 's|~/\.pi\b|~/.aery|g' \
      2>/dev/null || true

  # Targeted perl fixes for files with tricky patterns
  perl -pi -e 's|\.pi/|.aery/|g; s|"\.pi"|".aery"|g; s|`\.pi`|`.aery`|g; s|\(\.pi/|\(.aery/|g' \
      packages/coding-agent/src/config.ts \
      packages/coding-agent/src/core/package-manager.ts \
      packages/coding-agent/src/modes/interactive/components/config-selector.ts \
      packages/coding-agent/package.json \
      2>/dev/null || true

  # Deduplicate VIRTUAL_MODULES entries in loader.ts
  node -e "
    const fs = require('fs');
    const path = 'packages/coding-agent/src/core/extensions/loader.ts';
    if (!fs.existsSync(path)) process.exit(0);
    const lines = fs.readFileSync(path, 'utf-8').split('\n');
    const out = [];
    const seen = new Set();
    let inDedupeObject = false;
    for (const line of lines) {
      if (line.includes('const VIRTUAL_MODULES') || line.includes('_aliases = {')) {
        inDedupeObject = true;
        seen.clear();
      }
      if (inDedupeObject) {
        const match = line.match(/^(\s*)(\"[^\"]+\"|typebox):/);
        if (match) {
          if (seen.has(match[2])) continue;
          seen.add(match[2]);
        }
      }
      out.push(line);
      if (inDedupeObject && line.trim() === '};') inDedupeObject = false;
    }
    fs.writeFileSync(path, out.join('\n'));
  " || true

  # tsgo compatibility fix for proxy.ts
  node -e "
    const fs = require('fs');
    const p = 'packages/agent/src/proxy.ts';
    if (!fs.existsSync(p)) process.exit(0);
    let s = fs.readFileSync(p, 'utf-8');
    const orig = s;
    s = s.replace(/const response = await fetch\(/, 'const response = (await fetch(');
    s = s.replace(/signal: options\.signal,\n(\s*)\};/, 'signal: options.signal,\n$1})) as Response;');
    s = s.replace(/reader = response\.body!\.getReader\(\);/, 'const _rb = response.body; if (!_rb) throw new Error(\"no body\"); reader = _rb.getReader();');
    if (s !== orig) fs.writeFileSync(p, s);
  " || true
}

apply_to_patch() {
  local patch_file="$1"
  sed -i \
    -e 's|@mariozechner/pi-coding-agent|@eminent337/aery|g' \
    -e 's|@mariozechner/pi-agent-core|@eminent337/aery-core|g' \
    -e 's|@mariozechner/pi-ai|@eminent337/aery-ai|g' \
    -e 's|@earendil-works/pi-coding-agent|@eminent337/aery|g' \
    -e 's|@earendil-works/pi-agent-core|@eminent337/aery-core|g' \
    -e 's|@earendil-works/pi-ai|@eminent337/aery-ai|g' \
    -e 's|@mariozechner/pi-mom|@eminent337/aery-mom|g' \
    -e 's|@mariozechner/pi-web-ui|@eminent337/aery-web-ui|g' \
    -e 's|@mariozechner/pi-agent-old|@eminent337/aery-agent-old|g' \
    -e 's|@mariozechner/pi\b|@eminent337/aery-pods|g' \
    -e 's|badlogic/pi-mono|eminent337/aery|g' \
    -e 's|earendil-works/pi-mono|eminent337/aery|g' \
    -e 's|pi\.dev|eminent337.github.io|g' \
    -e 's|\.pi\.md|.aery.md|g' \
    -e 's|pi-extension-|aery-extension-|g' \
    -e 's|\.pi/agent|.aery/agent|g' \
    -e 's|pi-debug\.log|aery-debug.log|g' \
    -e 's|pi-crash\.log|aery-crash.log|g' \
    "$patch_file"
}

# Main
if [ "${1:-}" = "--patch" ] && [ -n "${2:-}" ]; then
  apply_to_patch "$2"
else
  apply_to_files
fi
