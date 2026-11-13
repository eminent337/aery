/**
 * Desktop Computer Use Emergency Stop and Frame Port.
 *
 * Provides emergency halt capabilities, callback notification hooks,
 * state management, and frame streaming port configuration for
 * desktop computer use workflows.
 */

import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@aryee337/aery-core";
import * as z from "zod/v4";

export type HaltCallback = (reason: string, timestamp: number) => void | Promise<void>;
export type ResetCallback = () => void | Promise<void>;

export interface EmergencyStopState {
	halted: boolean;
	reason: string | null;
	haltedAt: number | null;
}

/**
 * Controller for managing emergency halt state and invoking safety callbacks.
 */
export class EmergencyStopController {
	private halted = false;
	private reason: string | null = null;
	private haltedAt: number | null = null;
	private readonly haltListeners = new Set<HaltCallback>();
	private readonly resetListeners = new Set<ResetCallback>();

	constructor(initialHalted = false) {
		this.halted = initialHalted;
		if (initialHalted) {
			this.haltedAt = Date.now();
			this.reason = "Initial halt state";
		}
	}

	isHalted(): boolean {
		return this.halted;
	}

	getReason(): string | null {
		return this.reason;
	}

	getHaltedAt(): number | null {
		return this.haltedAt;
	}

	getState(): EmergencyStopState {
		return {
			halted: this.halted,
			reason: this.reason,
			haltedAt: this.haltedAt,
		};
	}

	halt(reason?: string): void {
		const haltReason = reason ?? "Emergency stop triggered";
		this.halted = true;
		this.reason = haltReason;
		this.haltedAt = Date.now();

		for (const listener of [...this.haltListeners]) {
			try {
				const res = listener(haltReason, this.haltedAt);
				if (res && typeof (res as Promise<void>).catch === "function") {
					(res as Promise<void>).catch(() => {});
				}
			} catch {
				// Suppress listener error so other callbacks still execute
			}
		}
	}

	reset(): void {
		this.halted = false;
		this.reason = null;
		this.haltedAt = null;

		for (const listener of [...this.resetListeners]) {
			try {
				const res = listener();
				if (res && typeof (res as Promise<void>).catch === "function") {
					(res as Promise<void>).catch(() => {});
				}
			} catch {
				// Suppress listener error so other callbacks still execute
			}
		}
	}

	onHalt(callback: HaltCallback): () => void {
		this.haltListeners.add(callback);
		return () => {
			this.haltListeners.delete(callback);
		};
	}

	addHaltListener(callback: HaltCallback): () => void {
		return this.onHalt(callback);
	}

	removeHaltListener(callback: HaltCallback): void {
		this.haltListeners.delete(callback);
	}

	onReset(callback: ResetCallback): () => void {
		this.resetListeners.add(callback);
		return () => {
			this.resetListeners.delete(callback);
		};
	}

	addResetListener(callback: ResetCallback): () => void {
		return this.onReset(callback);
	}

	removeResetListener(callback: ResetCallback): void {
		this.resetListeners.delete(callback);
	}

	assertNotHalted(): void {
		if (this.halted) {
			throw new Error(`Desktop execution halted: ${this.reason ?? "Emergency stop active"}`);
		}
	}
}

export interface FrameStreamHints {
	fps?: number;
	width?: number;
	height?: number;
	format?: string;
}

export interface DesktopFrame {
	data: Buffer | Uint8Array | string;
	timestamp: number;
	width?: number;
	height?: number;
	format?: string;
}

export type FrameListener = (frame: DesktopFrame) => void;

export interface FramePortStatus {
	active: boolean;
	listenerCount: number;
	hints: FrameStreamHints;
	lastFrameTimestamp: number | null;
	totalFramesEmitted: number;
}

/**
 * Port managing frame stream subscriptions, stream hints, and frame emission.
 */
export class FramePort {
	private hints: FrameStreamHints;
	private readonly listeners = new Set<FrameListener>();
	private lastFrameTimestamp: number | null = null;
	private totalFramesEmitted = 0;

	constructor(initialHints?: FrameStreamHints) {
		this.hints = {
			fps: initialHints?.fps,
			width: initialHints?.width,
			height: initialHints?.height,
			format: initialHints?.format,
		};
	}

	setStreamHints(hints: Partial<FrameStreamHints>): FrameStreamHints {
		this.hints = {
			...this.hints,
			...hints,
		};
		return { ...this.hints };
	}

	getStreamHints(): FrameStreamHints {
		return { ...this.hints };
	}

