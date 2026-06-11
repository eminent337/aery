with open("packages/coding-agent/src/task/index.ts", "r") as f:
    text = f.read()

text = text.replace('const { agent: agentName || "", context, schema: outputSchema } = params;', 'const { agent: agentName = "", context, schema: outputSchema } = params;')
with open("packages/coding-agent/src/task/index.ts", "w") as f:
    f.write(text)
