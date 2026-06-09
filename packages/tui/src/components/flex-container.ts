import type { Component } from "../tui.js";

export interface FlexChild {
	component: Component;
	flexGrow?: number;
	fixedHeight?: number;
}

export class FlexContainer implements Component {
	#children: FlexChild[] = [];
	#heightFn: () => number;

	constructor(heightFn: () => number) {
		this.#heightFn = heightFn;
	}

	addChild(component: Component, flexGrow: number = 0, fixedHeight?: number): void {
		this.#children.push({ component, flexGrow, fixedHeight });
	}

	clear(): void {
		this.#children = [];
	}

	invalidate(): void {
		for (const child of this.#children) {
			child.component.invalidate?.();
		}
	}

	render(width: number): string[] {
		const height = this.#heightFn();
		if (width <= 0 || height <= 0) return [];

		let totalFixed = 0;
		let totalFlexGrow = 0;
		const childRenders: string[][] = [];

		for (const child of this.#children) {
			if (child.flexGrow && child.flexGrow > 0) {
				totalFlexGrow += child.flexGrow;
				childRenders.push([]);
			} else {
				if (typeof (child.component as any).setHeight === "function" && child.fixedHeight) {
					(child.component as any).setHeight(child.fixedHeight);
				}
				const lines = child.component.render(width);
				const needed = child.fixedHeight ?? lines.length;
				totalFixed += needed;
				childRenders.push(lines);
			}
		}

		const remainingHeight = Math.max(0, height - totalFixed);
		let allocatedFlexHeight = 0;

		for (let i = 0; i < this.#children.length; i++) {
			const child = this.#children[i]!;
			if (child.flexGrow && child.flexGrow > 0) {
				const flexHeight = Math.floor((child.flexGrow / totalFlexGrow) * remainingHeight);
				allocatedFlexHeight += flexHeight;

				if (typeof (child.component as any).setHeight === "function") {
					(child.component as any).setHeight(flexHeight);
				}
				const lines = child.component.render(width);
				childRenders[i] = lines.slice(0, flexHeight);
			}
		}

		const result: string[] = [];
		for (const lines of childRenders) {
			result.push(...lines);
		}

		while (result.length < height) {
			result.push("");
		}

		return result.slice(0, height);
	}
}
