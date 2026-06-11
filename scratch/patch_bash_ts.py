import re

with open("packages/coding-agent/src/tools/bash.ts", "r") as f:
    text = f.read()

if "enforceInlineByteCap" not in text:
    text = text.replace('import { DEFAULT_MAX_BYTES, streamTailUpdates, TailBuffer } from "../session/streaming-output";',
                        'import { DEFAULT_MAX_BYTES, enforceInlineByteCap, streamTailUpdates, TailBuffer } from "../session/streaming-output";')

    text = text.replace('#buildCompletedResult(', 'async #buildCompletedResult(')
    text = text.replace('): AgentToolResult<BashToolDetails> {', '): Promise<AgentToolResult<BashToolDetails>> {')
    
    old_cap = 'const resultBuilder = toolResult(details).text(outputText).truncationFromSummary(result, { direction: "tail" });'
    new_cap = """const cappedOutputText = await enforceInlineByteCap(outputText, {
			label: "bash output",
			saveArtifact: full => saveBashOriginalArtifact(this.session, full),
		});

		const resultBuilder = toolResult(details)
			.text(cappedOutputText)
			.truncationFromSummary(result, { direction: "tail" });"""
    text = text.replace(old_cap, new_cap)

    text = text.replace('const finalResult = this.#buildCompletedResult(result, options.timeoutSec, {',
                        'const finalResult = await this.#buildCompletedResult(result, options.timeoutSec, {')

with open("packages/coding-agent/src/tools/bash.ts", "w") as f:
    f.write(text)
