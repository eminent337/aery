/**
 * agy-computer-use.ts — AGY (Google Antigravity) native Computer Use tools.
 *
 * Implements Google ComputerUse specification (Gemini 2.0 / Gemini 4 Argon)
 * and Anthropic/OpenAI Computer Use protocol with 0..1000 normalized grid coordinates
 * and display-frame translation.
 */

import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback, ToolApprovalDecision } from "@aryee337/aery-core";
import * as z from "zod/v4";
import { DesktopControlTool } from "./desktop-control";

interface MinimalSession {
	supportsVision?: () => boolean;
	sendCustomMessage?: (msg: unknown, opts: unknown) => Promise<void>;
	dropLiveVerifyImages?: () => Promise<number>;
}

// ---------------------------------------------------------------------------
// 1. take_screenshot
// ---------------------------------------------------------------------------
export const takeScreenshotSchema = z.object({
	target: z
		.string()
		.optional()
		.describe("Window title, app name, or 'fullscreen' (defaults to active_window)."),
	include_base64: z
		.boolean()
		.optional()
		.describe("Whether to include base64-encoded image data in response (default: true)."),
	ocr: z
		.boolean()
		.optional()
		.describe("Whether to run OCR on the screenshot (default: true for visionless models)."),
});

export type TakeScreenshotParams = z.infer<typeof takeScreenshotSchema>;

export class TakeScreenshotTool implements AgentTool<typeof takeScreenshotSchema> {
	readonly name = "take_screenshot";
	readonly approval = "read" as const;
	readonly label = "Take Screenshot";
	readonly summary = "Capture a desktop or window screenshot with normalized frame geometry and base64 image data";
	readonly description =
		"Capture a screenshot of the active window or entire display (AGY Computer Use format). Returns inline image data and coordinate frame dimensions for subsequent interaction.";
	readonly parameters = takeScreenshotSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;

	private readonly delegate: DesktopControlTool;

	constructor(session?: MinimalSession) {
		this.delegate = new DesktopControlTool(session as any);
	}

	static createIf(session?: MinimalSession): TakeScreenshotTool | null {
		return new TakeScreenshotTool(session);
	}

	async execute(
		toolCallId: string,
		params: TakeScreenshotParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		return this.delegate.execute(
			toolCallId,
			{
				action: "take_screenshot",
				target: params.target,
				include_base64: params.include_base64 ?? true,
				ocr: params.ocr,
			},
			signal,
			onUpdate,
		);
	}
}

// ---------------------------------------------------------------------------
// 2. click_at
// ---------------------------------------------------------------------------
export const clickAtSchema = z.object({
	x: z
		.number()
		.describe("X coordinate (0..1000 normalized grid coordinate by default, or frame pixel)."),
	y: z
		.number()
		.describe("Y coordinate (0..1000 normalized grid coordinate by default, or frame pixel)."),
	button: z
		.enum(["left", "right", "middle"])
		.optional()
		.describe("Mouse button to click (default: 'left')."),
	click_count: z
		.number()
		.int()
		.min(1)
		.max(3)
		.optional()
		.describe("Number of clicks: 1 for single click, 2 for double click (default: 1)."),
	coordinate_system: z
		.enum(["normalized_1000", "frame", "physical"])
		.optional()
		.describe("Coordinate system: 'normalized_1000' (0..1000 grid, default) or 'frame' px."),
});

export type ClickAtParams = z.infer<typeof clickAtSchema>;

export class ClickAtTool implements AgentTool<typeof clickAtSchema> {
	readonly name = "click_at";
	readonly approval: ToolApprovalDecision = "write";
	readonly label = "Click At";
	readonly summary = "Click at specific coordinates on the desktop or focused window";
	readonly description =
		"Move mouse cursor to (x, y) and perform a mouse click (AGY Computer Use format). Supports 0..1000 normalized coordinates.";
	readonly parameters = clickAtSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;

	private readonly delegate: DesktopControlTool;

	constructor(session?: MinimalSession) {
		this.delegate = new DesktopControlTool(session as any);
	}

	static createIf(session?: MinimalSession): ClickAtTool | null {
		return new ClickAtTool(session);
	}

