/**
 * OS-Native Desktop Accessibility Tool for Aery.
 *
 * Powered by agent-desktop (AX on macOS, UI Automation on Windows, AT-SPI on Linux).
 * Provides sub-15ms deterministic UI tree inspection, element reference indexing (@<snapshot_id>:e<N>),
 * and headless semantic interactions (click, type, set_value, toggle, focus, select)
 * without moving the physical mouse pointer or stealing desktop focus.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import desktopAccessibilityDescription from "../prompts/tools/desktop-accessibility.md" with { type: "text" };
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@aryee337/aery-core";
import * as z from "zod/v4";

const execFileAsync = promisify(execFile);

/**
 * Locate the agent-desktop binary across standard bundled and system paths.
 */
export function resolveAgentDesktopBinary(): string | null {
	// 1. Explicit env override
	if (process.env.AGENT_DESKTOP_PATH && fs.existsSync(process.env.AGENT_DESKTOP_PATH)) {
		return process.env.AGENT_DESKTOP_PATH;
	}

	// 2. Bundled in aery bin/ directory
	const bundledPaths = [
		path.join(__dirname, "../../../bin/agent-desktop"),
		path.join(__dirname, "../../../../bin/agent-desktop"),
		path.join(process.cwd(), "bin/agent-desktop"),
		path.join(os.homedir(), ".local/bin/agent-desktop"),
		"/home/aryee/aery/ai_agent/aery/bin/agent-desktop",
		"/home/aryee/aery/vendor/agent-desktop/target/release/agent-desktop",
	];

	for (const candidate of bundledPaths) {
		if (fs.existsSync(candidate)) {
			try {
				fs.accessSync(candidate, fs.constants.X_OK);
				return candidate;
			} catch {
				// not executable, continue
			}
		}
	}

	// 3. Fallback to system PATH
	return "agent-desktop";
}

export const desktopAccessibilitySchema = z.object({
	action: z
		.enum([
			"status",
			"snapshot",
			"click",
			"double_click",
			"right_click",
			"type",
			"set_value",
			"clear",
			"press",
			"focus",
			"toggle",
			"select",
			"scroll",
			"scroll_to",
			"find",
			"list_windows",
			"list_apps",
			"wait",
		])
		.describe("Accessibility action to execute via native OS accessibility tree."),

	app: z
		.string()
		.optional()
		.describe("Target application name (e.g. 'nautilus', 'libreoffice', 'brave', 'kitty')."),

	target: z
		.string()
		.optional()
		.describe("Alias for target application or window title filter."),

	window_id: z
		.string()
		.optional()
		.describe("Target window ID (from list_windows)."),

	ref: z
		.string()
		.optional()
		.describe("Qualified element reference ID from a previous snapshot (e.g. '@s8f3k2p9:e1')."),

	text: z
		.string()
		.optional()
		.describe("Text to type or value to set for an element."),

	key: z
		.string()
		.optional()
		.describe("Key or key combination to press (e.g. 'Return', 'Ctrl+S', 'Tab', 'Escape')."),

	role: z
		.string()
		.optional()
		.describe("Element role filter for find or snapshot (e.g. 'button', 'entry', 'window', 'table')."),

	name: z
		.string()
		.optional()
		.describe("Element name or label pattern to find."),

	root_ref: z
		.string()
		.optional()
		.describe("Subtree root ref to drill down into a specific component without whole-window overhead."),

	interactive_only: z
		.boolean()
		.optional()
		.describe("Whether to return only actionable interactive elements (default: true)."),

	compact: z
		.boolean()
		.optional()
		.describe("Whether to omit empty structural container groups (default: true)."),

	skeleton: z
		.boolean()
		.optional()
		.describe("Whether to produce a shallow structural skeleton map with child counts for dense UIs."),

	max_depth: z
		.number()
		.optional()
		.describe("Maximum tree traversal depth."),

	headed: z
		.boolean()
		.optional()
		.describe("Force physical mouse pointer/focus if semantic headless execution is not available."),

	timeout_ms: z
		.number()
		.optional()
		.describe("Timeout in milliseconds for the operation (default: 10000)."),
});

export type DesktopAccessibilityParams = z.infer<typeof desktopAccessibilitySchema>;

export interface AgentDesktopEnvelope {
	version?: string;
	ok: boolean;
	command?: string;
	data?: any;
	error?: {
		code?: string;
		message?: string;
		details?: any;
		disposition?: {
			delivery?: string;
			retry?: string;
		};
	};
}

