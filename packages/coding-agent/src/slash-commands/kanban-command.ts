import { addCard, getCards, type KanbanStatus, moveCard, removeCard, renderBoard } from "../task/kanban/board";
import { commandConsumed } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

export const kanbanCommand: SlashCommandSpec = {
	name: "kanban",
	description: "Manage your in-session Kanban task board",
	allowArgs: true,
	subcommands: [
		{ name: "add", description: "Add a card to To Do", usage: "<title>" },
		{ name: "move", description: "Move a card to a new column", usage: "<id> <todo|in_progress|done>" },
		{ name: "rm", description: "Remove a card by ID", usage: "<id>" },
		{ name: "list", description: "Show the board" },
	],
	handle: async (command, runtime) => {
		const text = command.args.trim();
		const [verb, ...rest] = text.split(/\s+/);

		if (!verb || verb === "list") {
			await runtime.output(renderBoard());
			return commandConsumed();
		}

		if (verb === "add") {
			const title = rest.join(" ");
			if (!title) {
				await runtime.output("Usage: /kanban add <title>");
				return commandConsumed();
			}
			const card = addCard(title);
			await runtime.output(`Added card [${card.id}]: ${card.title}`);
			return commandConsumed();
		}

		if (verb === "move") {
			const [id, status] = rest;
			if (!id || !status) {
				await runtime.output("Usage: /kanban move <id> <todo|in_progress|done>");
				return commandConsumed();
			}
			const card = moveCard(id, status as KanbanStatus);
			if (!card) {
				await runtime.output(`Card ${id} not found.`);
			} else {
				await runtime.output(`Moved card [${card.id}] to ${status}.`);
			}
			return commandConsumed();
		}

		if (verb === "rm") {
			const id = rest[0];
			if (!id) {
				await runtime.output("Usage: /kanban rm <id>");
				return commandConsumed();
			}
			const ok = removeCard(id);
			await runtime.output(ok ? `Removed card ${id}.` : `Card ${id} not found.`);
			return commandConsumed();
		}

		await runtime.output("Usage: /kanban [add|move|rm|list]");
		return commandConsumed();
	},

	handleTui: async (command, runtime) => {
		const text = command.args.trim();
		const [verb, ...rest] = text.split(/\s+/);

		if (!verb || verb === "list") {
			runtime.ctx.showStatus(renderBoard());
			runtime.ctx.editor.setText("");
			return;
		}

		if (verb === "add") {
			const title = rest.join(" ");
			if (!title) {
				runtime.ctx.showStatus("Fill in the card title:");
				runtime.ctx.editor.setText("/kanban add ");
				if (typeof runtime.ctx.editor.setCursorPosition === "function") {
					runtime.ctx.editor.setCursorPosition(0, 12);
				}
				return;
			}
			const card = addCard(title);
			runtime.ctx.showStatus(`Added [${card.id}]: ${card.title}\n${renderBoard()}`);
			runtime.ctx.editor.setText("");
			return;
		}

		if (verb === "move") {
			const [id, status] = rest;
			if (!id || !status) {
				runtime.ctx.showStatus("Usage: /kanban move <id> <todo|in_progress|done>");
				runtime.ctx.editor.setText(`/kanban move `);
				return;
			}
			const card = moveCard(id, status as KanbanStatus);
			runtime.ctx.showStatus(card ? `Moved [${card.id}] → ${status}\n${renderBoard()}` : `Card ${id} not found.`);
			runtime.ctx.editor.setText("");
			return;
		}

		if (verb === "rm") {
			const id = rest[0];
			if (!id) {
				runtime.ctx.showStatus("Usage: /kanban rm <id>");
				runtime.ctx.editor.setText("/kanban rm ");
				return;
			}
			const ok = removeCard(id);
			runtime.ctx.showStatus(ok ? `Removed card ${id}.\n${renderBoard()}` : `Card ${id} not found.`);
			runtime.ctx.editor.setText("");
			return;
		}

		// No args — show the board and hint
		runtime.ctx.showStatus(
			`${renderBoard()}\n\nTip: /kanban add <title> | /kanban move <id> <status> | /kanban rm <id>`,
		);
		runtime.ctx.editor.setText("");
	},
};
