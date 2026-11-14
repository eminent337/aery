import type { BoardStore } from "../store/board-store";
import type { MemberRegistry } from "../store/member-registry";

export class SwarmBoardPanel {
	private store: BoardStore;
	private registry: MemberRegistry;
	private selectedIndex = 0;

	constructor(deps: { store: BoardStore; registry: MemberRegistry }) {
		this.store = deps.store;
		this.registry = deps.registry;
	}

	public render(width: number, height = 24): string[] {
		const members = this.registry.listMembers();
		const messages = this.store.readMessages({ limit: 50 });
		const lines: string[] = [];

		lines.push(`+-- ROSTER (${members.length}) --+-- POSTS FEED (${messages.length}) --+-- MESSAGE VIEWER --+`);

		const maxRows = Math.max(1, height - 2);
		for (let i = 0; i < maxRows; i++) {
			const member = members[i];
			const memberCol = member
				? `[${member.state.toUpperCase().slice(0, 4)}] ${member.name.slice(0, 10).padEnd(10)}`
				: " ".repeat(17);

			const msg = messages[i];
			const feedCol = msg
				? `#${String(msg.seq).padStart(2)} @${msg.from.slice(0, 8).padEnd(8)}: ${msg.content.slice(0, 16).padEnd(16)}`
				: " ".repeat(30);

			const selectedMsg = messages[this.selectedIndex];
			const detailCol =
				i === 0 && selectedMsg
					? `From: @${selectedMsg.from} (seq #${selectedMsg.seq})`.slice(0, Math.max(10, width - 56))
					: i === 1 && selectedMsg
						? selectedMsg.content.slice(0, Math.max(10, width - 56))
						: "";

			lines.push(
				`| ${memberCol.padEnd(17)} | ${feedCol.padEnd(30)} | ${detailCol.padEnd(Math.max(10, width - 56))} |`,
			);
		}

		lines.push(`+${"-".repeat(Math.max(10, width - 2))}+`);
		return lines;
	}

	public selectNext(): void {
		const total = this.store.readMessages().length;
		const limit = Math.min(total, 50);
		if (this.selectedIndex < limit - 1) {
			this.selectedIndex++;
		}
	}

	public selectPrev(): void {
		if (this.selectedIndex > 0) {
			this.selectedIndex--;
		}
	}
}