/**
 * Format an accessibility tree into a compact readable markdown structure.
 */
function formatTreeMarkdown(node: any, indent = 0): string {
	if (!node) return "";
	const pad = "  ".repeat(indent);
	const role = node.role || "unknown";
	const name = node.name ? ` "${node.name}"` : "";
	const ref = node.ref_id ? ` **[${node.ref_id}]**` : "";
	const value = node.value ? ` val: "${node.value}"` : "";
	const states = Array.isArray(node.states) && node.states.length > 0 ? ` (${node.states.join(", ")})` : "";
	const actions =
		Array.isArray(node.available_actions) && node.available_actions.length > 0
			? ` [actions: ${node.available_actions.join(", ")}]`
			: "";
	const cut = node.truncated ? ` (truncated, ${node.child_count ?? "?"} children)` : "";

	let line = `${pad}- ${ref} \`${role}\`${name}${value}${states}${actions}${cut}\n`;

	if (Array.isArray(node.children)) {
		for (const child of node.children) {
			line += formatTreeMarkdown(child, indent + 1);
		}
	}
	return line;
}

export class DesktopAccessibilityTool implements AgentTool<typeof desktopAccessibilitySchema> {
	readonly name = "desktop_accessibility";
	readonly approval: ToolApprovalDecision = "write";
	readonly label = "Desktop Accessibility";
	readonly summary =
		"Inspect OS accessibility tree and perform headless, deterministic clicks, typing, and checks by ref ID";
	readonly description = desktopAccessibilityDescription;
	readonly parameters = desktopAccessibilitySchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;

	constructor(_session?: any) {}

	static createIf(session?: any): DesktopAccessibilityTool | null {
		return new DesktopAccessibilityTool(session);
	}

