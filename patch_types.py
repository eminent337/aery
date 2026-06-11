import re

def add_import(filename):
    with open(filename, "r") as f:
        text = f.read()

    # Find the block starting with import type { and containing AssistantMessage,
    # and replace just the first occurrence.
    text = re.sub(r'(\n\s*AssistantMessage,\n)', r'\1\tContext,\n', text, count=1)
    
    with open(filename, "w") as f:
        f.write(text)

add_import("packages/agent/src/types.ts")
add_import("packages/agent/src/agent.ts")
print("done")
