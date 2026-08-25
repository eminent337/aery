/**
 * State Manager for Aery Studio (/studio) visual war-room overlay.
 * Aggregates live agent lifecycle, IrcBus communication stream, and consensus status.
 */

import { AgentRegistry } from "../../../registry/agent-registry.js";
import { IrcBus } from "../../../irc/bus.js";
import type { StudioAgentNode, StudioChatMessage, StudioInspectorDiff, StudioState, StudioTab } from "./types.js";

export class StudioStateManager {
	#chatHistory: StudioChatMessage[] = [];
	#diffs: StudioInspectorDiff[] = [];
	#listeners: Set<() => void> = new Set();
	#activeTab: StudioTab = "swarm";
	#activeAgentId?: string;

	constructor() {
		// Periodically poll agents / live state
		setInterval(() => {
			this.#notify();
		}, 1000);
	}

	recordIrcMessage(msg: { id: string; from: string; to: string; body: string; ts: number; replyTo?: string }): void {
		this.#chatHistory.push({
			id: msg.id,
			from: msg.from,
			to: msg.to,
			body: msg.body,
			timestamp: msg.ts,
			replyTo: msg.replyTo,
			isBroadcast: msg.to === "all",
		});
		this.#notify();
	}

	subscribe(fn: () => void): () => void {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}

	#notify(): void {
		for (const fn of this.#listeners) {
			try {
				fn();
			} catch (_e) {}
		}
	}

	setTab(tab: StudioTab): void {
		this.#activeTab = tab;
		this.#notify();
	}

	selectAgent(agentId: string): void {
		this.#activeAgentId = agentId;
		this.#notify();
	}

	recordDiff(diff: StudioInspectorDiff): void {
		this.#diffs.unshift(diff);
		if (this.#diffs.length > 50) this.#diffs.pop();
		this.#notify();
	}

	getState(): StudioState {
		const registry = AgentRegistry.global();
		const registeredPeers = registry.list();

		const agents: StudioAgentNode[] = [
			{
				id: "Main",
				displayName: "Main Orchestrator",
				kind: "main",
				status: "running",
				tokens: 0,
				durationMs: 0,
				unreadCount: 0,
				lastActiveAt: Date.now(),
			},
			...registeredPeers.map(peer => ({
				id: peer.id,
				displayName: peer.displayName || peer.id,
				kind: peer.kind || "subagent",
				status: (peer.status as any) || "idle",
				parentId: peer.parentId,
				tokens: 0,
				durationMs: 0,
				unreadCount: 0,
				lastActiveAt: Date.now(),
			})),
		];

		const liveCount = agents.filter(a => a.status === "running" || a.status === "idle").length;

		return {
			activeTab: this.#activeTab,
			activeAgentId: this.#activeAgentId || agents[0]?.id,
			agents,
			chatMessages: this.#chatHistory.slice(-100),
			diffs: this.#diffs,
			consensusAgreedCount: liveCount,
			consensusTotalCount: agents.length,
			isLiveSwarmActive: registeredPeers.length > 0,
		};
	}
}
