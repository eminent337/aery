---
name: prompt-cache-optimizer
description: Normalize and anchor prompt cache breakpoints for Anthropic, Google, and OpenAI endpoints to maximize cache hit rates. Use when sending repeated or long-context requests to minimize latency and API costs by ensuring the static prefix is always identical across turns.
---

# Prompt Cache Optimization Engine

Ported from Freebuff's `packages/agent-runtime/src/util/messages.ts` and `common/src/util/cache-debug.ts`.

Prompt caching works by **anchoring a `cache_control: { type: "ephemeral" }` breakpoint** at the end of the stable static prefix of your message history. Every subsequent request that shares the same prefix up to that breakpoint gets a cache hit — usually 80–90% token cost reduction for repeated long prompts.

## Core Rules

1. **Only the LAST message gets a cache breakpoint.** All previous messages must have `cache_control` stripped to avoid invalidating the cache from the wrong position.
2. **Static prefix must be byte-identical.** Any change to messages before the breakpoint — including whitespace, ordering, or metadata — busts the cache entirely.
3. **5-minute expiry for Anthropic.** Cache blocks expire after 5 minutes of non-use. If there's a gap > 5 min, re-anchor from the new boundary (Freebuff calls this "cache gap detection").
4. **System prompt is the best cache anchor.** System prompts almost never change and are the highest ROI cache target.

## How to Use

### Basic Cache Injection

```python
# ─── Prompt Cache Optimizer ───────────────────────────────────────────────
import time

CACHE_EXPIRY_MS = 5 * 60 * 1000  # 5 minutes (Anthropic's window)

def inject_cache_breakpoint(messages: list[dict], last_anchored_at: float | None = None) -> tuple[list[dict], float]:
    """
    Strips all existing cache_control markers, then adds one at the last message.
    Returns (normalized_messages, new_anchor_timestamp).
    
    If last_anchored_at is within the cache window, the cache is hot — no change needed.
    If stale (> 5 min ago), re-inject at the new boundary to refresh the cache.
    """
    now = time.time() * 1000  # ms
    
    # Check if cache is still hot
    if last_anchored_at is not None:
        elapsed = now - last_anchored_at
        if elapsed < CACHE_EXPIRY_MS:
            return messages, last_anchored_at  # cache is still warm, no change
    
    # Deep copy to avoid mutating original
    import copy
    normalized = copy.deepcopy(messages)
    
    # Strip ALL existing cache_control markers from every message and content block
    for msg in normalized:
        # Strip top-level cache_control
        if "cache_control" in msg:
            del msg["cache_control"]
        # Strip from content blocks (Anthropic multi-part format)
        if isinstance(msg.get("content"), list):
            for block in msg["content"]:
                if isinstance(block, dict) and "cache_control" in block:
                    del block["cache_control"]
    
    # Inject a single cache_control breakpoint at the LAST message's last content block
    if normalized:
        last_msg = normalized[-1]
        if isinstance(last_msg.get("content"), list) and last_msg["content"]:
            # Multi-part content: inject on the last block
            last_msg["content"][-1]["cache_control"] = {"type": "ephemeral"}
        elif isinstance(last_msg.get("content"), str):
            # String content: convert to block format with cache_control
            last_msg["content"] = [
                {"type": "text", "text": last_msg["content"], "cache_control": {"type": "ephemeral"}}
            ]
    
    return normalized, now

# Usage example:
messages = [
    {"role": "user", "content": "You are a TypeScript expert."},
    {"role": "assistant", "content": "I'll help you with TypeScript."},
    {"role": "user", "content": "Refactor the auto-router to add retry logic."},
]

last_anchored_at = None
optimized_messages, last_anchored_at = inject_cache_breakpoint(messages, last_anchored_at)
print(f"Cache breakpoint injected at last message")
print(f"Next anchor refresh due in: {CACHE_EXPIRY_MS / 1000 / 60:.1f} minutes")
```

### System Prompt Cache Anchoring (Highest ROI)

```python
def build_system_with_cache(system_text: str) -> list[dict]:
    """
    Returns the system prompt as a cached content block.
    Because the system prompt almost never changes, this gives near-100% cache hits.
    Use this format for the Anthropic `system` parameter.
    """
    return [
        {
            "type": "text",
            "text": system_text,
            "cache_control": {"type": "ephemeral"},
        }
    ]

# Anthropic SDK usage:
system_with_cache = build_system_with_cache(
    "You are Aery, an advanced agentic AI assistant. "
    + "<full system prompt here — the longer it is, the bigger the cache benefit>"
)
# Pass as: client.messages.create(system=system_with_cache, ...)
```

