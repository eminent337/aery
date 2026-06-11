import re

with open("packages/coding-agent/src/task/executor.ts", "r") as f:
    text = f.read()

bad_tool_end = """					} else if (event.type === "tool_execution_end") {
						progress.currentTool = undefined;
						progress.currentToolArgs = undefined;
						progress.currentToolStartMs = undefined;
						if (event.toolName === "yield") {
							yieldCalled = true;
							try {
								const parsed = typeof event.args === "string" ? JSON.parse(event.args) : event.args;
								if (parsed && typeof parsed === "object" && "data" in parsed) {
									const data = parsed.data;
									truncatedOutput = typeof data === "string" ? data : JSON.stringify(data, null, 2);
								} else {
									truncatedOutput = JSON.stringify(event.args);
								}
							} catch {
								truncatedOutput = JSON.stringify(event.args);
							}
						} else {
							progress.recentTools.unshift({
								tool: event.toolName,
								args: typeof event.args === "string" ? event.args : JSON.stringify(event.args),
								endMs: Date.now(),
							});
							if (progress.recentTools.length > 5) progress.recentTools.pop();
						}
						scheduleProgress();"""

good_tool_end = """					} else if (event.type === "tool_execution_end") {
						const argsToUse = progress.currentToolArgs;
						progress.currentTool = undefined;
						progress.currentToolArgs = undefined;
						progress.currentToolStartMs = undefined;
						if (event.toolName === "yield") {
							yieldCalled = true;
							try {
								const parsed = typeof argsToUse === "string" ? JSON.parse(argsToUse) : argsToUse;
								if (parsed && typeof parsed === "object" && "data" in parsed) {
									const data = parsed.data;
									truncatedOutput = typeof data === "string" ? data : JSON.stringify(data, null, 2);
								} else {
									truncatedOutput = JSON.stringify(argsToUse);
								}
							} catch {
								truncatedOutput = JSON.stringify(argsToUse);
							}
						} else {
							progress.recentTools.unshift({
								tool: event.toolName,
								args: typeof argsToUse === "string" ? argsToUse : JSON.stringify(argsToUse),
								endMs: Date.now(),
							});
							if (progress.recentTools.length > 5) progress.recentTools.pop();
						}
						scheduleProgress();"""

text = text.replace(bad_tool_end, good_tool_end)

with open("packages/coding-agent/src/task/executor.ts", "w") as f:
    f.write(text)

print("done")
