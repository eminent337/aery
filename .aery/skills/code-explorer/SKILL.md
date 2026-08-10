---
name: code-explorer
description: Two-stage codebase explorer that first locates candidate files with a fuzzy file picker, then runs parallel ripgrep code searches to find precise symbol definitions and usages. Use before modifying unfamiliar code to avoid filling context with irrelevant files.
---

# Code Explorer & Symbol Ranking

Ported from Freebuff's `file-explorer/code-searcher.ts` + `file-explorer/file-picker-max.ts`.

Two-stage discovery pipeline:

1. **File Picker** — fuzzy-matches file names and directory names relevant to the prompt, returns a ranked list of up to 20 candidate paths.
2. **Code Searcher** — runs multiple ripgrep queries in parallel across the candidate files to surface exact symbol definitions, usages, and cross-references.

## When to Use

- Before touching any unfamiliar code area to avoid blind edits
- When you need to find all callers of a function across a large monorepo
- When you know the concept but not the file name
- Before writing a Ferment scope to understand which files will be affected

## How to Use

### Stage 1: Fuzzy File Discovery

```python
# ─── Stage 1: File Picker ─────────────────────────────────────────────────
import subprocess, os

REPO_ROOT = "/home/aryee/aery/ai_agent/aery"
PROMPT = "auto-router provider failover and tier candidate lists"

# Walk the file tree (respects .gitignore via git ls-files)
result = subprocess.run(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
    cwd=REPO_ROOT,
    capture_output=True,
    text=True,
)
all_files = [f for f in result.stdout.splitlines() if f.endswith((".ts", ".tsx", ".json", ".md"))]

# Use the AI to rank and select the top candidates
ranking_prompt = (
    f"You are a file picker agent. Given the file tree and prompt, select the 15 most relevant files.\n\n"
    f"Prompt: {PROMPT}\n\n"
    f"File tree (first 500 paths):\n"
    + "\n".join(all_files[:500])
    + "\n\nReturn ONLY a JSON array of selected file paths, most relevant first. No explanation."
)
ranking_raw = await rlm(ranking_prompt, model="google-antigravity/gemini-3.6-flash-high")

import json, re
match = re.search(r'\[[\s\S]*\]', ranking_raw)
candidate_files = json.loads(match.group()) if match else all_files[:15]
print(f"Stage 1 found {len(candidate_files)} candidate files:")
for f in candidate_files:
    print(f"  {f}")
```

### Stage 2: Precise Code Search

```python
# ─── Stage 2: Code Searcher (parallel ripgrep) ────────────────────────────
import asyncio

SEARCH_QUERIES = [
    # Define your patterns here:
    {"pattern": "REASONING_TIER_CANDIDATES", "flags": "-g *.ts"},
    {"pattern": "streamAutoRouter", "flags": "-g *.ts"},
    {"pattern": "failover|fallback", "flags": "-i -g *.ts"},
]

async def run_search(query: dict) -> dict:
    cmd = ["rg", query["pattern"]]
    if query.get("flags"):
        cmd += query["flags"].split()
    cmd += ["--max-count", str(query.get("maxResults", 15)), REPO_ROOT]
    result = subprocess.run(cmd, capture_output=True, text=True)
    lines = result.stdout.strip().splitlines()[:250]  # global 250-line cap
    return {"pattern": query["pattern"], "matches": lines}

searches = await asyncio.gather(*[run_search(q) for q in SEARCH_QUERIES])

for search in searches:
    if search["matches"]:
        print(f"\n### Pattern: `{search['pattern']}` ({len(search['matches'])} matches)")
        for line in search["matches"][:20]:
            print(f"  {line}")
```

### Combined: Full Explorer Pipeline

```python
# ─── Full two-stage explorer ──────────────────────────────────────────────

async def explore(prompt: str, search_queries: list[dict], repo_root: str = REPO_ROOT) -> dict:
    """
    Stage 1: fuzzy file picker
    Stage 2: parallel code searches
    Returns dict with candidate_files and search_results
    """
    # Stage 1: file picker
    result = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
        cwd=repo_root, capture_output=True, text=True,
    )
    all_files = [f for f in result.stdout.splitlines() if f.endswith((".ts", ".tsx", ".json", ".md"))]

    ranking_raw = await rlm(
        f"Select the 15 most relevant files for: {prompt}\n\nFiles:\n"
        + "\n".join(all_files[:500])
        + "\n\nReturn JSON array of paths only.",
        model="google-antigravity/gemini-3.6-flash-high",
    )
    match = re.search(r'\[[\s\S]*\]', ranking_raw)
    candidate_files = json.loads(match.group()) if match else all_files[:15]

    # Stage 2: code searches
    async def _search(q):
        cmd = ["rg", q["pattern"]] + (q.get("flags", "")).split() + [
            "--max-count", str(q.get("maxResults", 15)), repo_root
        ]
        res = subprocess.run(cmd, capture_output=True, text=True)
        return {"pattern": q["pattern"], "matches": res.stdout.strip().splitlines()[:250]}

    searches = await asyncio.gather(*[_search(q) for q in search_queries])

    return {"candidate_files": candidate_files, "search_results": searches}

# Example usage:
findings = await explore(
    prompt="provider authentication token handling and OAuth flow",
    search_queries=[
        {"pattern": "getAuthToken|loadCredential", "flags": "-g *.ts"},
        {"pattern": "Bearer", "flags": "-g *.ts"},
    ],
)
```

## Ferment Integration

Record the discovery findings so later phases can use them:

```python
await ferment_add_memory(
    f"Code Explorer found {len(findings['candidate_files'])} relevant files: "
    + ", ".join(findings['candidate_files'][:5])
)
```

## Pre-Built Search Query Recipes

```python
# Find all TypeScript exports matching a name
{"pattern": "export (function|const|class|type) MySymbol", "flags": "-g *.ts"}

# Find all imports of a module
{"pattern": "from ['\"].*my-module['\"]", "flags": "-g *.ts"}

# Find test files for a given feature
{"pattern": "describe.*autoRouter|it.*autoRouter", "flags": "-g *.test.ts"}

# Find all environment variable reads
{"pattern": "process\\.env\\.", "flags": "-g *.ts"}

# Find all TODO/FIXME comments
{"pattern": "TODO|FIXME|HACK", "flags": "-i -g *.ts"}
```

## Anti-Patterns

- Do NOT skip Stage 1 and search the entire repo with Stage 2 only; always pre-filter to candidate files first.
- Do NOT use more than 10 search queries per run; ripgrep is fast but parallel spawning has overhead.
- Do NOT trust Stage 1 alone for symbol-level discovery; always confirm with Stage 2 exact pattern matching.
- Do NOT set `maxResults` above 50 per file; it floods your context and hides the signal.