	onFrame(listener: FrameListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	addListener(listener: FrameListener): () => void {
		return this.onFrame(listener);
	}

	removeListener(listener: FrameListener): void {
		this.listeners.delete(listener);
	}

	getListenerCount(): number {
		return this.listeners.size;
	}

	emitFrame(frame: DesktopFrame): void {
		this.lastFrameTimestamp = frame.timestamp ?? Date.now();
		this.totalFramesEmitted += 1;
		for (const listener of [...this.listeners]) {
			try {
				const res: any = listener(frame);
				if (res && typeof res.catch === "function") {
					res.catch(() => {});
				}
			} catch {
				// Suppress listener error so other callbacks still receive the frame
			}
		}
	}

	getStatus(): FramePortStatus {
		return {
			active: this.listeners.size > 0,
			listenerCount: this.listeners.size,
			hints: { ...this.hints },
			lastFrameTimestamp: this.lastFrameTimestamp,
			totalFramesEmitted: this.totalFramesEmitted,
		};
	}

	clearListeners(): void {
		this.listeners.clear();
	}
}

export const desktopEmergencyStopSchema = z.object({
	action: z
		.enum(["halt", "reset", "status", "stream_hints"])
		.describe("Action to perform: halt, reset, status, or stream_hints."),
	reason: z
		.string()
		.optional()
		.describe("Reason for emergency halt."),
	fps: z
		.number()
		.positive()
		.optional()
		.describe("Frames per second stream rate hint."),
	width: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Frame width hint in pixels."),
	height: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Frame height hint in pixels."),
	format: z
		.string()
		.optional()
		.describe("Frame image format hint like jpeg, png, or raw."),
});

export type DesktopEmergencyStopParams = z.infer<typeof desktopEmergencyStopSchema>;

export interface DesktopEmergencyStopToolOptions {
	controller?: EmergencyStopController;
	framePort?: FramePort;
}

let defaultEmergencyStopController: EmergencyStopController | null = null;
let defaultFramePort: FramePort | null = null;

export function getDefaultEmergencyStopController(): EmergencyStopController {
	if (!defaultEmergencyStopController) {
		defaultEmergencyStopController = new EmergencyStopController();
	}
	return defaultEmergencyStopController;
}

export function getDefaultFramePort(): FramePort {
	if (!defaultFramePort) {
		defaultFramePort = new FramePort();
	}
	return defaultFramePort;
}

/**
 * Desktop emergency stop tool conforming to AgentTool.
 */
export class DesktopEmergencyStopTool implements AgentTool<typeof desktopEmergencyStopSchema> {
	readonly name = "desktop_emergency_stop";
	readonly approval = "exec" as const;
	readonly label = "Desktop Emergency Stop";
	readonly summary = "Emergency stop controller and frame streaming port for desktop computer use";
	readonly description =
		"Manage emergency halt states, trigger emergency callbacks, reset desktop control state, and configure frame stream hints.";
	readonly parameters = desktopEmergencyStopSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;

	readonly controller: EmergencyStopController;
	readonly framePort: FramePort;

	constructor(options?: DesktopEmergencyStopToolOptions) {
		this.controller = options?.controller ?? getDefaultEmergencyStopController();
		this.framePort = options?.framePort ?? getDefaultFramePort();
	}

	static createIf(_session?: unknown): DesktopEmergencyStopTool | null {
		return new DesktopEmergencyStopTool();
	}

	async execute(
		_toolCallId: string,
		params: DesktopEmergencyStopParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		switch (params.action) {
			case "halt": {
				const reason = params.reason ?? "Emergency halt requested by user or agent";
				this.controller.halt(reason);
				const state = this.controller.getState();
				return {
					content: [
						{
							type: "text",
							text: `Desktop emergency stop triggered: ${reason}. All computer use actions halted.`,
						},
					],
					details: {
						action: "halt",
						state,
					},
				};
			}

			case "reset": {
				this.controller.reset();
				const state = this.controller.getState();
				return {
					content: [
						{
							type: "text",
							text: "Desktop emergency stop reset successfully. Computer use operations can resume.",
						},
					],
					details: {
						action: "reset",
						state,
					},
				};
			}

			case "stream_hints": {
				const hints = this.framePort.setStreamHints({
					fps: params.fps,
					width: params.width,
					height: params.height,
					format: params.format,
				});
				const status = this.framePort.getStatus();
				return {
					content: [
						{
							type: "text",
							text: `Frame stream hints updated: fps=${hints.fps ?? "default"}, width=${hints.width ?? "auto"}, height=${hints.height ?? "auto"}, format=${hints.format ?? "default"}.`,
						},
					],
					details: {
						action: "stream_hints",
						hints,
						status,
					},
				};
			}

			case "status": {
				const stopState = this.controller.getState();
				const frameStatus = this.framePort.getStatus();
				const statusLines = [
					`Emergency Stop Status: ${stopState.halted ? "HALTED" : "RUNNING"}`,
					stopState.halted ? `Reason: ${stopState.reason}` : null,
					stopState.halted ? `Halted at: ${new Date(stopState.haltedAt ?? 0).toISOString()}` : null,
					`Frame Stream: ${frameStatus.active ? "ACTIVE" : "IDLE"} (${frameStatus.listenerCount} listeners, ${frameStatus.totalFramesEmitted} frames emitted)`,
					`Stream hints: fps=${frameStatus.hints.fps ?? "default"}, width=${frameStatus.hints.width ?? "auto"}, height=${frameStatus.hints.height ?? "auto"}`,
				];
				const statusText = statusLines.filter(Boolean).join("\n");

				return {
					content: [
						{
							type: "text",
							text: statusText,
						},
					],
					details: {
						action: "status",
						emergencyStop: stopState,
						framePort: frameStatus,
					},
				};
			}
		}
	}
}

export function _resetDesktopEmergencyStopDefaults(): void {
	defaultEmergencyStopController?.reset();
	defaultFramePort?.clearListeners();
}
