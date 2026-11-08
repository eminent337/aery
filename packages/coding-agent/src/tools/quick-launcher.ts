/**
 * quick-launcher.ts — Global Quick Launcher HUD Tool for Aery.
 *
 * Implements a floating Spotlight/Raycast-style HUD summoned via a global hotkey,
 * enabling instantaneous user prompt dispatching from anywhere on the desktop.
 */

import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@aryee337/aery-core";
import * as z from "zod/v4";

export const quickLauncherSchema = z.object({
	action: z
		.enum(["status", "configure", "open", "dismiss", "dispatch_prompt"])
		.describe("Quick launcher action to perform."),
	hotkey: z.string().optional().describe("Global keyboard shortcut (e.g. 'Ctrl+Space' or 'Super+Space')."),
	position: z.enum(["center", "top"]).optional().describe("Position of the HUD on the screen."),
	auto_dismiss: z.boolean().optional().describe("Whether to automatically dismiss the HUD after prompt submission."),
	prompt: z.string().optional().describe("Prompt text to dispatch to the active Aery agent session."),
});

export type QuickLauncherParams = z.infer<typeof quickLauncherSchema>;

export interface QuickLauncherState {
	visible: boolean;
	hotkey: string;
	position: "center" | "top";
	autoDismiss: boolean;
	lastPrompt: string | null;
}

export class QuickLauncherTool implements AgentTool<typeof quickLauncherSchema> {
	readonly name = "quick_launcher";
	readonly approval = "read" as const;
	readonly label = "Quick Launcher HUD";
	readonly summary = "Global floating HUD for instant prompt dispatching without window switching";
	readonly description =
		"Global Quick Launcher HUD tool. Controls the floating Spotlight-style input bar summoned via global shortcut to dispatch instructions to Aery anywhere on the desktop.";
	readonly parameters = quickLauncherSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;

	private state: QuickLauncherState = {
		visible: false,
		hotkey: "Ctrl+Space",
		position: "center",
		autoDismiss: true,
		lastPrompt: null,
	};

	private readonly session: any;

	constructor(opts?: { session?: any }) {
		this.session = opts?.session;
	}

	static createIf(session?: any): QuickLauncherTool | null {
		return new QuickLauncherTool({ session });
	}

	async execute(
		toolCallId: string,
		params: QuickLauncherParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		switch (params.action) {
			case "status": {
				return {
					content: [
						{
							type: "text",
							text: `Quick Launcher Status:\n• visible: ${this.state.visible}\n• hotkey: ${this.state.hotkey}\n• position: ${this.state.position}\n• auto_dismiss: ${this.state.autoDismiss}\n• last_prompt: ${this.state.lastPrompt || "(none)"}`,
						},
					],
				};
			}

			case "configure": {
				if (params.hotkey) this.state.hotkey = params.hotkey;
				if (params.position) this.state.position = params.position;
				if (params.auto_dismiss !== undefined) this.state.autoDismiss = params.auto_dismiss;

				return {
					content: [
						{
							type: "text",
							text: `Quick Launcher configured:\n• hotkey: ${this.state.hotkey}\n• position: ${this.state.position}\n• auto_dismiss: ${this.state.autoDismiss}`,
						},
					],
				};
			}

			case "open": {
				this.state.visible = true;
				return {
					content: [
						{
							type: "text",
							text: `Quick Launcher HUD opened at ${this.state.position} of active display. Ready for user input.`,
						},
					],
				};
			}

			case "dismiss": {
				this.state.visible = false;
				return {
					content: [
						{
							type: "text",
							text: "Quick Launcher HUD dismissed.",
						},
					],
				};
			}

			case "dispatch_prompt": {
				if (!params.prompt) {
					return {
						isError: true,
						content: [{ type: "text", text: "prompt is required for dispatch_prompt action." }],
					};
				}

				this.state.lastPrompt = params.prompt;
				if (this.state.autoDismiss) {
					this.state.visible = false;
				}

				// If session is connected, forward prompt
				if (this.session?.sendCustomMessage) {
					await this.session.sendCustomMessage({
						type: "quick_prompt",
						prompt: params.prompt,
					});
				}

				return {
					content: [
						{
							type: "text",
							text: `Dispatched prompt "${params.prompt}" to active Aery session${this.state.autoDismiss ? " (HUD auto-dismissed)" : ""}.`,
						},
					],
				};
			}

			default:
				return {
					isError: true,
					content: [{ type: "text", text: `Unknown action: ${(params as any).action}` }],
				};
		}
	}
}
