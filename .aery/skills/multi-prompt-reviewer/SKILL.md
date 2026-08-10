---
name: multi-prompt-reviewer
description: Spawn multiple parallel code-reviewer agents, each with a different review focus, then merge all findings into a single comprehensive review. Use after writing or refactoring code to catch correctness issues, security problems, and style violations from multiple angles simultaneously.
---

# Multi-Prompt Code Reviewer

Ported from Freebuff's `reviewer/multi-prompt/code-reviewer-multi-prompt.ts`.

Spawns **one review agent per focus area** in parallel, then combines all review
outputs into a single consolidated report. Each reviewer gets the same diff/code
but a different set of eyes — correctness, security, performance, style, etc.

## When to Use

- After completing a feature implementation before declaring it done
- Before a commit when you want a comprehensive sanity check
- When refactoring critical paths (auth, data handling, API contracts)
- Any time you want multiple perspectives without the cost of sequential reviews

## How to Use from Ferment

Fits naturally as the final step in a Ferment "build" phase, forming a
Ferment-native review gate.

```python
# ─── Multi-Prompt Code Reviewer ───────────────────────────────────────────
import asyncio, json

# 1. Define what was changed and the review focus areas
CHANGED_FILES = [
    "packages/ai/src/providers/auto-router.ts",
    "packages/ai/src/utils/oauth/freebuff.ts",
]

REVIEW_FOCUSES = [
    "correctness and edge cases — does the logic handle all error paths, timeouts, and empty responses?",
    "security concerns — are credentials handled safely, no token leaks, no injection risks?",
    "performance and efficiency — any unnecessary allocations, blocking calls, or redundant retries?",
    "code style and maintainability — naming, TypeScript types, dead code, missing comments?",
    "overall review — does the implementation match the requirements and is it production-ready?",
]

MODEL = "kiro/claude-sonnet-4.5"

# 2. Read the changed files for context
import subprocess
file_contexts = {}
for f in CHANGED_FILES:
    try:
        result = subprocess.run(["cat", f], capture_output=True, text=True)
        file_contexts[f] = result.stdout[:4000]  # trim to avoid token bloat
    except Exception as e:
        file_contexts[f] = f"[Could not read: {e}]"

code_context = "\n\n".join(
    f"### {path}\n```typescript\n{content}\n```"
    for path, content in file_contexts.items()
)

# 3. Spawn parallel reviews — one per focus area
async def run_review(focus: str, index: int) -> dict:
    prompt = (
        f"You are code reviewer #{index + 1}.\n\n"
        f"## Changed Code\n{code_context}\n\n"
        f"## Your Review Focus\n{focus}\n\n"
        f"Review the code above with your specific focus. "
        f"List ONLY real issues — no fluff, no praise. "
        f"Format each finding as:\n"
        f"- [SEVERITY: HIGH|MEDIUM|LOW] File:line — Description and suggested fix\n\n"
        f"If nothing needs fixing in your focus area, say: 'No issues found.'"
    )
    result = await rlm(prompt, model=MODEL)
    return {"focus": focus.split(" — ")[0], "findings": result}

reviews = await asyncio.gather(*[run_review(f, i) for i, f in enumerate(REVIEW_FOCUSES)])

# 4. Merge and display the consolidated review
print("=" * 60)
print("CONSOLIDATED CODE REVIEW")
print("=" * 60)

all_high = []
all_medium = []
all_low = []

for review in reviews:
    print(f"\n### {review['focus'].upper()}")
    print(review["findings"])
    # Parse severity buckets for summary
    for line in review["findings"].split("\n"):
        if "[SEVERITY: HIGH]" in line:
            all_high.append(line)
        elif "[SEVERITY: MEDIUM]" in line:
            all_medium.append(line)
        elif "[SEVERITY: LOW]" in line:
            all_low.append(line)

print("\n" + "=" * 60)
print(f"SUMMARY: {len(all_high)} HIGH, {len(all_medium)} MEDIUM, {len(all_low)} LOW issues")
if all_high:
    print("\n🚨 HIGH PRIORITY:")
    for item in all_high:
        print(f"  {item}")
```

## Review Focus Presets

Pick and combine based on what was changed:

```python
# For new features
REVIEW_FOCUSES = [
    "api design — is the interface clean, minimal, and consistent with existing patterns?",
    "correctness and edge cases",
    "find ways to simplify the code or reuse existing abstractions",
    "security concerns",
    "overall review",
]

# For bug fixes
REVIEW_FOCUSES = [
    "root cause — does the fix actually address the root cause or just the symptom?",
    "regression risk — could this fix break adjacent functionality?",
    "test coverage — are there adequate tests for the fixed scenario?",
]

# For refactoring
REVIEW_FOCUSES = [
    "behavioral equivalence — does the refactored code behave identically to the original?",
    "code style, maintainability, and readability",
    "performance impact of the restructuring",
]
```

## Ferment Integration

Record the review gate result in the active Ferment:

```python
high_count = len(all_high)
if high_count > 0:
    await ferment_add_memory(f"Multi-prompt review found {high_count} HIGH severity issues — must fix before completing phase")
else:
    await ferment_add_memory(f"Multi-prompt review passed: {len(all_medium)} medium, {len(all_low)} low issues")
```

## Anti-Patterns

- Do NOT run more than 6 reviewers — beyond that you get duplicate findings.
- Do NOT use vague focus areas like "review everything" — each focus must be specific.
- Do NOT skip reading the files first; reviewers need the actual code, not just a description.
- Do NOT merge all HIGH severity issues at once; fix and re-review the highest priority items first.
