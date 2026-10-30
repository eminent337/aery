/**
 * ReadFileTool — Ported from Google Antigravity (agy).
 *
 * Direct agy-compatible file reader tool matching the `read_file` specification:
 * - Path: absolute or relative file path
 * - StartLine: optional start line (1-based, inclusive)
 * - EndLine: optional end line (inclusive)
 * - ByteOffset: optional byte offset into the file
 *
 * Delegates to Aery's core ReadTool for line slicing, hashline formatting,
 * image detection, and conflict detection.
 */

import * as z from "zod/v4";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@aryee337/aery-core";
import type { ToolSession } from "./index";
import { ReadTool, type ReadToolDetails } from "./read";
import { ToolError } from "./tool-errors";

const readFileSchema = z.object({
	Path: z.string().optional().describe("The absolute or relative path of the file to read (agy format)."),
	StartLine: z
		.number()
		.optional()
		.describe("Start line to read (inclusive). Omit to read from the beginning of the file."),
	EndLine: z
		.number()
		.optional()
		.describe("End line to read (inclusive). Omit to read until the end of the file, within limits."),
	ByteOffset: z
		.number()
		.optional()
		.describe("Byte offset into the line range. Use to continue reading when truncated."),
	path: z.string().optional().describe("File path (lowercase alias)."),
	startLine: z.number().optional().describe("Start line (lowercase alias)."),
	endLine: z.number().optional().describe("End line (lowercase alias)."),
	byteOffset: z.number().optional().describe("Byte offset (lowercase alias)."),
});

export type ReadFileParams = z.infer<typeof readFileSchema>;

export class ReadFileTool implements AgentTool<typeof readFileSchema, ReadToolDetails> {
	readonly name = "read_file";
	readonly approval = "read" as const;
	readonly label = "Read File";
	readonly description =
		"Read the contents of a text, image, pdf, video, or audio file. Each read returns at most 800 lines or 46080 bytes.";
	readonly parameters = readFileSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "File reading tool matching agy read_file schema";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): ReadFileTool {
		return new ReadFileTool(session);
	}

	async execute(
		toolCallId: string,
		params: ReadFileParams,
		signal?: AbortSignal,
		onUpdate?: unknown,
		context?: AgentToolContext,
	): Promise<AgentToolResult<ReadToolDetails>> {
		const rawPath = params.Path ?? params.path;
		if (!rawPath) {
			throw new ToolError("Path is required for read_file.");
		}

		const start = params.StartLine ?? params.startLine;
		const end = params.EndLine ?? params.endLine;

		// Build Aery path selector syntax: path:start-end or path:start
		let selectorPath = rawPath;
		if (start !== undefined && end !== undefined) {
			selectorPath = `${rawPath}:${start}-${end}`;
		} else if (start !== undefined) {
			selectorPath = `${rawPath}:${start}`;
		} else if (end !== undefined) {
			selectorPath = `${rawPath}:1-${end}`;
		}

		const readTool = new ReadTool(this.session);
		return (readTool as any).execute(toolCallId, { path: selectorPath }, signal, onUpdate, context);
	}
}
