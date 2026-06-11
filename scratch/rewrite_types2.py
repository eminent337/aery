import re

with open("packages/coding-agent/test/tools/task-repair-args.test.ts", "r") as f:
    text = f.read()

text = text.replace("repaired.tasks[0]", "repaired.tasks![0]")

with open("packages/coding-agent/test/tools/task-repair-args.test.ts", "w") as f:
    f.write(text)
