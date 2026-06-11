import re

with open("/home/aryee/aery/ai_agent/aery/packages/coding-agent/src/task/index.ts", "r") as f:
    text = f.read()

# 1. 372: Type 'string | undefined' is not assignable to type 'string'.
#    It's `id: taskItem.id,` inside `progressByTaskId.set`
text = re.sub(r'id: taskItem\.id,', r'id: taskItem.id ?? "",', text)

# 2. 670: Property 'text' does not exist on type 'TextContent | ImageContent'.
#    It's `const text = payload.content.find((part: any) => part.type === "text")?.text;`
text = re.sub(
    r'const text = payload\.content\.find\(\(part: any\) => part\.type === "text"\)\?\.text;',
    r'const textPart = payload.content.find((part: any) => part.type === "text") as any; const text = textPart?.text;',
    text
)

# 3. 698: Property 'schema' does not exist on type 'TaskParams'.
#    It's `const { agent: agentName = "", context, schema: outputSchema } = params;`
text = re.sub(
    r'const \{ agent: agentName = "", context, schema: outputSchema \} = params;',
    r'const { agent: agentName = "", context } = params; const outputSchema = (params as any).schema;',
    text
)

# 4. 907: 'params.tasks' is possibly 'undefined'.
#    `Running ${params.tasks.length} agents...`
text = re.sub(
    r'Running \$\{params\.tasks\.length\} agents\.\.\.',
    r'Running ${(params.tasks || []).length} agents...',
    text
)

# 5. 975: Argument of type '(string | undefined)[]' is not assignable to parameter of type 'string[]'.
#    Probably `params.tasks.map(t => t.id)`
text = re.sub(
    r'const taskIds = params\.tasks\?\.map\(t => t\.id\) \|\| \[params\.id\];',
    r'const taskIds = (params.tasks?.map(t => t.id ?? "") || [params.id ?? ""]);',
    text
)

# 6. 997, 1024, 1081: 'task.assignment' or 'taskItem.assignment' is possibly 'undefined'.
#    Just replace `.assignment` with `.assignment ?? ""` where appropriate.
#    Wait, 1023, 1080: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
text = re.sub(r'task\.assignment', r'(task.assignment ?? "")', text)
text = re.sub(r'taskItem\.assignment', r'(taskItem.assignment ?? "")', text)

with open("/home/aryee/aery/ai_agent/aery/packages/coding-agent/src/task/index.ts", "w") as f:
    f.write(text)

