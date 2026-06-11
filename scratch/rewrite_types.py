import re

with open("packages/coding-agent/src/task/index.ts", "r") as f:
    text = f.read()

# Fix possibly undefined
text = text.replace("const assignment = task.assignment.trim();", "const assignment = task.assignment?.trim() || \"\";")
text = text.replace("agent: agentName,", "agent: agentName || \"\",")

with open("packages/coding-agent/src/task/index.ts", "w") as f:
    f.write(text)
