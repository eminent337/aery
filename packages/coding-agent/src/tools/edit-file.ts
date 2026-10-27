/**
 * EditFileTool — Fast Exact String Replacement Tool.
 *
 * Ported from Google Antigravity (agy). Performs sub-millisecond exact string
 * replacement (Target -> Replacement) with zero AST or hashing overhead.
 */

import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@aryee337/aery-core";
import * as z from "zod/v4";
import type { ToolSession } from "./index";
import { formatPathRelativeToCwd } from "./path-utils";
import { resolvePlanPath } from "./plan-mode-guard";
import { ToolError } from "./tool-errors";

const editFileSchema = z.object({
	Path: z.string().optional().describe("The path of the file to modify (agy PascalCase format)."),
	Target: z.string().optional().describe("The exact string to be replaced, including exact leading whitespace."),
	Replacement: z
		.string()
		.optional()
		.describe("The content to replace the target with. Leave empty to delete the target."),
	path: z.string().optional().describe("File path (lowercase alias)."),
	target: z.string().optional().describe("Target string to replace (lowercase alias)."),
	replacement: z.string().optional().describe("Replacement string (lowercase alias)."),
});

export type EditFileParams = z.infer<typeof editFileSchema>;

export class EditFileTool implements AgentTool<typeof editFileSchema> {
	readonly name = "edit_file";
	readonly approval = "write" as const;
	readonly label = "Edit File";
	readonly description =
		"Use this tool to edit an existing file using fast exact string replacement. Follow these rules: 1) Single contiguous block of edits. 2) Target must exactly match existing file text, including whitespace. 3) If Target appears multiple times, every occurrence is replaced.";
	readonly parameters = editFileSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Fast exact-match string replacement tool ported from agy (sub-millisecond execution)";

	constructor(private readonly session?: ToolSession) {}

	static createIf(session: ToolSession): EditFileTool | null {
		return new EditFileTool(session);
	}

	async execute(
		_id: string,
		params: EditFileParams,
		_signal?: AbortSignal,
		_onUpdate?: unknown,
		context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const filePath = params.Path ?? params.path;
		const target = params.Target ?? params.target;
		const replacement = params.Replacement ?? params.replacement ?? "";

		if (!filePath) {
			throw new ToolError("Path is required for edit_file.");
		}
		if (target === undefined || target === null) {
			throw new ToolError("Target string is required for edit_file.");
		}

		const cwd = this.session?.cwd ?? context?.cwd ?? process.cwd();
		const absolutePath = this.session ? resolvePlanPath(this.session, filePath) : path.resolve(cwd, filePath);

		try {
			const content = await Bun.file(absolutePath).text();

			if (!content.includes(target)) {
				// Provide helpful diagnostic
				const firstFewWords = target.trim().split("\n")[0] ?? "";
				throw new ToolError(
					`Target string was not found in ${filePath}. Target must exactly match characters and whitespace. Search prefix: "${firstFewWords.slice(0, 50)}"`,
				);
			}

			// Sub-millisecond exact string replacement
			const newContent = content.replaceAll(target, replacement);

			if (newContent === content) {
				throw new ToolError(`Target replacement in ${filePath} resulted in identical content.`);
			}

			await Bun.write(absolutePath, newContent);

			const displayPath = formatPathRelativeToCwd(absolutePath, cwd);
			const targetLines = target.split("\n").length;
			const replacementLines = replacement.split("\n").length;

			return {
				content: [
					{
						type: "text",
						text: `Successfully replaced ${targetLines} line(s) with ${replacementLines} line(s) in ${displayPath}`,
					},
				],
				details: {
					path: displayPath,
					targetLines,
					replacementLines,
					bytesBefore: content.length,
					bytesAfter: newContent.length,
				},
			};
		} catch (error: any) {
			if (error instanceof ToolError) throw error;
			throw new ToolError(`Failed to edit ${filePath}: ${error.message || String(error)}`);
		}
	}
}
