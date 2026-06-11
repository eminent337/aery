with open("docs/tools/read.md", "r") as f:
    text = f.read()

text = text.replace("<<<<<<<\n  - `packages/coding-agent/src/internal-urls/router.ts` — resolve `agent://`, `artifact://`, `local://`, `mcp://`, `memory://`, `aery://`, `rule://`, `skill://`.\n=======\n  - `packages/coding-agent/src/internal-urls/router.ts` — resolve `agent://`, `artifact://`, `history://`, `issue://`, `local://`, `mcp://`, `memory://`, `omp://`, `pr://`, `rule://`, `skill://`, and `vault://`.\n>>>>>>>", "  - `packages/coding-agent/src/internal-urls/router.ts` — resolve `agent://`, `artifact://`, `history://`, `local://`, `mcp://`, `memory://`, `aery://`, `rule://`, `skill://`.")

with open("docs/tools/read.md", "w") as f:
    f.write(text)
