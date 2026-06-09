/**
 * FlexBox — proportional column/row layout for the ANSI differential renderer.
 *
 * "row": divides total width among children by flex-grow / fixed rules,
 *        renders each child, then zips line arrays side-by-side.
 * "column": stacks children vertically (simple concat).
 */
import type { Component } from "../tui.js";
import { padding, visibleWidth } from "../utils.js";

export interface FlexBoxStyle {
	direction: "row" | "column";
	gap?: number;
}

export interface FlexItem {
	component: Component;
	grow?: number;
	fixed?: number;
	min?: number;
}

export class FlexBox implements Component {
	#style: FlexBoxStyle;
	#items: FlexItem[] = [];

	constructor(style: FlexBoxStyle) {
		this.#style = style;
	}

	addItem(component: Component, opts: Omit<FlexItem, "component"> = { grow: 1 }): this {
		this.#items.push({ component, ...opts });
		return this;
	}

	removeItem(component: Component): void {
		const i = this.#items.findIndex(it => it.component === component);
		if (i !== -1) this.#items.splice(i, 1);
	}

	clear(): void {
		this.#items = [];
	}

	invalidate(): void {
		for (const item of this.#items) item.component.invalidate?.();
	}

	render(width: number): string[] {
		if (this.#items.length === 0) return [];
		return this.#style.direction === "column" ? this.#renderColumn(width) : this.#renderRow(width);
	}

	#renderColumn(width: number): string[] {
		const gap = this.#style.gap ?? 0;
		const gapLine = padding(width);
		const result: string[] = [];
		for (let i = 0; i < this.#items.length; i++) {
			result.push(...this.#items[i]!.component.render(width));
			if (gap > 0 && i < this.#items.length - 1) {
				for (let g = 0; g < gap; g++) result.push(gapLine);
			}
		}
		return result;
	}

	#renderRow(totalWidth: number): string[] {
		const gap = this.#style.gap ?? 0;
		const totalGap = gap * Math.max(0, this.#items.length - 1);
		const widths = this.#computeWidths(totalWidth - totalGap);
		const columns = this.#items.map((item, i) => item.component.render(Math.max(1, widths[i] ?? 1)));
		const height = Math.max(0, ...columns.map(c => c.length));
		if (height === 0) return [];
		const gapStr = gap > 0 ? padding(gap) : "";
		const result: string[] = [];
		for (let row = 0; row < height; row++) {
			let line = "";
			for (let col = 0; col < columns.length; col++) {
				const colWidth = widths[col] ?? 1;
				const rawLine = columns[col]![row] ?? "";
				const vis = visibleWidth(rawLine);
				const cell = vis < colWidth ? rawLine + padding(colWidth - vis) : rawLine;
				line += cell;
				if (col < columns.length - 1) line += gapStr;
			}
			result.push(line);
		}
		return result;
	}

	#computeWidths(available: number): number[] {
		const widths: number[] = new Array(this.#items.length).fill(0);
		let remaining = available;
		let totalGrow = 0;
		for (let i = 0; i < this.#items.length; i++) {
			const item = this.#items[i]!;
			if (item.fixed !== undefined) {
				const w = Math.min(item.fixed, remaining);
				widths[i] = w;
				remaining -= w;
			} else {
				totalGrow += item.grow ?? 1;
			}
		}
		if (totalGrow > 0 && remaining > 0) {
			let distributed = 0;
			const growItems = this.#items.map((item, i) => ({ item, i })).filter(({ item }) => item.fixed === undefined);
			for (let k = 0; k < growItems.length; k++) {
				const { item, i } = growItems[k]!;
				const share =
					k === growItems.length - 1
						? remaining - distributed
						: Math.floor((remaining * (item.grow ?? 1)) / totalGrow);
				widths[i] = Math.max(item.min ?? 1, share);
				distributed += share;
			}
		}
		return widths;
	}
}
