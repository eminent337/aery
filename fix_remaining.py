import re

with open("/home/aryee/aery/ai_agent/aery/packages/coding-agent/src/task/index.ts", "r") as f:
    text = f.read()

# 372: Type 'string | undefined' is not assignable to type 'string'.
text = text.replace("agent: params.agent,", "agent: params.agent ?? \"\",")

# 1023, 1080: description: task.description
text = text.replace("description: task.description,", "description: task.description ?? \"\",")

# 360: Argument of type '(string | undefined)[]' is not assignable to parameter of type 'string[]'.
text = text.replace("taskItems.map(t => t.id)", "taskItems.map(t => t.id ?? \"\")")

# 367: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
text = text.replace("progressByTaskId.set(taskItem.id, {", "progressByTaskId.set(taskItem.id ?? \"\", {")

# 419: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
text = text.replace("taskId: taskItem.id", "taskId: taskItem.id ?? \"\"")

# 435: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
text = text.replace("failedSchedules.push(`${taskItem.id}: ${message}`);", "failedSchedules.push(`${taskItem.id ?? \"\"}: ${message}`);")

# 532: Type 'string | undefined' is not assignable to type 'string'.
text = text.replace("const progress = progressByTaskId.get(taskItem.id);", "const progress = progressByTaskId.get(taskItem.id ?? \"\");")

# 536: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
text = text.replace("failedSchedules.push(`${taskItem.id}: cancelled before scheduling`);", "failedSchedules.push(`${taskItem.id ?? \"\"}: cancelled before scheduling`);")

# 564: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
text = text.replace("`Running background task ${taskItem.id}...`,", "`Running background task ${taskItem.id ?? \"\"}...`,")

with open("/home/aryee/aery/ai_agent/aery/packages/coding-agent/src/task/index.ts", "w") as f:
    f.write(text)
