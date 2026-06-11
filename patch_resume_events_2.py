import re

with open("packages/coding-agent/src/task/executor.ts", "r") as f:
    text = f.read()

bad_message_end = """					} else if (event.type === "message_end") {
						if (event.message.attribution === "agent" && event.message.usage) {
							hasUsage = true;
							accumulatedUsage.input += event.message.usage.input ?? 0;
							accumulatedUsage.output += event.message.usage.output ?? 0;
							accumulatedUsage.cacheRead += event.message.usage.cacheRead ?? 0;
							accumulatedUsage.cacheWrite += event.message.usage.cacheWrite ?? 0;
							
							const usageTokens = (event.message.usage.input ?? 0) + (event.message.usage.output ?? 0) + (event.message.usage.cacheWrite ?? 0);
							progress.tokens += usageTokens;
							progress.contextTokens = event.message.usage.totalTokens;
						}
						scheduleProgress();
					}
				} catch (err) {"""

good_message_end = """					} else if (event.type === "message_end") {
						if (event.message && event.message.role === "assistant") {
							const messageUsage = (event.message as any).usage;
							if (messageUsage && typeof messageUsage === "object") {
								hasUsage = true;
								accumulatedUsage.input += messageUsage.input ?? 0;
								accumulatedUsage.output += messageUsage.output ?? 0;
								accumulatedUsage.cacheRead += messageUsage.cacheRead ?? 0;
								accumulatedUsage.cacheWrite += messageUsage.cacheWrite ?? 0;
								
								const usageTokens = (messageUsage.input ?? 0) + (messageUsage.output ?? 0) + (messageUsage.cacheWrite ?? 0);
								progress.tokens += usageTokens;
								progress.contextTokens = messageUsage.totalTokens;
							}
						}
						scheduleProgress();
					}
				} catch (err) {"""

text = text.replace(bad_message_end, good_message_end)

with open("packages/coding-agent/src/task/executor.ts", "w") as f:
    f.write(text)

print("done")
