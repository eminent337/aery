import { parseKey } from "@aryee337/aery-tui";
import { CustomEditor } from "../components/custom-editor";
import { highlightMagicKeywords } from "../magic-keywords";
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
		this.setBorderVisible(!enabled);
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

	override decorateText = (text: string, lineIndex = 0, colOffset = 0): string => {
		if (this.#active && this.#vimState.mode.startsWith("visual")) {
			const startLine = this.#visualAnchor.startLine;
			const startCol = this.#visualAnchor.startCol;
			const endLine = this.getCursor().line;
			const endCol = this.getCursor().col;

			// Normalize bounds
			let sL = startLine;
			let sC = startCol;
			let eL = endLine;
			let eC = endCol;
			if (sL > eL || (sL === eL && sC > eC)) {
				sL = endLine;
				sC = endCol;
				eL = startLine;
				eC = startCol;
			}

			const isVisualLine = this.#vimState.mode === "visual-line";
			let highlighted = "";
			const chars = [...text];

			for (let idx = 0; idx < chars.length; idx++) {
				const char = chars[idx];
				const col = colOffset + idx;
				let isSelected = false;

				if (isVisualLine) {
					isSelected = lineIndex >= sL && lineIndex <= eL;
				} else {
					if (lineIndex > sL && lineIndex < eL) {
						isSelected = true;
					} else if (lineIndex === sL && lineIndex === eL) {
						isSelected = col >= sC && col <= eC;
					} else if (lineIndex === sL && lineIndex < eL) {
						isSelected = col >= sC;
					} else if (lineIndex === eL && lineIndex > sL) {
						isSelected = col <= eC;
					}
				}

				if (isSelected) {
					highlighted += `\x1b[7m${char}\x1b[27m`;
				} else {
					highlighted += char;
				}
			}
			return highlighted;
		}

		return highlightMagicKeywords(text);
	};

	override handleInput(data: string): void {
		if (!this.#active) {
			super.handleInput(data);
			return;
		}

		const key = parseKey(data) || data;

		// Buffer search or colon command input mode
		if (this.#vimState.mode === "normal" && (key === ":" || key === "/" || key === "?")) {
			this.#vimState.mode = "insert";
			this.#inputBuffer = key;
			this.setPromptGutter(`${key} `);
			return;
		}

		if (this.#inputBuffer) {
			if (key === "escape") {
				this.#inputBuffer = "";
				this.#vimState.mode = "normal";
				this.updateBorder();
				return;
			}
			if (key === "enter") {
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
			if (key === "backspace") {
				this.#inputBuffer = this.#inputBuffer.slice(0, -1);
				if (!this.#inputBuffer) {
					this.#vimState.mode = "normal";
					this.updateBorder();
				} else {
					this.setPromptGutter(`${this.#inputBuffer} `);
				}
				return;
			}
			if (key.length === 1) {
				this.#inputBuffer += key;
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
			// Enter in normal mode submits the message (equivalent to :wq)
			if (key === "enter") {
				this.onSubmit?.(this.getText());
				return;
			}
			// Escape in normal mode propagates so the agent can be interrupted
			if (key === "escape") {
				super.handleInput(data);
				return;
			}
			if (key === "n" || key === "N") {
				const newBuf = repeatSearch(buffer, this.#vimState, key === "n");
				this.setCursorPosition(newBuf.cursorLine, newBuf.cursorCol);
				return;
			}

			const { buffer: newBuf, transitionMode } = handleNormalMode(buffer, key, this.#vimState);
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
			const { buffer: newBuf, transitionMode } = handleVisualMode(buffer, key, this.#visualAnchor, this.#vimState);
			this.setLines(newBuf.lines);
			this.setCursorPosition(newBuf.cursorLine, newBuf.cursorCol);

			if (transitionMode) {
				this.#vimState.mode = transitionMode as any;
				this.updateBorder();
			}
		} else if (this.#vimState.mode === "insert") {
			const { buffer: newBuf } = handleInsertMode(buffer, key);

			if (key === "escape") {
				// Escape: apply cursor-back and transition to normal; do NOT propagate
				this.setLines(newBuf.lines);
				this.setCursorPosition(newBuf.cursorLine, newBuf.cursorCol);
				this.#vimState.mode = "normal";
				this.updateBorder();
			} else if (key === "enter") {
				// Enter in insert mode: insert newline via base editor (handles submission logic)
				super.handleInput(data);
			} else {
				// All other insert-mode keys: delegate to base editor for proper handling
				super.handleInput(data);
			}
		}
	}
}
