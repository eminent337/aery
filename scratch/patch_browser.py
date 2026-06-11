with open("packages/coding-agent/src/tools/browser.ts", "r") as f:
    text = f.read()

import_line = 'import { enforceInlineByteCap } from "../session/streaming-output";\n'
if "enforceInlineByteCap" not in text:
    text = text.replace('import type { ToolSession } from "../sdk";\n', 'import type { ToolSession } from "../sdk";\n' + import_line)

# replace details.result = textOnly;
old_logic = "details.result = textOnly;\n\t\treturn toolResult(details).content(content).done();"
new_logic = """const cappedText = await enforceInlineByteCap(textOnly, {
			label: "browser output",
			saveArtifact: full => saveBrowserOutputArtifact(this.session, full),
		});
		details.result = cappedText;
		if (cappedText !== textOnly) {
			const nonText = content.filter(c => c.type !== "text");
			return toolResult(details)
				.content([...nonText, { type: "text", text: cappedText }])
				.done();
		}
		return toolResult(details).content(content).done();"""

if "enforceInlineByteCap(textOnly" not in text:
    text = text.replace(old_logic, new_logic)

artifact_func = """
/** Persist over-cap browser run output as a session artifact; mirrors the bash minimizer's save path. */
async function saveBrowserOutputArtifact(session: ToolSession, fullText: string): Promise<string | undefined> {
	try {
		const alloc = await session.allocateOutputArtifact?.("browser-original");
		if (!alloc?.path || !alloc.id) return undefined;
		await Bun.write(alloc.path, fullText);
		return alloc.id;
	} catch {
		return undefined;
	}
}
"""

if "saveBrowserOutputArtifact" not in text:
    text += "\n" + artifact_func

with open("packages/coding-agent/src/tools/browser.ts", "w") as f:
    f.write(text)
