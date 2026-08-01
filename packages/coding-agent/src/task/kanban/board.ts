export type KanbanStatus = "todo" | "in_progress" | "done";

export interface KanbanCard {
	id: string;
	title: string;
	status: KanbanStatus;
	createdAt: string;
}

const COLUMNS: KanbanStatus[] = ["todo", "in_progress", "done"];
const COLUMN_LABELS: Record<KanbanStatus, string> = {
	todo: "📋 To Do",
	in_progress: "🔄 In Progress",
	done: "✅ Done",
};

let nextId = 1;
const cards: KanbanCard[] = [];

export function addCard(title: string, customId?: string): KanbanCard {
	const card: KanbanCard = {
		id: customId || String(nextId++),
		title,
		status: "todo",
		createdAt: new Date().toISOString(),
	};
	cards.push(card);
	return card;
}

export function moveCard(id: string, status: KanbanStatus): KanbanCard | null {
	const card = cards.find(c => c.id === id);
	if (!card) return null;
	card.status = status;
	return card;
}

export function removeCard(id: string): boolean {
	const idx = cards.findIndex(c => c.id === id);
	if (idx === -1) return false;
	cards.splice(idx, 1);
	return true;
}

export function getCards(): KanbanCard[] {
	return [...cards];
}

export function renderBoard(): string {
	const lines: string[] = ["", "─── Kanban Board ───────────────────────────────────────"];
	for (const status of COLUMNS) {
		const col = cards.filter(c => c.status === status);
		lines.push(`\n${COLUMN_LABELS[status]} (${col.length})`);
		if (col.length === 0) {
			lines.push("  (empty)");
		} else {
			for (const card of col) {
				lines.push(`  [${card.id}] ${card.title}`);
			}
		}
	}
	lines.push("\n────────────────────────────────────────────────────────");
	return lines.join("\n");
}
