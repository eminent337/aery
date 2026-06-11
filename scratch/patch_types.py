with open("packages/coding-agent/src/internal-urls/types.ts", "r") as f:
    text = f.read()

text = text.replace("<<<<<<<\n * Internal URLs (agent://, artifact://, memory://, skill://, rule://, mcp://, aery://, local://) are resolved by tools like read,\n=======\n * Internal URLs (`agent://`, `artifact://`, `history://`, `issue://`, `local://`, `mcp://`, `memory://`, `omp://`, `pr://`, `rule://`, `skill://`, and `vault://`) are resolved by tools like read,\n>>>>>>>", " * Internal URLs (`agent://`, `artifact://`, `history://`, `issue://`, `local://`, `mcp://`, `memory://`, `aery://`, `pr://`, `rule://`, `skill://`, and `vault://`) are resolved by tools like read,")

with open("packages/coding-agent/src/internal-urls/types.ts", "w") as f:
    f.write(text)
