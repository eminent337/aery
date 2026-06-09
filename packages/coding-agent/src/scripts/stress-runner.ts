import { EventEmitter } from "node:events";

/**
 * Replays a recorded sequence of TUI events rapidly to stress-test terminal redraw performance.
 */
export class StressRunner extends EventEmitter {
	private events: any[];
	private delayMs: number;

	constructor(events: any[], delayMs: number = 0) {
		super();
		this.events = events;
		this.delayMs = delayMs;
	}

	async run(): Promise<void> {
		for (const event of this.events) {
			this.emit("tui-event", event);
			if (this.delayMs > 0) {
				await new Promise(resolve => setTimeout(resolve, this.delayMs));
			} else {
				// Yield to event loop to allow UI to process/redraw
				await new Promise(resolve => setImmediate(resolve));
			}
		}
		this.emit("done");
	}
}

export async function replayEvents(events: any[], delayMs: number = 0): Promise<void> {
	const runner = new StressRunner(events, delayMs);

	runner.on("tui-event", event => {
		// Mock consuming event and triggering redraw
	});

	await runner.run();
}