### Cache Gap Detection (Proactive Re-anchor)

```python
# Freebuff's cache gap logic: re-anchor proactively if > CACHE_GAP_THRESHOLD has passed
CACHE_GAP_THRESHOLD_MS = 5 * 60 * 1000  # 5 minutes

class CacheOptimizedConversation:
    def __init__(self):
        self.messages: list[dict] = []
        self.last_anchored_at: float | None = None
    
    def add_turn(self, user_content: str, assistant_content: str) -> None:
        self.messages.append({"role": "user", "content": user_content})
        self.messages.append({"role": "assistant", "content": assistant_content})
    
    def prepare_for_send(self) -> list[dict]:
        """Returns messages with optimal cache breakpoint injected."""
        optimized, self.last_anchored_at = inject_cache_breakpoint(
            self.messages, self.last_anchored_at
        )
        return optimized
    
    def is_cache_warm(self) -> bool:
        if self.last_anchored_at is None:
            return False
        return (time.time() * 1000 - self.last_anchored_at) < CACHE_GAP_THRESHOLD_MS
    
    def cache_status(self) -> dict:
        if self.last_anchored_at is None:
            return {"warm": False, "age_seconds": None}
        age_ms = time.time() * 1000 - self.last_anchored_at
        return {
            "warm": age_ms < CACHE_GAP_THRESHOLD_MS,
            "age_seconds": age_ms / 1000,
            "expires_in_seconds": max(0, (CACHE_GAP_THRESHOLD_MS - age_ms) / 1000),
        }

# Usage:
conv = CacheOptimizedConversation()
conv.add_turn("What is the auto-router doing?", "The auto-router classifies tasks...")
ready_messages = conv.prepare_for_send()
print(f"Cache status: {conv.cache_status()}")
```

### Verifying Cache Hits in Responses

```python
def check_cache_hit(response_usage: dict) -> dict:
    """
    Parse Anthropic usage metadata to confirm cache hits.
    Anthropic returns: cache_creation_input_tokens, cache_read_input_tokens
    """
    creation = response_usage.get("cache_creation_input_tokens", 0)
    read = response_usage.get("cache_read_input_tokens", 0)
    input_tokens = response_usage.get("input_tokens", 0)
    
    hit_rate = read / max(1, input_tokens + read) * 100
    
    return {
        "cache_hit": read > 0,
        "hit_rate_percent": round(hit_rate, 1),
        "tokens_saved": read,
        "tokens_created": creation,
        "cost_reduction_estimate": f"~{hit_rate:.0f}% savings on input tokens",
    }

# After a streaming call, check usage:
# stats = check_cache_hit(response.usage)
# print(f"Cache: {stats}")
```

## Provider-Specific Notes

| Provider | Cache Format | Expiry | Max Cache Blocks |
|----------|-------------|--------|-----------------|
| **Anthropic** (`claude-*`) | `cache_control: {"type": "ephemeral"}` on content blocks | 5 min | 4 breakpoints per request |
| **Google** (`gemini-*`) | Automatic context caching via `cachedContent` API | 1 hour | N/A (auto-managed) |
| **OpenAI** (`gpt-4o`, `o*`) | Automatic prefix caching | 1 hour | N/A (auto-managed) |
| **DeepSeek** (`deepseek-*`) | Automatic KV cache | Session | N/A (auto-managed) |

For Anthropic, always inject manually using this skill. For Google/OpenAI/DeepSeek, the cache is automatic — just keep the prefix stable.

## Ferment Integration

Log cache performance across Ferment phases:

```python
await ferment_add_memory(
    f"Cache optimizer active: last anchored {conv.cache_status()['age_seconds']:.0f}s ago, "
    f"warm={conv.cache_status()['warm']}"
)
```

## Anti-Patterns

- Do NOT inject `cache_control` on multiple messages simultaneously — only the LAST message's breakpoint counts; others waste tokens.
- Do NOT modify any message content between requests if you want cache hits — even adding/removing trailing whitespace busts the cache.
- Do NOT cache the user's dynamic prompt — only cache the stable history before it.
- Do NOT forget to strip old breakpoints before injecting new ones — stale markers on earlier messages corrupt the cache prefix.
