import { describe, expect, test } from "bun:test";
import {
	DesktopEmergencyStopTool,
	EmergencyStopController,
	FramePort,
	desktopEmergencyStopSchema,
} from "../src/tools/desktop-emergency-stop";

describe("EmergencyStopController", () => {
	test("manages halt state", () => {
		const controller = new EmergencyStopController();
		expect(controller.isHalted()).toBe(false);
		expect(controller.getReason()).toBeNull();
		expect(controller.getHaltedAt()).toBeNull();

		const reason = "User initiated safety halt";
		controller.halt(reason);

		expect(controller.isHalted()).toBe(true);
		expect(controller.getReason()).toBe(reason);
		expect(typeof controller.getHaltedAt()).toBe("number");

		const state = controller.getState();
		expect(state.halted).toBe(true);
		expect(state.reason).toBe(reason);
		expect(typeof state.haltedAt).toBe("number");
	});

	test("triggers emergency callbacks on halt", () => {
		const controller = new EmergencyStopController();
		let callCount = 0;
		let receivedReason = "";
		let receivedTimestamp = 0;

		const unsubscribe = controller.onHalt((reason, timestamp) => {
			callCount += 1;
			receivedReason = reason;
			receivedTimestamp = timestamp;
		});

		controller.halt("Critical safety interrupt");
		expect(callCount).toBe(1);
		expect(receivedReason).toBe("Critical safety interrupt");
		expect(receivedTimestamp).toBeGreaterThan(0);

		unsubscribe();
		controller.halt("Second halt call");
		expect(callCount).toBe(1);
	});

	test("resets state and triggers reset listeners", () => {
		const controller = new EmergencyStopController();
		let resetCalled = false;

		controller.onReset(() => {
			resetCalled = true;
		});

		controller.halt("Temporary halt");
		expect(controller.isHalted()).toBe(true);

		controller.reset();
		expect(controller.isHalted()).toBe(false);
		expect(controller.getReason()).toBeNull();
		expect(controller.getHaltedAt()).toBeNull();
		expect(resetCalled).toBe(true);
	});

	test("assertNotHalted throws when halted", () => {
		const controller = new EmergencyStopController();
		expect(() => controller.assertNotHalted()).not.toThrow();

		controller.halt("Blocked operation");
		expect(() => controller.assertNotHalted()).toThrow("Blocked operation");
	});

	test("isolates throwing and rejecting callbacks so other listeners still run", () => {
		const controller = new EmergencyStopController();
		let secondListenerCalled = false;

		controller.onHalt(() => {
			throw new Error("Synchronous callback explosion");
		});
		controller.onHalt(async () => {
			throw new Error("Asynchronous rejection explosion");
		});
		controller.onHalt(() => {
			secondListenerCalled = true;
		});

		expect(() => controller.halt("Safety test")).not.toThrow();
		expect(secondListenerCalled).toBe(true);
	});
});

describe("FramePort", () => {
	test("supports frame stream listener registration and emission", () => {
		const port = new FramePort();
		const emittedFrames: Array<{ timestamp: number; data: string }> = [];

		const unsubscribe = port.onFrame((frame) => {
			emittedFrames.push({ timestamp: frame.timestamp, data: String(frame.data) });
		});

		expect(port.getListenerCount()).toBe(1);

		port.emitFrame({
			data: "frame_data_1",
			timestamp: 1000,
			width: 1920,
			height: 1080,
		});

		expect(emittedFrames.length).toBe(1);
		expect(emittedFrames[0].data).toBe("frame_data_1");
		expect(emittedFrames[0].timestamp).toBe(1000);

		unsubscribe();
		expect(port.getListenerCount()).toBe(0);

		port.emitFrame({
			data: "frame_data_2",
			timestamp: 2000,
		});
		expect(emittedFrames.length).toBe(1);
	});

	test("supports stream hints configuration", () => {
		const port = new FramePort({ fps: 15, width: 1280, height: 720 });
		const initialHints = port.getStreamHints();
		expect(initialHints.fps).toBe(15);
		expect(initialHints.width).toBe(1280);
		expect(initialHints.height).toBe(720);

		const updated = port.setStreamHints({ fps: 30, format: "png" });
		expect(updated.fps).toBe(30);
		expect(updated.format).toBe("png");
		expect(updated.width).toBe(1280);
		expect(updated.height).toBe(720);
	});

	test("reports status accurately", () => {
		const port = new FramePort({ fps: 24 });
		let status = port.getStatus();
		expect(status.active).toBe(false);
		expect(status.listenerCount).toBe(0);
		expect(status.totalFramesEmitted).toBe(0);
		expect(status.lastFrameTimestamp).toBeNull();

		const unsub = port.onFrame(() => {});
		status = port.getStatus();
		expect(status.active).toBe(true);
		expect(status.listenerCount).toBe(1);

		port.emitFrame({ data: "buf", timestamp: 12345 });
		status = port.getStatus();
		expect(status.totalFramesEmitted).toBe(1);
		expect(status.lastFrameTimestamp).toBe(12345);

		unsub();
		status = port.getStatus();
		expect(status.active).toBe(false);
		expect(status.listenerCount).toBe(0);
	});
});

