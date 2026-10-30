/**
 * EditFileTool — Fast Exact String Replacement Tool.
 *
 * Ported from Google Antigravity (agy). Performs sub-millisecond exact string
 * replacement (Target -> Replacement) with zero AST or hashing overhead.
 * Supports optional ArtifactMetadata to update artifact store entries in-place.
 */

import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@aryee337/aery-core";
import * as z from "zod/v4";
import { ArtifactStore } from "../artifacts/artifact-store";
import type { StoredArtifact } from "../artifacts/types";
import type { ToolSession } from "./index";
import { formatPathRelativeToCwd } from "./path-utils";
import { resolvePlanPath } from "./plan-mode-guard";
import { ToolError } from "./tool-errors";

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
	artifactMetadata: artifactMetaSchema
		.optional()
		.describe("Optional metadata for structured artifacts (summary, userFacing, requestFeedback)"),
	ArtifactMetadata: artifactMetaSchema
		.optional()
		.describe(
			"Optional metadata updates if updating an artifact file in the artifact directory. Omit when editing non-artifact files.",
		),
});

export type EditFileParams = z.infer<typeof editFileSchema>;

/** Details returned by the edit_file tool for TUI rendering */
export interface EditFileToolDetails {
	path: string;
	targetLines: number;
	replacementLines: number;
	bytesBefore: number;
	bytesAfter: number;
	artifact?: StoredArtifact;
	[key: string]: unknown;
}

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
	): Promise<AgentToolResult<EditFileToolDetails>> {
		const filePath = params.Path ?? params.path;
		const target = params.Target ?? params.target;
		const replacement = params.Replacement ?? params.replacement ?? "";

		if (!filePath) {
			throw new ToolError("Path is required for edit_file.");
		}
		if (target === undefined || target === null) {
			throw new ToolError("Target string is required for edit_file.");
		}

		const cwd = this.session?.cwd ?? process.cwd();
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

			const baseDetails: EditFileToolDetails = {
				path: displayPath,
				targetLines,
				replacementLines,
				bytesBefore: content.length,
				bytesAfter: newContent.length,
			};

			// Handle ArtifactMetadata — update the artifact store entry for this file
			const rawMeta = params.artifactMetadata ?? params.ArtifactMetadata;
			if (rawMeta) {
				const summary = rawMeta.summary ?? rawMeta.Summary ?? "";
				const userFacing = rawMeta.userFacing ?? rawMeta.UserFacing ?? true;
				const requestFeedback = rawMeta.requestFeedback ?? rawMeta.RequestFeedback ?? false;

				const baseName = filePath.split("/").pop()?.split("\\").pop() ?? filePath;
				const store = new ArtifactStore();
				const stored = await store.saveArtifact(baseName, newContent, {
					summary,
					userFacing,
					requestFeedback,
				});

				let resultText = `Successfully replaced ${targetLines} line(s) with ${replacementLines} line(s) in ${displayPath}`;
				if (summary) {
					resultText += `\nSummary: ${summary}`;
				}
				if (requestFeedback) {
					resultText += `\n[Feedback Requested: Please review this artifact and proceed or provide feedback]`;
				}

				return {
					content: [{ type: "text", text: resultText }],
					details: { ...baseDetails, artifact: stored },
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Successfully replaced ${targetLines} line(s) with ${replacementLines} line(s) in ${displayPath}`,
					},
				],
				details: baseDetails,
			};
		} catch (error: any) {
			if (error instanceof ToolError) throw error;
			throw new ToolError(`Failed to edit ${filePath}: ${error.message || String(error)}`);
		}
	}
}
