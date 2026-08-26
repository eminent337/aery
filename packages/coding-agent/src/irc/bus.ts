/**
 * IrcBus - Process-global mailbox bus for agent-to-agent messaging.
 *
 * Replaces the old auto-reply model: a `send` never blocks on the recipient
 * generating anything. Delivery resolves the recipient via the global
 * AgentRegistry — parked agents are revived through the
 * AgentLifecycleManager, idle agents are woken with a real turn, and busy
 * agents receive the message as a non-interrupting aside at the next step
 * boundary (see AgentSession.deliverIrcMessage). Replies are real turns by
 * the recipient, observed via `wait`.
 */

import { logger, Snowflake } from "@aryee337/aery-utils";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import type { CustomMessage } from "../session/messages";

export interface IrcMessage {
	id: string;
	/** Sender agent id. */
	from: string;
	/** Recipient agent id (resolved; "all" is expanded by the tool, not stored). */
	to: string;
	body: string;
	ts: number;
	/** Message id being answered. */
	replyTo?: string;
}

export interface IrcDeliveryReceipt {
	to: string;
	outcome: "injected" | "woken" | "revived" | "failed";
	error?: string;
}

interface IrcWaiter {
	from?: string;
	resolve: (msg: IrcMessage) => void;
	cancel: () => void;
}

export class IrcBus {
	static #global: IrcBus | undefined;

	static global(): IrcBus {
		if (!IrcBus.#global) {
			IrcBus.#global = new IrcBus();
		}
		return IrcBus.#global;
	}

	/** Reset the global bus. Test-only. */
	static resetGlobalForTests(): void {
		IrcBus.#global = undefined;
	}

	readonly #registry: AgentRegistry;
	readonly #lifecycle: () => AgentLifecycleManager;
	readonly #mailboxes = new Map<string, IrcMessage[]>();
	readonly #waiters = new Map<string, IrcWaiter[]>();
	readonly #messageListeners = new Set<(msg: IrcMessage) => void>();

	constructor(registry: AgentRegistry = AgentRegistry.global(), lifecycle?: AgentLifecycleManager) {
		this.#registry = registry;
		// Lazy: the lifecycle global self-constructs against the global registry,
		// so only touch it when a parked recipient actually needs reviving.
		this.#lifecycle = () => lifecycle ?? AgentLifecycleManager.global();
	}

	/** Subscribe to all live IRC messages passing through the bus. */
	onMessage(listener: (msg: IrcMessage) => void): () => void {
		this.#messageListeners.add(listener);
		return () => this.#messageListeners.delete(listener);
	}

	/** Return number of unread messages currently buffered in an agent's mailbox. */
	unreadCount(agentId: string): number {
		const canonicalId = this.#registry.get(agentId)?.id ?? agentId;
		return this.#mailboxes.get(canonicalId)?.length ?? 0;
	}

	/** Read or drain messages from an agent's mailbox. */
	inbox(agentId: string, options?: { peek?: boolean }): IrcMessage[] {
		const canonicalId = this.#registry.get(agentId)?.id ?? agentId;
		const mailbox = this.#mailboxes.get(canonicalId) ?? [];
		if (options?.peek) {
			return [...mailbox];
		}
		this.#mailboxes.delete(canonicalId);
		return mailbox;
	}

