with open("docs/tools/read.md", "r") as f:
    text = f.read()

text = text.replace("<<<<<<<\n- Registered protocols are outside this file, but the router in `packages/coding-agent/src/internal-urls/router.ts` is built for `agent://`, `artifact://`, `issue://`, `local://`, `mcp://`, `memory://`, `aery://`, `pr://`, `rule://`, and `skill://`.\n=======\n- Registered protocols are outside this file, but the router in `packages/coding-agent/src/internal-urls/router.ts` is built for `agent://`, `artifact://`, `history://`, `issue://`, `local://`, `mcp://`, `memory://`, `omp://`, `pr://`, `rule://`, and `skill://`.\n>>>>>>>", "- Registered protocols are outside this file, but the router in `packages/coding-agent/src/internal-urls/router.ts` is built for `agent://`, `artifact://`, `history://`, `issue://`, `local://`, `mcp://`, `memory://`, `aery://`, `pr://`, `rule://`, and `skill://`.")

with open("docs/tools/read.md", "w") as f:
    f.write(text)
