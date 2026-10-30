/**
 * WriteFileTool — Ported from Google Antigravity (agy).
 *
 * Direct agy-compatible file creation and append tool matching `write_file`:
 * - Path: target file path
 * - Content: contents to write
 * - Overwrite: whether to overwrite if file exists (default true unless explicitly false)
 * - Append: whether to append to an existing file
 * - ArtifactMetadata: structured metadata for artifacts in artifact directory
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as z from "zod/v4";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@aryee337/aery-core";
import type { ToolSession } from "./index";
import { resolvePlanPath } from "./plan-mode-guard";
import { ToolError } from "./tool-errors";
import { WriteTool, type WriteToolDetails } from "./write";

const artifactMetaSchema = z
	.object({
		summary: z.string().optional(),
		Summary: z.string().optional(),
		userFacing: z.boolean().optional(),
		UserFacing: z.boolean().optional(),
		requestFeedback: z.boolean().optional(),
		RequestFeedback: z.boolean().optional(),
	})
	.passthrough();

const writeFileSchema = z.object({
	Path: z.string().optional().describe("The absolute or relative path of the file to create."),
	Content: z.string().optional().describe("The full contents to write to the file."),
	Overwrite: z.boolean().optional().describe("Whether to overwrite an existing file, replacing its contents."),
	Append: z.boolean().optional().describe("Whether to append Content to the end of the file."),
	ArtifactMetadata: artifactMetaSchema
		.optional()
		.describe("Metadata that defines artifact properties. ONLY provide when creating an artifact file."),
	path: z.string().optional().describe("File path (lowercase alias)."),
	content: z.string().optional().describe("File content (lowercase alias)."),
	overwrite: z.boolean().optional().describe("Overwrite flag (lowercase alias)."),
	append: z.boolean().optional().describe("Append flag (lowercase alias)."),
	artifactMetadata: artifactMetaSchema.optional().describe("Artifact metadata (lowercase alias)."),
});

export type WriteFileParams = z.infer<typeof writeFileSchema>;

export class WriteFileTool implements AgentTool<typeof writeFileSchema, WriteToolDetails> {
	readonly name = "write_file";
	readonly approval = "write" as const;
	readonly label = "Write File";
	readonly description =
		"Create a new file with the given contents, or append to an existing file when Append is true. Parent directories are created automatically. Fails if the file already exists unless Overwrite or Append is true. When creating an artifact, always provide ArtifactMetadata.";
	readonly parameters = writeFileSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "File writing and artifact tool matching agy write_file schema";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): WriteFileTool {
		return new WriteFileTool(session);
	}

	async execute(
		toolCallId: string,
		params: WriteFileParams,
		signal?: AbortSignal,
		onUpdate?: unknown,
		context?: AgentToolContext,
	): Promise<AgentToolResult<WriteToolDetails>> {
		const filePath = params.Path ?? params.path;
		const content = params.Content ?? params.content;
		const overwrite = params.Overwrite ?? params.overwrite ?? true;
		const append = params.Append ?? params.append ?? false;
		const artifactMetadata = params.ArtifactMetadata ?? params.artifactMetadata;

		if (!filePath) {
			throw new ToolError("Path is required for write_file.");
		}
		if (content === undefined || content === null) {
			throw new ToolError("Content is required for write_file.");
		}

		const cwd = this.session.cwd ?? process.cwd();
		const absolutePath = resolvePlanPath(this.session, filePath);

		// Check if file exists when overwrite is explicitly disallowed
		let fileExists = false;
		try {
			await fs.access(absolutePath);
			fileExists = true;
		} catch {
			fileExists = false;
		}

		if (fileExists && !overwrite && !append) {
			throw new ToolError(
				`File ${filePath} already exists. Set Overwrite=true to overwrite or Append=true to append.`,
			);
		}

		let finalContent = content;
		if (append && fileExists) {
			try {
				const existing = await fs.readFile(absolutePath, "utf-8");
				finalContent = existing + content;
			} catch {}
		}

		const writeTool = new WriteTool(this.session);
		return (writeTool as any).execute(
			toolCallId,
			{
				path: filePath,
				content: finalContent,
				artifactMetadata,
				ArtifactMetadata: artifactMetadata,
			},
			signal,
			onUpdate,
			context,
		);
	}
}