	async execute(
		toolCallId: string,
		params: ClickAtParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		return this.delegate.execute(
			toolCallId,
			{
				action: "click_at",
				x: params.x,
				y: params.y,
				button: params.button,
				click_count: params.click_count ?? 1,
				coordinate_system: params.coordinate_system ?? "normalized_1000",
			},
			signal,
			onUpdate,
		);
	}
}

// ---------------------------------------------------------------------------
// 3. move_cursor
// ---------------------------------------------------------------------------
export const moveCursorSchema = z.object({
	x: z
		.number()
		.describe("Target X coordinate (0..1000 normalized grid coordinate by default, or frame pixel)."),
	y: z
		.number()
		.describe("Target Y coordinate (0..1000 normalized grid coordinate by default, or frame pixel)."),
	coordinate_system: z
		.enum(["normalized_1000", "frame", "physical"])
		.optional()
		.describe("Coordinate system: 'normalized_1000' (0..1000 grid, default) or 'frame' px."),
});

export type MoveCursorParams = z.infer<typeof moveCursorSchema>;

export class MoveCursorTool implements AgentTool<typeof moveCursorSchema> {
	readonly name = "move_cursor";
	readonly approval = "read" as const;
	readonly label = "Move Cursor";
	readonly summary = "Move mouse cursor to coordinates without clicking";
	readonly description =
		"Glide mouse cursor to (x, y) coordinates on the screen (AGY Computer Use format). Safe, read-tier observation tool.";
	readonly parameters = moveCursorSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;

	private readonly delegate: DesktopControlTool;

	constructor(session?: MinimalSession) {
		this.delegate = new DesktopControlTool(session as any);
	}

	static createIf(session?: MinimalSession): MoveCursorTool | null {
		return new MoveCursorTool(session);
	}

	async execute(
		toolCallId: string,
		params: MoveCursorParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		return this.delegate.execute(
			toolCallId,
			{
				action: "move_cursor",
				x: params.x,
				y: params.y,
				coordinate_system: params.coordinate_system ?? "normalized_1000",
			},
			signal,
			onUpdate,
		);
	}
}

// ---------------------------------------------------------------------------
// 4. type_text
// ---------------------------------------------------------------------------
export const typeTextSchema = z.object({
	text: z.string().describe("Text string to type into the focused application or control."),
	press_enter: z
		.boolean()
		.optional()
		.describe("Whether to press Enter/Return immediately after typing (default: false)."),
});

export type TypeTextParams = z.infer<typeof typeTextSchema>;

export class TypeTextTool implements AgentTool<typeof typeTextSchema> {
	readonly name = "type_text";
	readonly approval: ToolApprovalDecision = "write";
	readonly label = "Type Text";
	readonly summary = "Type text into the focused window or input field";
	readonly description =
		"Inject keystrokes for a text string into the active focused window (AGY Computer Use format). Optional press_enter submits.";
	readonly parameters = typeTextSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;

	private readonly delegate: DesktopControlTool;

	constructor(session?: MinimalSession) {
		this.delegate = new DesktopControlTool(session as any);
	}

	static createIf(session?: MinimalSession): TypeTextTool | null {
		return new TypeTextTool(session);
	}

	async execute(
		toolCallId: string,
		params: TypeTextParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		return this.delegate.execute(
			toolCallId,
			{
				action: "type_text",
				text: params.text,
				press_enter: params.press_enter ?? false,
			},
			signal,
			onUpdate,
		);
	}
}

// ---------------------------------------------------------------------------
// 5. press_key
// ---------------------------------------------------------------------------
export const pressKeySchema = z.object({
	key: z
		.string()
		.describe("Key or combination to press (e.g. 'Return', 'Tab', 'Escape', 'BackSpace', 'ctrl+c', 'ctrl+v')."),
});

export type PressKeyParams = z.infer<typeof pressKeySchema>;

export class PressKeyTool implements AgentTool<typeof pressKeySchema> {
	readonly name = "press_key";
	readonly approval: ToolApprovalDecision = "write";
	readonly label = "Press Key";
	readonly summary = "Press a special key or shortcut combination";
	readonly description =
		"Send key events (single keys or chords like ctrl+c, Return, BackSpace) into the active window (AGY Computer Use format).";
	readonly parameters = pressKeySchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;

