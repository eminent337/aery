import re

with open("packages/agent/src/types.ts", "r") as f:
    text = f.read()

bad_stream = """	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**"""

good_stream = """	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	transformProviderContext?: (context: any) => any;

	/**"""

text = text.replace(bad_stream, good_stream)

with open("packages/agent/src/types.ts", "w") as f:
    f.write(text)


with open("packages/agent/src/agent.ts", "r") as f:
    text = f.read()

bad_agent = """	#transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;"""

good_agent = """	#transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	#transformProviderContext?: (context: any) => any;"""

text = text.replace(bad_agent, good_agent)

bad_agent2 = """		this.#transformContext = config.transformContext;"""

good_agent2 = """		this.#transformContext = config.transformContext;
		this.#transformProviderContext = config.transformProviderContext;"""

text = text.replace(bad_agent2, good_agent2)

bad_agent3 = """			getApiKey: this.#getApiKey,"""

good_agent3 = """			getApiKey: this.#getApiKey,
			transformProviderContext: this.#transformProviderContext,"""

text = text.replace(bad_agent3, good_agent3)

with open("packages/agent/src/agent.ts", "w") as f:
    f.write(text)

print("done")
