with open("packages/coding-agent/src/session/streaming-output.ts", "r") as f:
    text = f.read()

func = """
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB

export async function enforceInlineByteCap(
	text: string,
	options: {
		label: string;
		maxBytes?: number;
		saveArtifact?: (fullText: string) => Promise<string | undefined> | string | undefined;
	},
): Promise<string> {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const lenBytes = Buffer.byteLength(text, "utf-8");
	if (lenBytes <= maxBytes) return text;

	const headBytes = Math.floor(maxBytes * 0.6);
	const tailBytes = Math.floor(maxBytes * 0.25);

	let headCut = headBytes;
	while (headCut > 0 && text.charCodeAt(headCut) !== 10) headCut--;
	if (headCut === 0) headCut = headBytes;

	let tailCut = lenBytes - tailBytes;
	while (tailCut < lenBytes && text.charCodeAt(tailCut) !== 10) tailCut++;
	if (tailCut === lenBytes) tailCut = lenBytes - tailBytes;

	const elidedBytes = Buffer.byteLength(text.slice(headCut, tailCut), "utf-8");
	const marker = `\\n[… elided ${elidedBytes} bytes of ${options.label} …]\\n`;

	const artifactId = await options.saveArtifact?.(text);
	const footer = artifactId ? `\\n[raw output: artifact://${artifactId}]` : "";

	const head = Buffer.from(text, "utf-8").subarray(0, headCut).toString("utf-8");
	const tail = Buffer.from(text, "utf-8").subarray(tailCut).toString("utf-8");
	return `${head}${marker}${tail}${footer}`;
}
"""

if "enforceInlineByteCap" not in text:
    text += "\n" + func

with open("packages/coding-agent/src/session/streaming-output.ts", "w") as f:
    f.write(text)
