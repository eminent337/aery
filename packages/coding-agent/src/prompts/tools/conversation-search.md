Search the active session's conversation transcript (all user and assistant messages) using BM25 ranking. Returns matching messages with relevance-ranked snippets.

Use proactively — before answering questions about what was discussed earlier in this session, what decisions were made, what the user asked for, or what the assistant previously concluded. When in doubt, search first.

Prefer `conversation_search` when you need to find something specific in the current session's history. Use `recall` for long-term memory across sessions, or `search` for file contents.

Params:
- `query` — natural language search query
- `maxResults` — max matches to return (default 10)
