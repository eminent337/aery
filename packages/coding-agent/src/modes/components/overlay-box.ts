/**
 * Shared box-drawing chrome for fullscreen overlays (the `/move` picker,
 * plan-review overlay, …). Every helper paints with Unicode box-drawing glyphs
 * (rounded corners) and the `border`/`accent` theme colors so all outlined
 * overlays read identically.
 */
import { padding, truncateToWidth, visibleWidth } from "@aryee337/aery-tui";
import { theme } from "../theme/theme";

/** Pad or truncate a (possibly ANSI-styled) string to exactly `width` columns. */
export function fit(text: string, width: number): string {
	if (width <= 0) return "";
	const w = visibleWidth(text);
	if (w === width) return text;
	if (w < width) return text + padding(width - w);
	const cut = truncateToWidth(text, width);
	const cw = visibleWidth(cut);
	return cw < width ? cut + padding(width - cw) : cut;
}

function paint(s: string): string {
	return theme.fg("border", s);
}

// Rounded-corner box glyphs
const BOX = {
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
	horizontal: "─",
	vertical: "│",
	teeRight: "├",
	teeLeft: "┤",
};

/** Top border with an optional accent-colored title inset into the rule. */
export function topBorder(width: number, title?: string): string {
	const inner = Math.max(0, width - 2);
	if (!title) return paint(BOX.topLeft + BOX.horizontal.repeat(inner) + BOX.topRight);
	const shown = truncateToWidth(` ${title} `, Math.max(0, inner - 2));
	const fillWidth = Math.max(0, inner - 1 - visibleWidth(shown));
	return (
		paint(BOX.topLeft + BOX.horizontal) +
		theme.bold(theme.fg("accent", shown)) +
		paint(BOX.horizontal.repeat(fillWidth) + BOX.topRight)
	);
}

/** A horizontal rule with left/right tees, splitting overlay sections. */
export function divider(width: number): string {
	return paint(BOX.teeRight + BOX.horizontal.repeat(Math.max(0, width - 2)) + BOX.teeLeft);
}

/** Bottom border of the box. */
export function bottomBorder(width: number): string {
	return paint(BOX.bottomLeft + BOX.horizontal.repeat(Math.max(0, width - 2)) + BOX.bottomRight);
}

/** Wrap pre-styled content in vertical borders with single-column insets. */
export function row(content: string, width: number): string {
	return `${paint(BOX.vertical)} ${fit(content, Math.max(0, width - 4))} ${paint(BOX.vertical)}`;
}
