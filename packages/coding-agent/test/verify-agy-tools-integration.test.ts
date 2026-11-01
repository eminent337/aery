import { describe, expect, it } from "vitest";
import {
	createTools,
	BUILTIN_TOOLS,
	DesktopControlTool,
	TakeScreenshotTool,
	ClickAtTool,
	MoveCursorTool,
	TypeTextTool,
	PressKeyTool,
	DragAndDropAtTool,
	ScrollAtTool,
} from "../src/tools";

describe("AGY Tools Integration & Loading Verification", () => {
	const mockSession: any = {
		cwd: "/home/aryee/aery/ai_agent",
		settings: {
			get: (_k: string) => false,
		},
		supportsVision: () => true,
		sendCustomMessage: async () => {},
		dropLiveVerifyImages: async () => 0,
	};

	it("creates all tools including AGY Computer Use tools via createTools()", async () => {
		const tools = await createTools(mockSession);
		const toolNames = tools.map(t => t.name);

		expect(toolNames).toContain("take_screenshot");
		expect(toolNames).toContain("click_at");
		expect(toolNames).toContain("move_cursor");
		expect(toolNames).toContain("type_text");
		expect(toolNames).toContain("press_key");
		expect(toolNames).toContain("drag_and_drop_at");
		expect(toolNames).toContain("scroll_at");
		expect(toolNames).toContain("desktop_control");
		expect(toolNames).toContain("call_external_agent");
	});

	it("verifies individual tool instances have valid parameters schema and properties", () => {
		const shot = new TakeScreenshotTool(mockSession);
		expect(shot.name).toBe("take_screenshot");
		expect(shot.approval).toBe("read");
		expect(shot.parameters).toBeDefined();

		const click = new ClickAtTool(mockSession);
		expect(click.name).toBe("click_at");
		expect(click.approval).toBe("write");
		expect(click.parameters).toBeDefined();

		const move = new MoveCursorTool(mockSession);
		expect(move.name).toBe("move_cursor");
		expect(move.approval).toBe("read");
		expect(move.parameters).toBeDefined();

		const type = new TypeTextTool(mockSession);
		expect(type.name).toBe("type_text");
		expect(type.approval).toBe("write");
		expect(type.parameters).toBeDefined();

		const key = new PressKeyTool(mockSession);
		expect(key.name).toBe("press_key");
		expect(key.approval).toBe("write");
		expect(key.parameters).toBeDefined();

		const drag = new DragAndDropAtTool(mockSession);
		expect(drag.name).toBe("drag_and_drop_at");
		expect(drag.approval).toBe("write");
		expect(drag.parameters).toBeDefined();

		const scroll = new ScrollAtTool(mockSession);
		expect(scroll.name).toBe("scroll_at");
		expect(scroll.approval).toBe("write");
		expect(scroll.parameters).toBeDefined();
	});

	it("verifies desktop_control accepts all AGY Computer Use actions in its schema", () => {
		const dc = new DesktopControlTool(mockSession);
		const schema = dc.parameters;

		const testActions = [
			{ action: "take_screenshot", target: "fullscreen" },
			{ action: "click_at", x: 500, y: 500, click_count: 1 },
			{ action: "move_cursor", x: 100, y: 200 },
			{ action: "type_text", text: "testing", press_enter: true },
			{ action: "press_key", key: "Return" },
			{ action: "drag_and_drop_at", from_x: 100, from_y: 100, to_x: 500, to_y: 500 },
			{ action: "scroll_at", x: 500, y: 500, direction: "up", count: 2 },
			{ action: "mouse_down", button: "left" },
			{ action: "mouse_up", button: "left" },
		];

		for (const item of testActions) {
			const parsed = schema.safeParse(item);
			expect(parsed.success, `Failed to parse action ${item.action}`).toBe(true);
		}
	});
});
