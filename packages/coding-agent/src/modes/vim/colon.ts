import type { EditorBuffer } from "./motions";
import type { VimState } from "./state";

export function handleColonCommand(
	buf: EditorBuffer,
	command: string,
	state: VimState,
	callbacks: {
		onSave?: () => void;
		onClose?: () => void;
		onShowStatus?: (msg: string) => void;
	},
): EditorBuffer {
	const trimmed = command.trim();
	if (trimmed === ":w") {
		callbacks.onSave?.();
		callbacks.onShowStatus?.("File saved successfully.");
	} else if (trimmed === ":q") {
		callbacks.onClose?.();
	} else if (trimmed === ":noh") {
		state.searchPattern = "";
		callbacks.onShowStatus?.("Search highlighting cleared.");
	} else {
		callbacks.onShowStatus?.(`Unknown command: ${command}`);
	}

	return buf;
}
