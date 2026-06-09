// ─── Swarm-Aware Plugin Types ─────────────────────────────────────────────────
//
// Aery supports multi-agent swarms where multiple specialised agents collaborate
// within a single session. Extensions that opt into swarm participation declare
// their role and communicate via the SwarmAwareExtensionAPI.

/**
 * Declares what an extension/agent can do when participating in a swarm.
 * Register this via `SwarmAwareExtensionAPI.declareSwarmRole()`.
 */
export interface SwarmCapability {
	/** Unique role name for this agent in the swarm (e.g. "code-reviewer") */
	role: string;
	/** Human-readable list of capabilities this agent offers */
	capabilities: string[];
	/** If true, this agent receives broadcast messages from other swarm members */
	receivesBroadcast?: boolean;
}

/** A message passed between agents in the swarm */
export interface SwarmMessage {
	/** Role name of the sending agent */
	from: string;
	/** Role name of the intended recipient, or "*" for broadcast */
	to: string | "*";
	/** Arbitrary serialisable payload */
	payload: unknown;
	/** Unix epoch millisecond when this message was sent */
	timestamp: number;
	/** Session this message belongs to */
	sessionId: string;
}

/**
 * Swarm-specific extension API surface.
 *
 * Extend `ExtensionAPI` with this interface to participate in multi-agent
 * swarm coordination:
 *
 * @example
 * export default async function mySwarmExtension(
 *   api: ExtensionAPI & SwarmAwareExtensionAPI,
 * ) {
 *   api.declareSwarmRole({ role: "tester", capabilities: ["run_tests"] });
 *   const inbox = await api.swarmRead("tester");
 *   for (const msg of inbox) { ... }
 * }
 */
export interface SwarmAwareExtensionAPI {
	/** Declare this extension's role and capabilities in the active swarm */
	declareSwarmRole(capability: SwarmCapability): void;
	/** Send a direct message to another swarm agent by role name */
	swarmSend(to: string, payload: unknown): Promise<void>;
	/** Read all messages waiting in this agent's swarm inbox */
	swarmRead(role: string): Promise<SwarmMessage[]>;
	/** Broadcast a message to every agent that has receivesBroadcast=true */
	swarmBroadcast(payload: unknown): Promise<void>;
}
