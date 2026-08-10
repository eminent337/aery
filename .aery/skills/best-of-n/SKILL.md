---
name: best-of-n
description: Spawn N parallel reasoning branches, then auto-select the best answer or implementation using a Ferment-tracked selector step. Use for hard problems, critical code changes, or complex architectural decisions where a single attempt may miss edge cases.
---

# Best-of-N Candidate Generation & Selection

Ported from Freebuff's `thinker/best-of-n` and `editor/best-of-n` pattern.

Runs **N independent reasoning threads in parallel**, then feeds all results to a
**selector agent** that scores each output and picks the winner. Optional
`suggestedImprovements` from non-chosen candidates can be merged into the final
answer.

## When to Use

- Hard algorithmic problems where a single reasoning path might miss edge cases
- Critical refactoring decisions where multiple implementation strategies exist
- Architecture design questions that benefit from diverse perspectives
- Any task where you want to trade latency for higher accuracy

## How to Use from Ferment

Best-of-N fits naturally inside a Ferment reasoning phase. Wire it as a Ferment
step so progress is tracked and the selection decision is recorded.

```python
# ─── Ferment-integrated Best-of-N ─────────────────────────────────────────
import asyncio, json

# 1. Define the problem
PROBLEM = "Redesign the auto-router failover logic to handle partial provider failures"
N = 3          # number of parallel thinking branches (1–10, default 3)
MODEL = "kiro/claude-sonnet-4.5"   # model for each thinker; use the reasoning tier

# 2. Generate N independent responses in parallel using the rlm subagent API
async def generate_candidate(index: int) -> dict:
    prompt = (
        f"You are reasoning branch {chr(65 + index)} of a best-of-{N} thinker.\n"
        f"Think deeply using <think> tags, then write your answer.\n\n"
        f"Problem: {PROBLEM}"
    )
    result = await rlm(prompt, model=MODEL)
    # Strip <think> tags, keep only the final answer
    import re
    clean = re.sub(r"<think>[\s\S]*?</think>", "", result).strip()
    return {"id": chr(65 + index), "content": clean}

candidates = await asyncio.gather(*[generate_candidate(i) for i in range(N)])
print(f"Generated {len(candidates)} candidates")
for c in candidates:
    print(f"\n=== Candidate {c['id']} ===\n{c['content'][:300]}...")

# 3. Selector: choose the best candidate
SELECTOR_PROMPT = f"""You are the Best-of-N Selector.

## Candidates
{json.dumps(candidates, indent=2)}

## Original Problem
{PROBLEM}

## Your Task
Evaluate each candidate by:
1. Correctness and completeness
2. Edge-case handling
3. Simplicity and maintainability
4. Practical actionability

Respond ONLY with a JSON object:
{{
  "winnerId": "<A|B|C|...>",
  "reason": "<one sentence why>",
  "suggestedImprovements": "<valuable ideas from losing candidates, or empty string>"
}}"""

selector_raw = await rlm(SELECTOR_PROMPT, model=MODEL)
import re
json_match = re.search(r'\{[\s\S]*\}', selector_raw)
selection = json.loads(json_match.group()) if json_match else {"winnerId": "A", "reason": "fallback", "suggestedImprovements": ""}

winner = next(c for c in candidates if c["id"] == selection["winnerId"])
print(f"\n✅ Winner: Candidate {selection['winnerId']}")
print(f"Reason: {selection['reason']}")
if selection.get("suggestedImprovements"):
    print(f"Improvements: {selection['suggestedImprovements']}")
print(f"\n=== Final Answer ===\n{winner['content']}")
```

## Ferment Phase Integration

Use `ferment_add_decision` to record which candidate won and why:

```python
await ferment_add_decision(
    f"Best-of-{N} selector chose candidate {selection['winnerId']}: {selection['reason']}"
)
```

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `N` | `3` | Number of parallel candidates. Use `1` for fast single-pass, `6` for max quality. |
| `MODEL` | `kiro/claude-sonnet-4.5` | Model for each thinker branch. Use a reasoning model for harder problems. |
| `SELECTOR_MODEL` | same as MODEL | Override to use a stronger model just for selection. |

## Variant: Implementation Best-of-N

For code implementation tasks, generate N **diff proposals** and select the best:

```python
# Each candidate writes code using propose_str_replace semantics (no actual edits)
async def generate_impl_candidate(index: int, file_context: str) -> dict:
    prompt = (
        f"Implementation approach {chr(65 + index)}: Propose a complete solution.\n"
        f"Write the implementation as a unified diff or code snippet.\n"
        f"Context:\n{file_context}\n\nTask: {PROBLEM}"
    )
    result = await rlm(prompt, model=MODEL)
    return {"id": chr(65 + index), "strategy": f"Approach {chr(65 + index)}", "content": result}
```

The selector then evaluates diffs and picks the cleanest, most minimal implementation.

## Anti-Patterns

- Do NOT use N > 6 for simple tasks; it wastes tokens with diminishing returns.
- Do NOT skip the selector step; always evaluate candidates before using the output.
- Do NOT run best-of-N inside a tight loop — use it for the decision phase, not mechanical steps.
