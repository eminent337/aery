import re

with open("packages/coding-agent/src/task/executor.ts", "r") as f:
    text = f.read()

bad_revive = """						getMcpServerInstructions: options.mcpManager ? options.mcpManager.getInstructions.bind(options.mcpManager) : undefined,
						telemetry: subagentTelemetry,
						sessionManager: reopened,
						proxyTools: mcpProxyTools.length > 0 ? mcpProxyTools : undefined,
						allowCustomTools: true,
						extensions: options.extensions,
						evalExecutor: options.evalExecutor,
						maxRuntimeMs: Math.trunc(Number(options.maxRuntimeMs ?? settings.get("task.maxRuntimeMs") ?? 0) || 0),
						agentId: id,"""

good_revive = """						sessionManager: reopened,
						hasUI: false,
						spawns: spawnsEnv,
						taskDepth: childDepth,
						parentHindsightSessionState: options.parentHindsightSessionState,
						parentMnemopiSessionState: options.parentMnemopiSessionState,
						parentTaskPrefix: id,
						agentId: id,
						agentDisplayName: agent.name,
						enableLsp: lspEnabled,
						skipPythonPreflight,
						enableMCP,
						mcpManager: options.mcpManager,
						customTools: mcpProxyTools.length > 0 ? mcpProxyTools : undefined,
						localProtocolOptions: options.localProtocolOptions,
						telemetry: subagentTelemetry,
						parentEvalSessionId: options.parentEvalSessionId,"""

text = text.replace(bad_revive, good_revive)

# Let's fix the other error: `reviveSession` used before initialization (or undefined) in finally block.
# Wait, `reviveSession` was declared INSIDE the `if (options.resumeSession) { ... } else { let reviveSession = ... }`?
# In my `resumeSubprocess` code, I literally copied Aery's `runSubprocess` finally block which referenced `reviveSession`?
# Yes! `resumeSubprocess` uses `revive: reviveSession ?? undefined`, but `reviveSession` is NOT DECLARED in `resumeSubprocess`!
# I will just replace `revive: reviveSession ?? undefined` with `revive: undefined` inside `resumeSubprocess`!

bad_resume_adopt = """		AgentRegistry.global().setStatus(id, "idle");"""
# Wait, wait! `resumeSubprocess` in Aery's executor.ts:
# Wait, `resumeSubprocess` didn't have `AgentLifecycleManager.adopt`.
# The tsc output said: `src/task/executor.ts:1590:15 - error TS2304: Cannot find name 'reviveSession'.`
# Let's look at `executor.ts` around line 1590.

with open("packages/coding-agent/src/task/executor.ts", "w") as f:
    f.write(text)
print("done")
