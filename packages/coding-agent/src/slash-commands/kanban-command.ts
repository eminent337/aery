import { launchKanban } from "../task/kanban";
import type { SlashCommandSpec } from "./types";

export const kanbanCommand: SlashCommandSpec = {
	name: "kanban",
	description: "Launch the Kanban board",
	subcommands: [],
	async handle(_command, runtime) {
		if (runtime.output) {
			await runtime.output("Launching Kanban board...");
		}
		const code = await launchKanban({
			output: (text: string) => runtime.output(text),
			outputErr: (text: string) => runtime.output(text),
		});
		if (runtime.output) {
			await runtime.output(`Kanban board exited with code ${code}`);
		}
		return { consumed: true };
	},
	async handleTui(_command, runtime) {
		runtime.ctx.showStatus("Launching Kanban board...");
		runtime.ctx.editor.setText("");

		// Note: The UI may need to be suspended for a terminal application to take over stdio.
		// We launch it and wait for it to exit, but this might clobber the TUI until we find
		// the proper way to suspend it.
		const code = await launchKanban({
			output: (text: string) => runtime.ctx.showStatus(text),
			outputErr: (text: string) => runtime.ctx.showStatus(`Error: ${text}`),
		});

		runtime.ctx.showStatus(`Kanban exited with code ${code}`);
		return { consumed: true };
	},
};