	async execute(
		toolCallId: string,
		params: DesktopAccessibilityParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const binary = resolveAgentDesktopBinary();
		if (!binary) {
			return {
				content: [
					{
						type: "text",
						text: "Error: agent-desktop binary could not be found. Please compile or install agent-desktop.",
					},
				],
				isError: true,
			};
		}

		const args: string[] = [];
		if (params.headed) {
			args.push("--headed");
		}

		const targetApp = params.app || params.target;

		switch (params.action) {
			case "status":
				args.push("status");
				break;

			case "list_windows":
				args.push("list-windows");
				if (targetApp) args.push("--app", targetApp);
				break;

			case "list_apps":
				args.push("list-apps");
				if (targetApp) args.push("--app", targetApp);
				break;

			case "snapshot": {
				args.push("snapshot");
				if (targetApp) args.push("--app", targetApp);
				if (params.window_id) args.push("--window-id", params.window_id);
				if (params.root_ref) args.push("--root", params.root_ref);
				if (params.interactive_only ?? true) args.push("-i");
				if (params.compact ?? true) args.push("--compact");
				if (params.skeleton) args.push("--skeleton");
				if (params.max_depth) args.push("--max-depth", String(params.max_depth));
				break;
			}

			case "click":
			case "double_click":
			case "right_click": {
				const cmd =
					params.action === "double_click"
						? "double-click"
						: params.action === "right_click"
							? "right-click"
							: "click";
				if (!params.ref) {
					return {
						content: [
							{
								type: "text",
								text: `Error: 'ref' parameter is required for action '${params.action}' (e.g. '@s8f3k2p9:e1').`,
							},
						],
						isError: true,
					};
				}
				args.push(cmd, params.ref);
				break;
			}

			case "type": {
				if (!params.ref) {
					return {
						content: [{ type: "text", text: "Error: 'ref' parameter is required for 'type'." }],
						isError: true,
					};
				}
				args.push("type", params.ref, params.text ?? "");
				break;
			}

			case "set_value": {
				if (!params.ref) {
					return {
						content: [{ type: "text", text: "Error: 'ref' parameter is required for 'set_value'." }],
						isError: true,
					};
				}
				args.push("set-value", params.ref, params.text ?? "");
				break;
			}

			case "clear": {
				if (!params.ref) {
					return {
						content: [{ type: "text", text: "Error: 'ref' parameter is required for 'clear'." }],
						isError: true,
					};
				}
				args.push("clear", params.ref);
				break;
			}

			case "press": {
				if (!params.key) {
					return {
						content: [{ type: "text", text: "Error: 'key' parameter is required for 'press'." }],
						isError: true,
					};
				}
				args.push("press", params.key);
				if (params.app) args.push("--app", params.app);
				break;
			}

			case "focus": {
				if (!params.ref) {
					return {
						content: [{ type: "text", text: "Error: 'ref' parameter is required for 'focus'." }],
						isError: true,
					};
				}
				args.push("focus", params.ref);
				break;
			}

			case "toggle": {
				if (!params.ref) {
					return {
						content: [{ type: "text", text: "Error: 'ref' parameter is required for 'toggle'." }],
						isError: true,
					};
				}
				args.push("toggle", params.ref);
				break;
			}

			case "select": {
				if (!params.ref) {
					return {
						content: [{ type: "text", text: "Error: 'ref' parameter is required for 'select'." }],
						isError: true,
					};
				}
				args.push("select", params.ref);
				if (params.text) args.push("--value", params.text);
				break;
			}

			case "scroll":
			case "scroll_to": {
				if (params.action === "scroll_to") {
					if (!params.ref) {
						return {
							content: [{ type: "text", text: "Error: 'ref' parameter is required for 'scroll_to'." }],
							isError: true,
						};
					}
					args.push("scroll-to", params.ref);
				} else {
					args.push("scroll");
					if (params.ref) args.push(params.ref);
				}
				break;
			}

			case "find": {
				args.push("find");
				if (params.app) args.push("--app", params.app);
				if (params.role) args.push("--role", params.role);
				if (params.name) args.push("--name", params.name);
				break;
			}

			case "wait": {
				args.push("wait");
				if (params.app) args.push("--app", params.app);
				if (params.name) args.push("--text", params.name);
				if (params.ref) args.push("--element", params.ref);
				if (params.timeout_ms) args.push("--timeout", String(params.timeout_ms));
				break;
			}

			default:
				return {
					content: [{ type: "text", text: `Error: Unsupported action '${params.action}'` }],
					isError: true,
				};
		}

		try {
			const { stdout, stderr } = await execFileAsync(binary, args, {
				timeout: params.timeout_ms ?? 10000,
				signal,
				env: {
					...process.env,
					// ensure DBUS session bus is inherited
					DBUS_SESSION_BUS_ADDRESS:
						process.env.DBUS_SESSION_BUS_ADDRESS ||
						`unix:path=/run/user/${process.getuid ? process.getuid() : 1000}/bus`,
				},
			});

			let envelope: AgentDesktopEnvelope;
			try {
				envelope = JSON.parse(stdout);
			} catch {
				return {
					content: [
						{
							type: "text",
							text: stdout.trim() || stderr.trim() || "No output returned from agent-desktop",
						},
					],
					isError: false,
				};
			}

			if (!envelope.ok) {
				const err = envelope.error || {};
				return {
					content: [
						{
							type: "text",
							text: `**Accessibility Error [${err.code || "UNKNOWN"}]:** ${err.message || "Action failed"}\n\nDetails: \`\`\`json\n${JSON.stringify(err.details || {}, null, 2)}\n\`\`\``,
						},
					],
					isError: true,
				};
			}

			// Format friendly output for snapshots and queries
			let displayText = "";
			if (params.action === "snapshot" && envelope.data?.tree) {
				const snapshotId = envelope.data.snapshot_id;
				const refCount = envelope.data.ref_count ?? 0;
				const app = envelope.data.app || "Desktop";
				const treeMd = formatTreeMarkdown(envelope.data.tree);
				displayText = `### Accessibility Tree: ${app} (Snapshot: \`${snapshotId}\`, ${refCount} interactive elements)\n\n${treeMd}`;
			} else if (params.action === "list_windows" && Array.isArray(envelope.data)) {
				const list = envelope.data
					.map(
						(w: any) =>
							`- **${w.title || "Untitled"}** (app: \`${w.app_name}\`, pid: ${w.pid}, focused: ${w.is_focused})\n  id: \`${w.id}\``,
					)
					.join("\n");
				displayText = `### Active Desktop Windows (${envelope.data.length})\n\n${list}`;
			} else {
				displayText = `\`\`\`json\n${JSON.stringify(envelope.data ?? envelope, null, 2)}\n\`\`\``;
			}

			return {
				content: [{ type: "text", text: displayText }],
				isError: false,
			};
		} catch (error: any) {
			return {
				content: [
					{
						type: "text",
						text: `Failed executing desktop_accessibility (${params.action}): ${error.message || String(error)}`,
					},
				],
				isError: true,
			};
		}
	}
}
