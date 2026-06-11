with open("packages/coding-agent/src/internal-urls/router.ts", "r") as f:
    text = f.read()

text = text.replace("<<<<<<<\n * Internal URL router for internal protocols (agent://, artifact://, memory://, skill://, rule://, mcp://, aery://, local://).\n=======\n * Internal URL router for internal protocols (`agent://`, `artifact://`, `history://`, `issue://`, `local://`, `mcp://`, `memory://`, `omp://`, `pr://`, `rule://`, `skill://`, and `vault://`).\n>>>>>>>", " * Internal URL router for internal protocols (`agent://`, `artifact://`, `history://`, `issue://`, `local://`, `mcp://`, `memory://`, `aery://`, `pr://`, `rule://`, `skill://`, and `vault://`).")

with open("packages/coding-agent/src/internal-urls/router.ts", "w") as f:
    f.write(text)