	private readonly delegate: DesktopControlTool;

	constructor(session?: MinimalSession) {
		this.delegate = new DesktopControlTool(session as any);
	}

	static createIf(session?: MinimalSession): PressKeyTool | null {
		return new PressKeyTool(session);
	}

	async execute(
		toolCallId: string,
		params: PressKeyParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		return this.delegate.execute(
			toolCallId,
			{
				action: "press_key",
				key: params.key,
			},
			signal,
			onUpdate,
		);
	}
}

// ---------------------------------------------------------------------------
// 6. drag_and_drop_at
// ---------------------------------------------------------------------------
export const dragAndDropAtSchema = z.object({
	from_x: z
		.number()
		.describe("Starting X coordinate (0..1000 normalized grid coordinate by default, or frame pixel)."),
	from_y: z
		.number()
		.describe("Starting Y coordinate (0..1000 normalized grid coordinate by default, or frame pixel)."),
	to_x: z
		.number()
		.describe("Ending X coordinate (0..1000 normalized grid coordinate by default, or frame pixel)."),
	to_y: z
		.number()
		.describe("Ending Y coordinate (0..1000 normalized grid coordinate by default, or frame pixel)."),
	coordinate_system: z
		.enum(["normalized_1000", "frame", "physical"])
		.optional()
		.describe("Coordinate system: 'normalized_1000' (0..1000 grid, default) or 'frame' px."),
});

export type DragAndDropAtParams = z.infer<typeof dragAndDropAtSchema>;

export class DragAndDropAtTool implements AgentTool<typeof dragAndDropAtSchema> {
	readonly name = "drag_and_drop_at";
	readonly approval: ToolApprovalDecision = "write";
	readonly label = "Drag and Drop";
	readonly summary = "Click and drag from start coordinates to end coordinates";
	readonly description =
		"Drag mouse cursor with button held from (from_x, from_y) to (to_x, to_y) (AGY Computer Use format). Supports 0..1000 normalized grid.";
	readonly parameters = dragAndDropAtSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;

	private readonly delegate: DesktopControlTool;

	constructor(session?: MinimalSession) {
		this.delegate = new DesktopControlTool(session as any);
	}

	static createIf(session?: MinimalSession): DragAndDropAtTool | null {
		return new DragAndDropAtTool(session);
	}

	async execute(
		toolCallId: string,
		params: DragAndDropAtParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		return this.delegate.execute(
			toolCallId,
			{
				action: "drag_and_drop_at",
				from_x: params.from_x,
				from_y: params.from_y,
				to_x: params.to_x,
				to_y: params.to_y,
				coordinate_system: params.coordinate_system ?? "normalized_1000",
			},
			signal,
			onUpdate,
		);
	}
}

// ---------------------------------------------------------------------------
// 7. scroll_at
// ---------------------------------------------------------------------------
export const scrollAtSchema = z.object({
	x: z
		.number()
		.optional()
		.describe("X coordinate to hover before scrolling (0..1000 normalized grid coordinate by default)."),
	y: z
		.number()
		.optional()
		.describe("Y coordinate to hover before scrolling (0..1000 normalized grid coordinate by default)."),
	direction: z
		.enum(["up", "down", "left", "right"])
		.optional()
		.describe("Scroll direction (default: 'down')."),
	count: z
		.number()
		.int()
		.min(1)
		.max(20)
		.optional()
		.describe("Number of scroll increments (default: 1)."),
	coordinate_system: z
		.enum(["normalized_1000", "frame", "physical"])
		.optional()
		.describe("Coordinate system: 'normalized_1000' (0..1000 grid, default) or 'frame' px."),
});

export type ScrollAtParams = z.infer<typeof scrollAtSchema>;

export class ScrollAtTool implements AgentTool<typeof scrollAtSchema> {
	readonly name = "scroll_at";
	readonly approval: ToolApprovalDecision = "write";
	readonly label = "Scroll At";
	readonly summary = "Scroll the viewport at specific coordinates";
	readonly description =
		"Scroll up, down, left, or right at the specified coordinates (AGY Computer Use format).";
	readonly parameters = scrollAtSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;

