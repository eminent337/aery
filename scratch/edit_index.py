import re

with open("packages/coding-agent/src/task/index.ts", "r") as f:
    text = f.read()

# 1. remove import of simple-mode
text = re.sub(r'import \{ getTaskSimpleModeCapabilities, type TaskSimpleMode \} from "\./simple-mode";\n', '', text)
text = re.sub(r'import \{ validateTaskModeParams, createTaskModeError \} from "\./simple-mode";\n', '', text)

# 2. replace #getTaskSimpleMode with #isBatchEnabled
text = re.sub(
    r'\t#getTaskSimpleMode\(\): TaskSimpleMode \{\n\t\treturn this\.session\.settings\.get\("task\.simple"\);\n\t\}',
    r'\t#isBatchEnabled(): boolean {\n\t\treturn this.session.settings.get("task.batch");\n\t}',
    text
)

# 3. replace parameters
text = re.sub(
    r'\tget parameters\(\): TaskToolSchemaInstance \{\n\t\tconst isolationEnabled = this\.session\.settings\.get\("task\.isolation\.mode"\) !== "none";\n\t\treturn getTaskSchema\(\{ isolationEnabled, simpleMode: this\.#getTaskSimpleMode\(\) \}\);\n\t\}',
    r'\tget parameters(): TaskToolSchemaInstance {\n\t\tconst isolationEnabled = this.session.settings.get("task.isolation.mode") !== "none";\n\t\treturn getTaskSchema({ isolationEnabled, batchEnabled: this.#isBatchEnabled() });\n\t}',
    text
)

# 4. replace the description
text = re.sub(
    r'\t\t\tthis\.#getTaskSimpleMode\(\),',
    r'\t\t\tthis.#isBatchEnabled(),',
    text
)

# Wait, let's just write the changes out and see what's left.
with open("packages/coding-agent/src/task/index.ts", "w") as f:
    f.write(text)

