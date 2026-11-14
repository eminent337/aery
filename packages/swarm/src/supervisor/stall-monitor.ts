import type { SwarmMember } from "../types";

export interface StallCheckResult {
	stalled: boolean;
	alertMessage?: string;
}

export class StallMonitor {
	public checkStall(members: SwarmMember[], latestSeq: number, lastMonitoredSeq: number): StallCheckResult {
		const nonCoordinator = members.filter((m) => m.name.toLowerCase() !== "coordinator");
		if (nonCoordinator.length === 0) {
			return { stalled: false };
		}

		const allIdle = nonCoordinator.every((m) => m.state === "waiting" || m.state === "stopped");
		const noNewActivity = latestSeq === lastMonitoredSeq;

		if (allIdle && noNewActivity) {
			return {
				stalled: true,
				alertMessage: `@coordinator [stall] Swarm is idle. All workers are parked at seq #${latestSeq}. Review board or assign next steps.`,
			};
		}

		return { stalled: false };
	}
}