	/**
	 * Fire-and-forget delivery. Never blocks on the recipient generating
	 * anything: the receipt reports how the message reached the recipient
	 * (waiter/aside = "injected", idle wake = "woken", park revival =
	 * "revived"), not what they did with it.
	 */
	async send(msg: Omit<IrcMessage, "id" | "ts">): Promise<IrcDeliveryReceipt> {
		const message: IrcMessage = { ...msg, id: Snowflake.next(), ts: Date.now() };
		
		// Notify bus listeners (e.g. Aery Studio)
		for (const listener of this.#messageListeners) {
			try {
				listener(message);
			} catch (_e) {}
		}

		const ref = this.#registry.get(message.to);
		if (!ref || ref.status === "aborted") {
			return { to: message.to, outcome: "failed", error: `Unknown or terminated agent "${message.to}".` };
		}
		// Canonicalize recipient id to actual registered id (e.g. "Bar" -> "Bar-2")
		const canonicalTo = ref.id;
		message.to = canonicalTo;

		let revived = false;
		if (ref.status === "parked") {
			try {
				await this.#lifecycle().ensureLive(canonicalTo);
				revived = true;
			} catch (error) {
				return {
					to: canonicalTo,
					outcome: "failed",
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}

		// A pending `wait` from the recipient consumes the message directly —
		// it is returned from their irc tool call and never hits the inbox or
		// the session injection path.
		const waiter = this.#takeMatchingWaiter(canonicalTo, message.from);
		if (waiter) {
			waiter.resolve(message);
			this.#relayToMainUi(message);
			return { to: canonicalTo, outcome: revived ? "revived" : "injected" };
		}

		const session = ref.session;
		if (!session) {
			return { to: canonicalTo, outcome: "failed", error: `Agent "${canonicalTo}" has no live session.` };
		}

		this.#enqueue(message);
		try {
			const delivery = await session.deliverIrcMessage(message);
			this.#relayToMainUi(message);
			return { to: canonicalTo, outcome: revived ? "revived" : delivery };
		} catch (error) {
			return {
				to: canonicalTo,
				outcome: "failed",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * Block until a message for `agentId` (optionally from `filter.from`)
	 * arrives; consume + return it. Null on timeout (`timeoutMs <= 0` waits
	 * forever). Rejects when `signal` aborts.
	 */
	async wait(
		agentId: string,
		filter: { from?: string },
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<IrcMessage | null> {
		if (signal?.aborted) {
			throw signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted");
		}

		const canonicalId = this.#registry.get(agentId)?.id ?? agentId;

		// Already-pending mail satisfies the wait without parking a waiter.
		const pending = this.#takeFromMailbox(canonicalId, filter.from);
		if (pending) return pending;

		const { promise, resolve, reject } = Promise.withResolvers<IrcMessage | null>();
		let timer: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;

		const waiter: IrcWaiter = {
			from: filter.from,
			resolve: msg => {
				cleanup();
				resolve(msg);
			},
			cancel: () => {
				cleanup();
			},
		};

		const cleanup = () => {
			if (timer) clearTimeout(timer);
			if (onAbort && signal) signal.removeEventListener("abort", onAbort);
			this.#removeWaiter(canonicalId, waiter);
		};

		if (signal) {
			onAbort = () => {
				cleanup();
				reject(signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
		}

		if (timeoutMs > 0) {
			timer = setTimeout(() => {
				cleanup();
				resolve(null);
			}, timeoutMs);
		}

		const list = this.#waiters.get(canonicalId) ?? [];
		list.push(waiter);
		this.#waiters.set(canonicalId, list);

		return promise;
	}

	#enqueue(message: IrcMessage): void {
		const list = this.#mailboxes.get(message.to) ?? [];
		list.push(message);
		if (list.length > 100) list.shift();
		this.#mailboxes.set(message.to, list);
	}

	#matchesSenderFilter(actualSender: string, filterSender?: string): boolean {
		if (!filterSender) return true;
		if (actualSender === filterSender) return true;
		const filterLower = filterSender.toLowerCase();
		const actualLower = actualSender.toLowerCase();
		if (actualLower === filterLower) return true;
		// e.g. filter "Foo" matches actual sender "Foo-2"
		if (actualLower.startsWith(`${filterLower}-`)) return true;
		// Check against registered peer canonical id or displayName
		const ref = this.#registry.get(filterSender);
		if (ref && (ref.id === actualSender || ref.id.toLowerCase() === actualLower)) return true;
		return false;
	}

	#takeMatchingWaiter(to: string, from: string): IrcWaiter | undefined {
		const waiters = this.#waiters.get(to);
		if (!waiters || waiters.length === 0) return undefined;
		const index = waiters.findIndex(w => this.#matchesSenderFilter(from, w.from));
		if (index === -1) return undefined;
		const [waiter] = waiters.splice(index, 1);
		if (waiters.length === 0) this.#waiters.delete(to);
		return waiter;
	}

	#removeWaiter(agentId: string, waiter: IrcWaiter): void {
		const waiters = this.#waiters.get(agentId);
		if (!waiters) return;
		const index = waiters.indexOf(waiter);
		if (index !== -1) waiters.splice(index, 1);
		if (waiters.length === 0) this.#waiters.delete(agentId);
	}

	#takeFromMailbox(agentId: string, from?: string): IrcMessage | undefined {
		const mailbox = this.#mailboxes.get(agentId);
		if (!mailbox) return undefined;
		const index = from ? mailbox.findIndex(msg => this.#matchesSenderFilter(msg.from, from)) : 0;
		if (index === -1 || mailbox.length === 0) return undefined;
		const [message] = mailbox.splice(index, 1);
		if (mailbox.length === 0) this.#mailboxes.delete(agentId);
		return message;
	}

	/**
	 * Surface agent↔agent traffic as a display-only card on the main session
	 * UI. Skipped when the main agent is the recipient — its own
	 * `deliverIrcMessage` (or `wait` tool result) already shows the message.
	 */
	#relayToMainUi(message: IrcMessage): void {
		if (message.to === MAIN_AGENT_ID) return;
		const mainSession = this.#registry.get(MAIN_AGENT_ID)?.session;
		if (!mainSession) return;
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:relay",
			content: `[IRC \`${message.from}\` → \`${message.to}\`]\n\n${message.body}`,
			display: true,
			details: { from: message.from, to: message.to, body: message.body },
			attribution: "agent",
			timestamp: message.ts,
		};
		try {
			mainSession.emitIrcRelayObservation(record);
		} catch (error) {
			// Display-only forwarding must never affect delivery semantics.
			logger.debug("IrcBus: main UI relay failed", { to: message.to, error: String(error) });
		}
	}
}
