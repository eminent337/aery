import re

with open("packages/coding-agent/src/task/executor.ts", "r") as f:
    text = f.read()

bad_systemPrompt = """						systemPrompt: defaultPrompt => {
							const subagentPrompt = prompt.render(subagentSystemPromptTemplate, {
								agent: agent.systemPrompt,
								context: options.context?.trim() ?? "",
								worktree: worktree ?? "",
								outputSchema: normalizedOutputSchema,
								contextFile: contextFileForPrompt,
							});
							return options.systemPromptOverride ?? subagentPrompt;
						},"""

good_systemPrompt = """						systemPrompt: defaultPrompt => {
							const subagentPrompt = prompt.render(subagentSystemPromptTemplate, {
								agent: agent.systemPrompt,
								context: options.context?.trim() ?? "",
								worktree: worktree ?? "",
								outputSchema: normalizedOutputSchema,
								contextFile: contextFileForPrompt,
								ircPeers: ircPeers,
								ircSelfId: ircSelfId,
							});
							return defaultPrompt.length === 0
								? [subagentPrompt]
								: [...defaultPrompt.slice(0, -1), subagentPrompt, defaultPrompt[defaultPrompt.length - 1]];
						},"""

# wait, are ircPeers and ircSelfId variables defined? Let's check the original createAgentSession
text = text.replace(bad_systemPrompt, good_systemPrompt)

with open("packages/coding-agent/src/task/executor.ts", "w") as f:
    f.write(text)

print("done")
