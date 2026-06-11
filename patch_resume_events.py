import re

with open("packages/coding-agent/src/task/executor.ts", "r") as f:
    text = f.read()

bad_tool_call = """					} else if (event.type === "tool_call") {
						progress.toolCount++;
						progress.currentTool = event.tool;
						progress.currentToolArgs = event.args;
						progress.currentToolStartMs = Date.now();
						if (event.tool === "yield") {
							yieldCalled = true;
							try {
								const parsed = JSON.parse(event.args);
								if (parsed && typeof parsed === "object" && "data" in parsed) {
									const data = parsed.data;
									truncatedOutput = typeof data === "string" ? data : JSON.stringify(data, null, 2);
								} else {
									truncatedOutput = event.args;
								}
							} catch {
								truncatedOutput = event.args;
							}
						}
						scheduleProgress(true);
					} else if (event.type === "tool_result") {
						progress.currentTool = undefined;
						progress.currentToolArgs = undefined;
						progress.currentToolStartMs = undefined;
						if (event.tool !== "yield") {
							progress.recentTools.unshift({
								tool: event.tool,
								args: event.args,
								endMs: Date.now(),
							});
							if (progress.recentTools.length > 5) progress.recentTools.pop();
						}
						scheduleProgress();
					} else if (event.type === "message_end") {"""

good_tool_call = """					} else if (event.type === "tool_execution_start") {
						progress.toolCount++;
						progress.currentTool = event.toolName;
						progress.currentToolArgs = event.args;
						progress.currentToolStartMs = Date.now();
						scheduleProgress(true);
					} else if (event.type === "tool_execution_end") {
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
						scheduleProgress();
					} else if (event.type === "message_end") {"""

text = text.replace(bad_tool_call, good_tool_call)

with open("packages/coding-agent/src/task/executor.ts", "w") as f:
    f.write(text)

print("done")
