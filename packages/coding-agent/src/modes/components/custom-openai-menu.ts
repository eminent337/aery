import {
	Container,
	extractPrintableText,
	fuzzyFilter,
	matchesKey,
	Spacer,
	Text,
	TruncatedText,
} from "@aryee337/aery-tui";
import { theme } from "../../modes/theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../../modes/utils/keybinding-matchers";
import { DynamicBorder } from "./dynamic-border";

export interface CustomOpenAICompatibleMenuItem {
	id: string;
	name: string;
	description?: string;
}

const MAX_VISIBLE = 10;

/**
 * Menu component for Custom OpenAI Compatible providers.
 * Arrow keys to navigate, Enter to select, Escape to cancel.
 */
export class CustomOpenAICompatibleMenuComponent extends Container {
	#listContainer: Container;
	#allItems: CustomOpenAICompatibleMenuItem[];
	#filteredItems: CustomOpenAICompatibleMenuItem[];
	#selectedIndex = 0;
	#searchQuery = "";
	#onSelectCallback: (item: CustomOpenAICompatibleMenuItem) => void;
	#onCancelCallback: () => void;

	constructor(
		title: string,
		items: CustomOpenAICompatibleMenuItem[],
		onSelect: (item: CustomOpenAICompatibleMenuItem) => void,
		onCancel: () => void,
	) {
		super();
		this.#allItems = items;
		this.#filteredItems = items;
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(theme.bold(title)));
		this.addChild(new Spacer(1));
		this.#listContainer = new Container();
		this.addChild(this.#listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.#updateList();
	}

	#updateList(): void {
		this.#listContainer.clear();
		const start = Math.max(0, this.#selectedIndex - Math.floor(MAX_VISIBLE / 2));
		const end = Math.min(this.#filteredItems.length, start + MAX_VISIBLE);

		for (let i = start; i < end; i++) {
			const item = this.#filteredItems[i];
			const isSelected = i === this.#selectedIndex;
			const prefix = isSelected ? "▶ " : "  ";
			const name = isSelected ? theme.bold(item.name) : item.name;
			const desc = item.description ? ` - ${item.description}` : "";
			this.#listContainer.addChild(new Text(`${prefix}${name}${desc}`, 1, 0));
		}
	}

	#updateFilter(): void {
		if (this.#searchQuery) {
			this.#filteredItems = fuzzyFilter(this.#allItems, this.#searchQuery, item => item.name);
		} else {
			this.#filteredItems = this.#allItems;
		}
		this.#selectedIndex = 0;
		this.#updateList();
	}

	handleInput(keyData: string): void {
		if (matchesSelectCancel(keyData)) {
			this.#onCancelCallback();
			return;
		}

		if (matchesSelectUp(keyData)) {
			if (this.#filteredItems.length > 0) {
				this.#selectedIndex = this.#selectedIndex === 0 ? this.#filteredItems.length - 1 : this.#selectedIndex - 1;
			}
			this.#updateList();
		} else if (matchesSelectDown(keyData)) {
			if (this.#filteredItems.length > 0) {
				this.#selectedIndex = this.#selectedIndex === this.#filteredItems.length - 1 ? 0 : this.#selectedIndex + 1;
			}
			this.#updateList();
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selected = this.#filteredItems[this.#selectedIndex];
			if (selected) {
				this.#onSelectCallback(selected);
			}
		} else if (matchesKey(keyData, "backspace")) {
			this.#searchQuery = this.#searchQuery.slice(0, -1);
			this.#updateFilter();
		} else {
			const printable = extractPrintableText(keyData);
			if (printable) {
				this.#searchQuery += printable;
				this.#updateFilter();
			}
		}
	}
}
