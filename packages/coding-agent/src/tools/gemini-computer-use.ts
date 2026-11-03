import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback, ToolApprovalDecision } from "@aryee337/aery-core";
import * as z from "zod/v4";
import { DesktopControlTool } from "./desktop-control";

/**
 * Denormalize Google Gemini 0..1000 coordinates to actual screen/viewport pixels.
 * If coordinate is already physical (e.g. > 1000), clamps within display bounds.
 */
export function denormalizeCoordinate(val: number, maxDim: number): number {
	if (val < 0) return 0;
	if (val > 1000) return Math.min(maxDim - 1, Math.max(0, Math.round(val)));
	const scaled = Math.round((val / 1000) * maxDim);
	return Math.min(maxDim - 1, Math.max(0, scaled));
}

export const geminiComputerUseSchema = z.object({
	action: z
		.enum([
			"click",
			"move",
			"press_mouse_button",
			"release_mouse_button",
			"right_click",
			"double_click",
			"triple_click",
			"middle_click",
			"drag",
			"scroll",
			"type",
			"press_key",
			"key_down",
			"key_up",
			"wait",
			"screenshot",
		])
		.describe("The GUI action to perform (Google Gemini format)."),
	x: z.number().optional().describe("Normalized X coordinate (0..1000)."),
	y: z.number().optional().describe("Normalized Y coordinate (0..1000)."),
	end_x: z.number().optional().describe("Ending normalized X coordinate for drag (0..1000)."),
	end_y: z.number().optional().describe("Ending normalized Y coordinate for drag (0..1000)."),
	text: z.string().optional().describe("Text string to type into focused input."),
	key: z.string().optional().describe("Key or hotkey chord to press (e.g. 'Return', 'Escape', 'Control+c')."),
	button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button (default: left)."),
	direction: z.enum(["up", "down", "left", "right"]).optional().describe("Scroll direction."),
	amount: z.number().optional().describe("Scroll ticks/distance (default: 3)."),
	duration_ms: z.number().optional().describe("Wait duration in milliseconds."),
	intent: z.string().optional().describe("Model's stated purpose/intent for taking this action."),
});

export type GeminiComputerUseParams = z.infer<typeof geminiComputerUseSchema>;

export class GeminiComputerUseTool implements AgentTool<typeof geminiComputerUseSchema> {
	readonly name = "gemini_computer_use";
	readonly approval: ToolApprovalDecision = "write";
	readonly label = "Gemini Computer Use";
	readonly summary = "Execute native Google Gemini Computer Use actions with 0..1000 normalized coordinates";
	readonly description =
		"Native Google Gemini Computer Use tool. Supports normalized 0..1000 coordinates, intent tracking, clicks, drags, text typing, scrolling, and screenshot perception.";
	readonly parameters = geminiComputerUseSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;

	private readonly delegate: DesktopControlTool;

	constructor(session?: any) {
		this.delegate = new DesktopControlTool(session);
	}

	static createIf(session?: any): GeminiComputerUseTool | null {
		return new GeminiComputerUseTool(session);
	}

	async execute(
		toolCallId: string,
		params: GeminiComputerUseParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const t0 = Date.now();
		switch (params.action) {
			case "click":
			case "right_click":
			case "double_click":
			case "triple_click":
			case "middle_click": {
				const button =
					params.action === "right_click"
						? "right"
						: params.action === "middle_click"
							? "middle"
							: params.button || "left";
				const clickCount =
					params.action === "double_click" ? 2 : params.action === "triple_click" ? 3 : 1;
				return this.delegate.execute(
					toolCallId,
					{
						action: "click_at",
						x: params.x ?? 500,
						y: params.y ?? 500,
						button,
						click_count: clickCount,
						coordinate_system: "normalized_1000",
					},
					signal,
					onUpdate,
				);
			}
			case "move":
				return this.delegate.execute(
					toolCallId,
					{
						action: "move_cursor",
						x: params.x ?? 500,
						y: params.y ?? 500,
						coordinate_system: "normalized_1000",
					},
					signal,
					onUpdate,
				);
			case "type":
				return this.delegate.execute(
					toolCallId,
					{
						action: "type_text",
						text: params.text || "",
					},
					signal,
					onUpdate,
				);
			case "press_key":
				return this.delegate.execute(
					toolCallId,
					{
						action: "press_key",
						key: params.key || "Return",
					},
					signal,
					onUpdate,
				);
			case "drag":
				return this.delegate.execute(
					toolCallId,
					{
						action: "drag_and_drop_at",
						from_x: params.x ?? 0,
						from_y: params.y ?? 0,
						to_x: params.end_x ?? params.x ?? 0,
						to_y: params.end_y ?? params.y ?? 0,
						coordinate_system: "normalized_1000",
					},
					signal,
					onUpdate,
				);
			case "scroll":
				return this.delegate.execute(
					toolCallId,
					{
						action: "scroll_at",
						x: params.x ?? 500,
						y: params.y ?? 500,
						direction: params.direction || "down",
						count: params.amount ?? 3,
						coordinate_system: "normalized_1000",
					},
					signal,
					onUpdate,
				);
			case "wait":
				await new Promise(r => setTimeout(r, Math.min(10000, params.duration_ms ?? 1000)));
				return {
					content: [{ type: "text", text: `Waited ${params.duration_ms ?? 1000}ms` }],
					details: { duration_ms: Date.now() - t0, status: "success", intent: params.intent },
				};
			case "screenshot":
			default:
				return this.delegate.execute(
					toolCallId,
					{
						action: "take_screenshot",
						target: "fullscreen",
						include_base64: true,
					},
					signal,
					onUpdate,
				);
		}
	}
}
