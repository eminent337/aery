with open("packages/coding-agent/src/prompts/tools/read.md", "r") as f:
    text = f.read()

text = text.replace("<<<<<<<\n- `path` — required. Local path, internal URI (`skill://`, `agent://`, `artifact://`, `memory://`, `rule://`, `local://`, `vault://`, `mcp://`), or URL. Append `:<sel>` for line ranges, raw mode, or special modes (e.g. `src/foo.ts:50-200`, `src/foo.ts:raw`, `db.sqlite:users:42`).\n=======\n- `path` — required. Local path, internal URI (`skill://`, `agent://`, `artifact://`, `history://`, `memory://`, `rule://`, `local://`, `vault://`, `mcp://`, `omp://`, `issue://`, `pr://`), or URL. Append `:<sel>` for line ranges, raw mode, or special modes (e.g. `src/foo.ts:50-200`, `src/foo.ts:raw`, `db.sqlite:users:42`).\n>>>>>>>", "- `path` — required. Local path, internal URI (`skill://`, `agent://`, `artifact://`, `history://`, `memory://`, `rule://`, `local://`, `vault://`, `mcp://`, `aery://`, `issue://`, `pr://`), or URL. Append `:<sel>` for line ranges, raw mode, or special modes (e.g. `src/foo.ts:50-200`, `src/foo.ts:raw`, `db.sqlite:users:42`).")

with open("packages/coding-agent/src/prompts/tools/read.md", "w") as f:
    f.write(text)
