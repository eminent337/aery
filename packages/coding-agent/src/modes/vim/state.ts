import type { VimMode, VimRegister } from "./types";

export class VimState {
	mode: VimMode = "normal";
	count: number | null = null;
	registers = new Map<string, VimRegister>();
	unnamedRegister: VimRegister = { name: '"', content: "", type: "char" };
	searchPattern = "";
	searchDirection: "forward" | "backward" = "forward";
	jumpList: { line: number; col: number }[] = [];
	jumpIndex = -1;

	recordJump(line: number, col: number): void {
		if (this.jumpIndex >= 0 && this.jumpIndex < this.jumpList.length) {
			const current = this.jumpList[this.jumpIndex];
			if (current.line === line && current.col === col) return;
		}
		// Truncate list if index is not at the end
		if (this.jumpIndex < this.jumpList.length - 1) {
			this.jumpList = this.jumpList.slice(0, this.jumpIndex + 1);
		}
		this.jumpList.push({ line, col });
		this.jumpIndex = this.jumpList.length - 1;
		if (this.jumpList.length > 100) {
			this.jumpList.shift();
			this.jumpIndex--;
		}
	}

	getYanked(name?: string): VimRegister {
		const regName = name ?? '"';
		if (regName === '"') return this.unnamedRegister;
		return this.registers.get(regName) ?? { name: regName, content: "", type: "char" };
	}

	setYanked(content: string, type: "char" | "line", name?: string): void {
		const reg: VimRegister = { name: name ?? '"', content, type };
		this.unnamedRegister = reg;
		if (name && name !== '"' && name !== "_") {
			this.registers.set(name, reg);
		}
	}
}
