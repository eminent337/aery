import { BoardStore } from "../store/board-store";
import { MemberRegistry } from "../store/member-registry";
import { WakeEngine } from "../wake/wake-engine";
import { WorktreeManager } from "../workspace/worktree-manager";
import { QuotaHandler } from "./quota-handler";
import { StallMonitor } from "./stall-monitor";
import { createSwarmTool } from "../tools/swarm-tool";
import { createPostMessageTool } from "../tools/post-message-tool";
import { createReadBoardTool } from "../tools/read-board-tool";
import { createSwarmWaitTool } from "../tools/swarm-wait-tool";
import type { SwarmConfig, SwarmMember } from "../types";

export class SwarmSupervisor {
	public readonly boardStore: BoardStore;
	public readonly registry: MemberRegistry;
	public readonly wakeEngine: WakeEngine;
	public readonly worktreeManager: WorktreeManager;
	public readonly quotaHandler = new QuotaHandler();
	public readonly stallMonitor = new StallMonitor();
	private monitorIntervalId?: ReturnType<typeof setInterval>;
	private lastMonitoredSeq = 0;

	constructor(config: SwarmConfig) {
		this.boardStore = new BoardStore(config.storageDir);
		this.registry = new MemberRegistry(config.storageDir);
		this.wakeEngine = new WakeEngine();
		this.worktreeManager = new WorktreeManager(process.cwd(), config.swarmId);

		this.initCoordinator(config.coordinatorModel);
		this.startStallWatchdog();
	}

	private initCoordinator(model?: string): void {
		if (!this.registry.getMember("coordinator")) {
			this.registry.addMember({
				name: "coordinator",
				brief: "Orchestrate swarm tasks and review results",
				model,
				state: "working",
				workspace: "inherit",
				lastSeqRead: 0,
				createdAt: new Date().toISOString(),
			});
		}
	}

	private startStallWatchdog(): void {
		this.monitorIntervalId = setInterval(() => {
			const members = this.registry.listMembers();
			const latest = this.boardStore.getLatestSeq();
			const check = this.stallMonitor.checkStall(members, latest, this.lastMonitoredSeq);
			if (check.stalled && check.alertMessage) {
				const msg = this.boardStore.appendMessage({
					from: "monitor",
					channel: "alerts",
					content: check.alertMessage,
				});
				this.wakeEngine.notifyMessage(msg);
			}
			this.lastMonitoredSeq = latest;
		}, 180000);
	}

	public getMembers(): SwarmMember[] {
		return this.registry.listMembers();
	}

	public getToolsFor(callerName: string) {
		return [
			createSwarmTool({ registry: this.registry, worktreeManager: this.worktreeManager }),
			createPostMessageTool({ boardStore: this.boardStore, wakeEngine: this.wakeEngine, callerName }),
			createReadBoardTool({ boardStore: this.boardStore, registry: this.registry, callerName }),
			createSwarmWaitTool({ wakeEngine: this.wakeEngine, callerName }),
		];
	}

	public destroy(): void {
		if (this.monitorIntervalId) {
			clearInterval(this.monitorIntervalId);
		}
		this.worktreeManager.cleanupAll();
	}
}
