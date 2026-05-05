/**
 * Stitch Extension
 *
 * Integrates Google Stitch UI design platform into Aery.
 * Exposes Stitch MCP tools as native Aery tools so the agent can
 * fetch design HTML, screenshots, and build full sites from Stitch projects.
 *
 * Setup:
 *   1. Get a Stitch API key from https://stitch.google.com/settings
 *   2. Set STITCH_API_KEY=<your-key> in your environment
 *   3. Install: aery install stitch  (or copy to ~/.aery/agent/extensions/)
 *
 * Tools registered:
 *   stitch_build_site      - Build a site from a Stitch project by mapping screens to routes
 *   stitch_get_screen_code - Get the HTML/CSS code for a specific screen
 *   stitch_get_screen_image - Get a screenshot of a screen as base64
 *   stitch_list_projects   - List all Stitch projects
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@eminent337/aery";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);

async function callStitchTool(toolName: string, data: unknown): Promise<string> {
	const apiKey = process.env.STITCH_API_KEY;
	if (!apiKey) {
		throw new Error(
			"STITCH_API_KEY environment variable not set. Get your key from https://stitch.google.com/settings",
		);
	}

	const { stdout, stderr } = await execFileAsync(
		"npx",
		["@_davideast/stitch-mcp", "tool", toolName, "-d", JSON.stringify(data)],
		{
			env: { ...process.env, STITCH_API_KEY: apiKey },
			timeout: 30000,
		},
	);

	if (stderr && !stdout) throw new Error(stderr);
	return stdout.trim();
}

export default function stitchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "stitch_build_site",
		label: "Stitch: Build Site",
		description:
			"Build a site from a Google Stitch project by mapping screens to routes. Returns the design HTML for each page so the agent can implement it.",
		promptSnippet: "Use stitch_build_site to get design HTML from a Stitch project before implementing UI.",
		parameters: Type.Object({
			projectId: Type.String({ description: "The Stitch project ID" }),
			routes: Type.Array(
				Type.Object({
					screenId: Type.String({ description: "The screen ID" }),
					route: Type.String({ description: 'The route path, e.g. "/" or "/about"' }),
				}),
				{ description: "Mapping of screen IDs to route paths" },
			),
		}),
		async execute(_toolCallId, params) {
			const result = await callStitchTool("build_site", params);
			return { content: [{ type: "text", text: result }], details: {} };
		},
	});

	pi.registerTool({
		name: "stitch_get_screen_code",
		label: "Stitch: Get Screen Code",
		description: "Get the HTML/CSS code for a specific screen from a Google Stitch project.",
		promptSnippet: "Use stitch_get_screen_code to fetch the design HTML for a single screen.",
		parameters: Type.Object({
			projectId: Type.String({ description: "The Stitch project ID" }),
			screenId: Type.String({ description: "The screen ID" }),
		}),
		async execute(_toolCallId, params) {
			const result = await callStitchTool("get_screen_code", params);
			return { content: [{ type: "text", text: result }], details: {} };
		},
	});

	pi.registerTool({
		name: "stitch_get_screen_image",
		label: "Stitch: Get Screen Image",
		description: "Get a screenshot of a Stitch screen as a base64 image.",
		promptSnippet: "Use stitch_get_screen_image to see what a Stitch screen looks like visually.",
		parameters: Type.Object({
			projectId: Type.String({ description: "The Stitch project ID" }),
			screenId: Type.String({ description: "The screen ID" }),
		}),
		async execute(_toolCallId, params) {
			const result = await callStitchTool("get_screen_image", params);
			// Result is base64 image data
			return {
				content: [{ type: "image", data: result, mimeType: "image/png" }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "stitch_list_projects",
		label: "Stitch: List Projects",
		description: "List all Google Stitch projects available to your account.",
		promptSnippet: "Use stitch_list_projects to discover available Stitch projects and their IDs.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params) {
			const result = await callStitchTool("list_projects", {});
			return { content: [{ type: "text", text: result }], details: {} };
		},
	});

	pi.registerCommand("stitch", {
		description: "Stitch integration — /stitch setup | /stitch projects",
		handler: async (args, ctx) => {
			const cmd = args.trim();

			if (cmd === "setup") {
				ctx.ui.notify(
					"Set STITCH_API_KEY=<your-key> in your environment.\nGet your key from: https://stitch.google.com/settings",
					"info",
				);
				return;
			}

			if (cmd === "projects") {
				ctx.ui.notify("Fetching Stitch projects...", "info");
				try {
					const result = await callStitchTool("list_projects", {});
					ctx.ui.notify(result, "info");
				} catch (err) {
					ctx.ui.notify(`Error: ${err instanceof Error ? err.message : err}`, "error");
				}
				return;
			}

			ctx.ui.notify("Usage: /stitch setup | /stitch projects", "info");
		},
	});
}