describe("desktopEmergencyStopSchema", () => {
	test("validates halt action", () => {
		const result = desktopEmergencyStopSchema.safeParse({
			action: "halt",
			reason: "User emergency abort",
		});
		expect(result.success).toBe(true);
	});

	test("validates reset action", () => {
		const result = desktopEmergencyStopSchema.safeParse({
			action: "reset",
		});
		expect(result.success).toBe(true);
	});

	test("validates status action", () => {
		const result = desktopEmergencyStopSchema.safeParse({
			action: "status",
		});
		expect(result.success).toBe(true);
	});

	test("validates stream_hints action", () => {
		const result = desktopEmergencyStopSchema.safeParse({
			action: "stream_hints",
			fps: 60,
			width: 1920,
			height: 1080,
			format: "jpeg",
		});
		expect(result.success).toBe(true);
	});

	test("rejects invalid actions", () => {
		const result = desktopEmergencyStopSchema.safeParse({
			action: "pause",
		});
		expect(result.success).toBe(false);
	});

	test("rejects invalid parameter values", () => {
		const result = desktopEmergencyStopSchema.safeParse({
			action: "stream_hints",
			fps: -5,
		});
		expect(result.success).toBe(false);
	});
});

describe("DesktopEmergencyStopTool", () => {
	test("conforms to AgentTool interface", () => {
		const tool = new DesktopEmergencyStopTool();
		expect(tool.name).toBe("desktop_emergency_stop");
		expect(typeof tool.label).toBe("string");
		expect(typeof tool.summary).toBe("string");
		expect(typeof tool.description).toBe("string");
		expect(tool.parameters).toBe(desktopEmergencyStopSchema);
		expect(typeof tool.execute).toBe("function");
	});

	test("executes halt lifecycle", async () => {
		const controller = new EmergencyStopController();
		const tool = new DesktopEmergencyStopTool({ controller });

		const result = await tool.execute("call-1", {
			action: "halt",
			reason: "Pointer stray detected",
		});

		expect(controller.isHalted()).toBe(true);
		expect(controller.getReason()).toBe("Pointer stray detected");
		expect(result.content[0].type).toBe("text");
		expect((result.content[0] as any).text).toContain("Desktop emergency stop triggered");
		expect(result.details?.action).toBe("halt");
		expect(result.details?.state.halted).toBe(true);
	});

	test("executes reset lifecycle", async () => {
		const controller = new EmergencyStopController();
		controller.halt("Prior halt");
		const tool = new DesktopEmergencyStopTool({ controller });

		const result = await tool.execute("call-2", {
			action: "reset",
		});

		expect(controller.isHalted()).toBe(false);
		expect(result.content[0].type).toBe("text");
		expect((result.content[0] as any).text).toContain("Desktop emergency stop reset successfully");
		expect(result.details?.action).toBe("reset");
		expect(result.details?.state.halted).toBe(false);
	});

	test("executes stream_hints lifecycle", async () => {
		const framePort = new FramePort();
		const tool = new DesktopEmergencyStopTool({ framePort });

		const result = await tool.execute("call-3", {
			action: "stream_hints",
			fps: 20,
			width: 1024,
			height: 768,
			format: "png",
		});

		const hints = framePort.getStreamHints();
		expect(hints.fps).toBe(20);
		expect(hints.width).toBe(1024);
		expect(hints.height).toBe(768);
		expect(hints.format).toBe("png");
		expect(result.content[0].type).toBe("text");
		expect((result.content[0] as any).text).toContain("Frame stream hints updated");
		expect(result.details?.action).toBe("stream_hints");
	});

	test("executes status lifecycle", async () => {
		const controller = new EmergencyStopController();
		const framePort = new FramePort();
		const tool = new DesktopEmergencyStopTool({ controller, framePort });

		const result = await tool.execute("call-4", {
			action: "status",
		});

		expect(result.content[0].type).toBe("text");
		expect((result.content[0] as any).text).toContain("Emergency Stop Status: RUNNING");
		expect((result.content[0] as any).text).toContain("Frame Stream: IDLE");
		expect(result.details?.action).toBe("status");
		expect(result.details?.emergencyStop.halted).toBe(false);
		expect(result.details?.framePort.active).toBe(false);
	});
});
