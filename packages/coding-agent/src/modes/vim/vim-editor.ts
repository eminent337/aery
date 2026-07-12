import { CustomEditor } from "../components/custom-editor";
import { handleColonCommand } from "./colon";
import { handleInsertMode } from "./modes/insert";
import { handleNormalMode } from "./modes/normal";
import { handleVisualMode } from "./modes/visual";
import { executeSearch, repeatSearch } from "./search";
import { VimState } from "./state";

export class VimEditor extends CustomEditor {
	#vimState = new VimState();
	#active = false;
	#visualAnchor = { startLine: 0, startCol: 0 };
	#inputBuffer = "";

	setVimEnabled(enabled: boolean): void {
		this.#active = enabled;
		this.#vimState.mode = enabled ? "normal" : "insert";
		this.updateBorder();
	}

	isVimEnabled(): boolean {
		return this.#active;
	}

	updateBorder(): void {
		if (this.#active) {
			const modeName = this.#vimState.mode.toUpperCase();
			this.setPromptGutter(`[${modeName}] > `);
		} else {
			this.setPromptGutter("> ");
		}
	}

	override handleInput(data: string): void {
		if (!this.#active) {
			super.handleInput(data);
			return;
		}

		// Buffer search or colon command input mode
		if (this.#vimState.mode === "normal" && (data === ":" || data === "/" || data === "?")) {
			this.#vimState.mode = "insert";
			this.#inputBuffer = data;
			this.setPromptGutter(`${data} `);
			return;
		}

		if (this.#inputBuffer) {
			if (data === "escape") {
				this.#inputBuffer = "";
				this.#vimState.mode = "normal";
				this.updateBorder();
				return;
			}
			if (data === "enter" || data === "\r" || data === "\n") {
				const cmd = this.#inputBuffer;
				this.#inputBuffer = "";
				this.#vimState.mode = "normal";
				this.updateBorder();

				const buffer = {
					lines: this.getLines(),
					cursorLine: this.getCursor().line,
					cursorCol: this.getCursor().col,
				};

				if (cmd.startsWith(":")) {
					const newBuf = handleColonCommand(buffer, cmd, this.#vimState, {
						onSave: () => this.onSubmit?.(this.getText()),
						onClose: () => this.onExit?.(),
						onShowStatus: () => {},
					});
					this.setLines(newBuf.lines);
					this.setCursorPosition(newBuf.cursorLine, newBuf.cursorCol);
				} else if (cmd.startsWith("/")) {
					const newBuf = executeSearch(buffer, cmd.substring(1), "forward", this.#vimState);
					this.setCursorPosition(newBuf.cursorLine, newBuf.cursorCol);
				} else if (cmd.startsWith("?")) {
					const newBuf = executeSearch(buffer, cmd.substring(1), "backward", this.#vimState);
					this.setCursorPosition(newBuf.cursorLine, newBuf.cursorCol);
				}
				return;
			}
			if (data === "backspace") {
				this.#inputBuffer = this.#inputBuffer.slice(0, -1);
				if (!this.#inputBuffer) {
					this.#vimState.mode = "normal";
					this.updateBorder();
				} else {
					this.setPromptGutter(`${this.#inputBuffer} `);
				}
				return;
			}
			if (data.length === 1) {
				this.#inputBuffer += data;
				this.setPromptGutter(`${this.#inputBuffer} `);
				return;
			}
		}

		const buffer = {
			lines: this.getLines(),
			cursorLine: this.getCursor().line,
			cursorCol: this.getCursor().col,
		};

		if (this.#vimState.mode === "normal") {
			if (data === "n" || data === "N") {
				const newBuf = repeatSearch(buffer, this.#vimState, data === "n");
				this.setCursorPosition(newBuf.cursorLine, newBuf.cursorCol);
				return;
			}

			const { buffer: newBuf, transitionMode } = handleNormalMode(buffer, data, this.#vimState);
			this.setLines(newBuf.lines);
			this.setCursorPosition(newBuf.cursorLine, newBuf.cursorCol);

			if (transitionMode) {
				this.#vimState.mode = transitionMode as any;
				if (transitionMode.startsWith("visual")) {
					this.#visualAnchor = { startLine: newBuf.cursorLine, startCol: newBuf.cursorCol };
				}
				this.updateBorder();
			}
		} else if (this.#vimState.mode.startsWith("visual")) {
			const { buffer: newBuf, transitionMode } = handleVisualMode(buffer, data, this.#visualAnchor, this.#vimState);
			this.setLines(newBuf.lines);
			this.setCursorPosition(newBuf.cursorLine, newBuf.cursorCol);

			if (transitionMode) {
				this.#vimState.mode = transitionMode as any;
				this.updateBorder();
			}
		} else if (this.#vimState.mode === "insert") {
			const { buffer: newBuf } = handleInsertMode(buffer, data);

			if (data === "escape") {
				this.setLines(newBuf.lines);
				this.setCursorPosition(newBuf.cursorLine, newBuf.cursorCol);
				this.#vimState.mode = "normal";
				this.updateBorder();
			} else {
				super.handleInput(data);
			}
		}
	}
}
