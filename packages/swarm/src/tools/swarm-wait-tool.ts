import type { WakeEngine } from "../wake/wake-engine";

export interface SwarmWaitParams {
	timeoutMs?: number;
}

export function createSwarmWaitTool(deps: {
	wakeEngine: WakeEngine;
	callerName: string;
}) {
	return {
		name: "swarm_wait",
		description: "Park in zero-token idle until an @mention or broadcast arrives.",
		execute: async (params?: SwarmWaitParams) => {
			const messages = await deps.wakeEngine.waitForWake(
				deps.callerName,
				params?.timeoutMs ?? 300000
			);
			return {
				woken: messages.length > 0,
				messages,
			};
		},
	};
}