	private readonly delegate: DesktopControlTool;

	constructor(session?: MinimalSession) {
		this.delegate = new DesktopControlTool(session as any);
	}

	static createIf(session?: MinimalSession): ScrollAtTool | null {
		return new ScrollAtTool(session);
	}

	async execute(
		toolCallId: string,
		params: ScrollAtParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		return this.delegate.execute(
			toolCallId,
			{
				action: "scroll_at",
				x: params.x,
				y: params.y,
				direction: params.direction,
				count: params.count,
				coordinate_system: params.coordinate_system ?? "normalized_1000",
			},
			signal,
			onUpdate,
		);
	}
}

// ---------------------------------------------------------------------------
// 8. clipboard_get
// ---------------------------------------------------------------------------
export const clipboardGetSchema = z.object({});

export type ClipboardGetParams = z.infer<typeof clipboardGetSchema>;

export class ClipboardGetTool implements AgentTool<typeof clipboardGetSchema> {
	readonly name = "clipboard_get";
	readonly approval = "read" as const;
	readonly label = "Get Clipboard";
	readonly summary = "Read current text content from the desktop system clipboard";
	readonly description =
		"Retrieve plain text currently stored in the system clipboard (Wayland/X11). Safe, read-tier utility.";
	readonly parameters = clipboardGetSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;

	private readonly delegate: DesktopControlTool;

	constructor(session?: MinimalSession) {
		this.delegate = new DesktopControlTool(session as any);
	}

	static createIf(session?: MinimalSession): ClipboardGetTool | null {
		return new ClipboardGetTool(session);
	}

	async execute(
		toolCallId: string,
		_params: ClipboardGetParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		return this.delegate.execute(
			toolCallId,
			{
				action: "clipboard_get",
			},
			signal,
			onUpdate,
		);
	}
}

// ---------------------------------------------------------------------------
// 9. clipboard_set
// ---------------------------------------------------------------------------
export const clipboardSetSchema = z.object({
	text: z.string().describe("Text string to place onto the desktop system clipboard."),
});

export type ClipboardSetParams = z.infer<typeof clipboardSetSchema>;

export class ClipboardSetTool implements AgentTool<typeof clipboardSetSchema> {
	readonly name = "clipboard_set";
	readonly approval: ToolApprovalDecision = "write";
	readonly label = "Set Clipboard";
	readonly summary = "Write text content to the desktop system clipboard";
	readonly description =
		"Copy text to the desktop clipboard for subsequent pasting with Ctrl+V into applications.";
	readonly parameters = clipboardSetSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;

	private readonly delegate: DesktopControlTool;

	constructor(session?: MinimalSession) {
		this.delegate = new DesktopControlTool(session as any);
	}

	static createIf(session?: MinimalSession): ClipboardSetTool | null {
		return new ClipboardSetTool(session);
	}

	async execute(
		toolCallId: string,
		params: ClipboardSetParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		return this.delegate.execute(
			toolCallId,
			{
				action: "clipboard_set",
				text: params.text,
			},
			signal,
			onUpdate,
		);
	}
}

// ---------------------------------------------------------------------------
// 10. display_info
// ---------------------------------------------------------------------------
export const displayInfoSchema = z.object({});

export type DisplayInfoParams = z.infer<typeof displayInfoSchema>;

export class DisplayInfoTool implements AgentTool<typeof displayInfoSchema> {
	readonly name = "display_info";
	readonly approval = "read" as const;
	readonly label = "Display Info";
	readonly summary = "Inspect monitors, resolutions, display scaling, and active window geometry";
	readonly description =
		"Retrieve active display monitors, scale factors, resolution, cursor position, and focused window info.";
	readonly parameters = displayInfoSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;

	private readonly delegate: DesktopControlTool;

	constructor(session?: MinimalSession) {
		this.delegate = new DesktopControlTool(session as any);
	}

	static createIf(session?: MinimalSession): DisplayInfoTool | null {
		return new DisplayInfoTool(session);
	}

	async execute(
		toolCallId: string,
		_params: DisplayInfoParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		return this.delegate.execute(
			toolCallId,
			{
				action: "display_info",
			},
			signal,
			onUpdate,
		);
	}
}
