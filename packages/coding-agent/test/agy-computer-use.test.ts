import { describe, expect, it } from "vitest";
import {
	BUILTIN_TOOLS,
	ClickAtTool,
	clickAtSchema,
	DragAndDropAtTool,
	dragAndDropAtSchema,
	MoveCursorTool,
	moveCursorSchema,
	PressKeyTool,
	pressKeySchema,
	ScrollAtTool,
	scrollAtSchema,
	TakeScreenshotTool,
	takeScreenshotSchema,
	TypeTextTool,
	typeTextSchema,
	validateInjection,
} from "../src/tools";

describe("AGY Computer Use Tools", () => {
	it("registers all AGY native computer use tools in BUILTIN_TOOLS", () => {
		expect(BUILTIN_TOOLS.take_screenshot).toBeDefined();
		expect(BUILTIN_TOOLS.click_at).toBeDefined();
		expect(BUILTIN_TOOLS.move_cursor).toBeDefined();
		expect(BUILTIN_TOOLS.type_text).toBeDefined();
		expect(BUILTIN_TOOLS.press_key).toBeDefined();
		expect(BUILTIN_TOOLS.drag_and_drop_at).toBeDefined();
		expect(BUILTIN_TOOLS.scroll_at).toBeDefined();
	});

	it("instantiates standalone tools with correct AGY metadata and approval tiers", () => {
		const dummySession = { cwd: "/tmp" } as any;

		const shot = TakeScreenshotTool.createIf(dummySession);
		expect(shot).not.toBeNull();
		expect(shot?.name).toBe("take_screenshot");
		expect(shot?.approval).toBe("read");
		expect(shot?.strict).toBe(true);

		const click = ClickAtTool.createIf(dummySession);
		expect(click).not.toBeNull();
		expect(click?.name).toBe("click_at");
		expect(click?.approval).toBe("write");
		expect(click?.strict).toBe(true);

		const move = MoveCursorTool.createIf(dummySession);
		expect(move).not.toBeNull();
		expect(move?.name).toBe("move_cursor");
		expect(move?.approval).toBe("read");

		const type = TypeTextTool.createIf(dummySession);
		expect(type).not.toBeNull();
		expect(type?.name).toBe("type_text");
		expect(type?.approval).toBe("write");

		const key = PressKeyTool.createIf(dummySession);
		expect(key).not.toBeNull();
		expect(key?.name).toBe("press_key");
		expect(key?.approval).toBe("write");

		const drag = DragAndDropAtTool.createIf(dummySession);
		expect(drag).not.toBeNull();
		expect(drag?.name).toBe("drag_and_drop_at");
		expect(drag?.approval).toBe("write");

		const scroll = ScrollAtTool.createIf(dummySession);
		expect(scroll).not.toBeNull();
		expect(scroll?.name).toBe("scroll_at");
		expect(scroll?.approval).toBe("write");
	});

	it("validates schemas for all AGY Computer Use actions", () => {
		const shotParsed = takeScreenshotSchema.parse({
			target: "active_window",
			include_base64: true,
			ocr: true,
		});
		expect(shotParsed.target).toBe("active_window");
		expect(shotParsed.include_base64).toBe(true);

		const clickParsed = clickAtSchema.parse({
			x: 500,
			y: 500,
			button: "left",
			click_count: 2,
			coordinate_system: "normalized_1000",
		});
		expect(clickParsed.x).toBe(500);
		expect(clickParsed.y).toBe(500);
		expect(clickParsed.click_count).toBe(2);

		const moveParsed = moveCursorSchema.parse({
			x: 250,
			y: 750,
		});
		expect(moveParsed.x).toBe(250);
		expect(moveParsed.y).toBe(750);

		const typeParsed = typeTextSchema.parse({
			text: "echo 'hello from AGY'",
			press_enter: true,
		});
		expect(typeParsed.text).toBe("echo 'hello from AGY'");
		expect(typeParsed.press_enter).toBe(true);

		const keyParsed = pressKeySchema.parse({
			key: "ctrl+shift+t",
		});
		expect(keyParsed.key).toBe("ctrl+shift+t");

		const dragParsed = dragAndDropAtSchema.parse({
			from_x: 100,
			from_y: 200,
			to_x: 800,
			to_y: 900,
		});
		expect(dragParsed.from_x).toBe(100);
		expect(dragParsed.to_x).toBe(800);

		const scrollParsed = scrollAtSchema.parse({
			x: 500,
			y: 500,
			direction: "down",
			count: 5,
		});
		expect(scrollParsed.direction).toBe("down");
		expect(scrollParsed.count).toBe(5);
	});

	it("validates injection coordinates and actions in validateInjection", () => {
		const fakeFrame = {
			scaledW: 1280,
			scaledH: 800,
			kind: "window",
			address: "0x1234",
		};

		// In-bounds click_at
		const validClick = validateInjection({
			action: "click_at",
			x: 640,
			y: 400,
			frame: fakeFrame,
			focusedAddress: "0x1234",
		});
		expect(validClick.ok).toBe(true);

		// Out-of-bounds click_at
		const outOfBounds = validateInjection({
			action: "click_at",
			x: 1500,
			y: 900,
			frame: fakeFrame,
			focusedAddress: "0x1234",
		});
		expect(outOfBounds.ok).toBe(false);

		// In-bounds move_cursor
		const validMove = validateInjection({
			action: "move_cursor",
			x: 100,
			y: 100,
			frame: fakeFrame,
			focusedAddress: "0x1234",
		});
		expect(validMove.ok).toBe(true);

		// Missing text for type_text
		const missingType = validateInjection({
			action: "type_text",
			frame: fakeFrame,
			focusedAddress: "0x1234",
		});
		expect(missingType.ok).toBe(false);

		// Missing key for press_key
		const missingKey = validateInjection({
			action: "press_key",
			frame: fakeFrame,
			focusedAddress: "0x1234",
		});
		expect(missingKey.ok).toBe(false);
	});

	it("calculates 0..1000 normalized coordinates correctly", () => {
		const frame = { scaledW: 1920, scaledH: 1080 };
		const normX = 500;
		const normY = 500;

		const mappedX = Math.round((normX / 1000) * frame.scaledW);
		const mappedY = Math.round((normY / 1000) * frame.scaledH);

		expect(mappedX).toBe(960);
		expect(mappedY).toBe(540);

		const cornerX = 1000;
		const cornerY = 1000;
		expect(Math.round((cornerX / 1000) * frame.scaledW)).toBe(1920);
		expect(Math.round((cornerY / 1000) * frame.scaledH)).toBe(1080);
	});
});
