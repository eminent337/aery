import { EventEmitter } from "node:events";
import type { BoardMessage } from "../types";

interface Waiter {
	memberName: string;
	resolve: (msgs: BoardMessage[]) => void;
	reject: (err: Error) => void;
	timeoutId?: ReturnType<typeof setTimeout>;
}

export class WakeEngine {
	private readonly emitter = new EventEmitter();
	private waiters = new Map<string, Waiter[]>();

	public waitForWake(memberName: string, timeoutMs?: number): Promise<BoardMessage[]> {
		return new Promise<BoardMessage[]>((resolve, reject) => {
			const waiter: Waiter = {
				memberName,
				resolve,
				reject,
			};

			if (timeoutMs && timeoutMs > 0) {
				waiter.timeoutId = setTimeout(() => {
					this.removeWaiter(memberName, waiter);
					resolve([]);
				}, timeoutMs);
			}

			const list = this.waiters.get(memberName) ?? [];
			list.push(waiter);
			this.waiters.set(memberName, list);
		});
	}

	public notifyMessage(msg: BoardMessage): void {
		this.emitter.emit("message", msg);

		const mentions = msg.mentions ?? [];
		const isBroadcast = mentions.includes("all") || mentions.includes("swarm");

		if (isBroadcast) {
			for (const waitersList of this.waiters.values()) {
				for (const waiter of waitersList) {
					if (waiter.timeoutId) clearTimeout(waiter.timeoutId);
					waiter.resolve([msg]);
				}
			}
			this.waiters.clear();
			return;
		}

		for (const target of mentions) {
			const waitersList = this.waiters.get(target);
			if (waitersList && waitersList.length > 0) {
				for (const waiter of waitersList) {
					if (waiter.timeoutId) clearTimeout(waiter.timeoutId);
					waiter.resolve([msg]);
				}
				this.waiters.delete(target);
			}
		}
	}

	private removeWaiter(memberName: string, target: Waiter): void {
		const list = this.waiters.get(memberName);
		if (!list) return;
		const filtered = list.filter(w => w !== target);
		if (filtered.length === 0) {
			this.waiters.delete(memberName);
		} else {
			this.waiters.set(memberName, filtered);
		}
	}

	public onMessage(listener: (msg: BoardMessage) => void): () => void {
		this.emitter.on("message", listener);
		return () => this.emitter.off("message", listener);
	}
}
