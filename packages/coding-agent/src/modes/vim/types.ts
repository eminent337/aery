export type VimMode = "normal" | "insert" | "visual" | "visual-line";

export interface VimRegister {
	name: string;
	content: string;
	type: "char" | "line";
}
