import re

with open("packages/agent/src/types.ts", "r") as f:
    text = f.read()

bad_loop = """export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model;"""

good_loop = """export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model;

	/**
	 * Optional transform applied to the fully resolved LLM context before it hits the provider.
	 * Used for secrets obfuscation or final payload alterations.
	 */
	transformProviderContext?: (context: Context) => Context;"""

text = text.replace(bad_loop, good_loop)

with open("packages/agent/src/types.ts", "w") as f:
    f.write(text)

print("done")
