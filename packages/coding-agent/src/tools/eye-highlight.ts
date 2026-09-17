/**
 * Pure logic for the `highlight` action (desktop_control): map frame-px
 * rectangles from the eye's per-view anchored frames into physical screen
 * rectangles for the overlay, and compute the overlay surface geometry.
 * No side effects — unit-testable without the compositor.
 */
import type { InputFrame } from "./live-input";

/** One rectangle to draw on the overlay, in PHYSICAL screen px. */
export interface HighlightRect {
	x: number;
	y: number;
	w: number;
	h: number;
	label?: string;
}

/** Frame-px rect as passed by the model (same space as click targets). */
export interface FrameRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/**
 * How the marker is drawn:
 *  - "highlighter": a solid translucent band painted OVER the words, exactly
 *    like a felt-tip highlighter (or a browser's text selection). This is the
 *    default — it reads as "these words are highlighted", not "a box was drawn
 *    around these words".
 *  - "box": a hollow outline, for when the point is to frame a region.
 */
export type HighlightStyle = "highlighter" | "box";

/** Monitor reserved zones (waybar/pannels), in physical px. */
export interface ReservedArea {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** A band in surface-local coordinates (what cairo actually draws). */
export interface LocalBand {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** Everything the overlay script needs to place and draw itself. */
export interface LayerGeometry {
	marginLeft: number;
	marginTop: number;
	width: number;
	height: number;
	bands: LocalBand[];
}

/**
 * Map a frame-px rect to physical screen px using the frame the reading was
 * anchored to. Same math as frameToPhysical: physical = frameOrigin + framePx/scale,
 * where scale = scaled/phys per axis. Clamps into the frame first.
 */
export function frameRectToPhysical(
	frame: Pick<InputFrame, "atX" | "atY" | "physW" | "physH" | "scaledW" | "scaledH">,
	rect: FrameRect,
): HighlightRect | null {
	if (frame.scaledW <= 0 || frame.scaledH <= 0 || frame.physW <= 0 || frame.physH <= 0) return null;
	const sx = frame.scaledW / frame.physW;
	const sy = frame.scaledH / frame.physH;
	const x = Math.min(Math.max(rect.x, 0), frame.scaledW);
	const y = Math.min(Math.max(rect.y, 0), frame.scaledH);
	const w = Math.min(Math.max(rect.w, 0), frame.scaledW - x);
	const h = Math.min(Math.max(rect.h, 0), frame.scaledH - y);
	if (w <= 0 || h <= 0) return null;
	return {
		x: Math.round(frame.atX + x / sx),
		y: Math.round(frame.atY + y / sy),
		w: Math.max(1, Math.round(w / sx)),
		h: Math.max(1, Math.round(h / sy)),
	};
}

/** Union bounding box of rects (for sizing one overlay window). */
export function boundingBox(rects: HighlightRect[]): { x: number; y: number; w: number; h: number } | null {
	if (rects.length === 0) return null;
	const x0 = Math.min(...rects.map(r => r.x));
	const y0 = Math.min(...rects.map(r => r.y));
	const x1 = Math.max(...rects.map(r => r.x + r.w));
	const y1 = Math.max(...rects.map(r => r.y + r.h));
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Convert a color name to cairo RGBA. `a` is the highlighter body alpha. */
export function highlightColor(name: string | undefined): { r: number; g: number; b: number; a: number } {
	switch (name) {
		case "amber":
			return { r: 1.0, g: 0.72, b: 0.11, a: 0.5 };
		case "green":
			return { r: 0.35, g: 0.92, b: 0.42, a: 0.45 };
		case "cyan":
			return { r: 0.2, g: 0.85, b: 0.95, a: 0.45 };
		case "pink":
			return { r: 1.0, g: 0.4, b: 0.68, a: 0.5 };
		case "blue":
			return { r: 0.35, g: 0.62, b: 1.0, a: 0.5 };
		case "red":
			return { r: 1.0, g: 0.25, b: 0.25, a: 0.5 };
		default:
			// Classic highlighter yellow — the color a real marker leaves.
			return { r: 1.0, g: 0.93, b: 0.25, a: 0.55 };
	}
}

/** Extra vertical bleed so the band covers the whole text line like a marker. */
export function bandBleed(h: number): number {
	return Math.max(3, Math.round(h * 0.22));
}

/** Grow each rect into the actual painted band (pad horizontally, bleed vertically). */
export function toBands(rects: HighlightRect[], opts: { pad: number; style: HighlightStyle }): HighlightRect[] {
	const bleed = opts.style === "highlighter" ? bandBleed(rects.reduce((m, r) => Math.max(m, r.h), 0)) : opts.pad;
	const b = opts.style === "highlighter" ? Math.max(3, opts.pad) : opts.pad;
	return rects.map(r => ({
		...r,
		x: r.x - b,
		y: r.y - bleed,
		w: r.w + 2 * b,
		h: r.h + 2 * bleed,
	}));
}

/**
 * Merge grown bands into continuous marker strokes. Without this, painting a
 * whole line paints one padded band per word: neighbours overlap, cairo OVER
 * stacks the alpha in the overlap (dark seams), and the line reads as a
 * lumpy yellow blob instead of one clean highlighter stroke. Bands join when
 * they share a text line (vertical overlap ≥ half the smaller height) and
 * sit close horizontally (gap ≤ maxGap, default 28 physical px — terminal
 * word gaps are ~8-15px). Different lines and far-apart words stay separate.
 */
export function mergeBands(bands: HighlightRect[], opts: { maxGap?: number } = {}): HighlightRect[] {
	if (bands.length < 2) return [...bands];
	const maxGap = opts.maxGap ?? 28;
	const overlapY = (a: HighlightRect, b: HighlightRect) =>
		Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
	const sameLine = (a: HighlightRect, b: HighlightRect) =>
		overlapY(a, b) >= 0.5 * Math.min(a.h, b.h);
	// Group into lines first (bands arrive in reading order, not row order).
	const byY = [...bands].sort((a, b) => a.y - b.y || a.x - b.x);
	const lines: HighlightRect[][] = [];
	for (const b of byY) {
		const line = lines.find(l => l.some(m => sameLine(m, b)));
		if (line) line.push(b);
		else lines.push([b]);
	}
	// Within a line, join runs separated by at most a word gap.
	const out: HighlightRect[] = [];
	for (const line of lines) {
		const xs = [...line].sort((a, b) => a.x - b.x);
		let cur = { ...xs[0] };
		for (const n of xs.slice(1)) {
			if (n.x - (cur.x + cur.w) <= maxGap) {
				const x1 = Math.min(cur.x, n.x);
				const y1 = Math.min(cur.y, n.y);
				const x2 = Math.max(cur.x + cur.w, n.x + n.w);
				const y2 = Math.max(cur.y + cur.h, n.y + n.h);
				cur = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
			} else {
				out.push(cur);
				cur = { ...n };
			}
		}
		out.push(cur);
	}
	return out;
}

/**
 * Convert physical band rects into the layer-shell surface geometry.
 *
 * Two compositor facts this encodes:
 *  1. A layer-shell surface is positioned inside the monitor's USABLE area —
 *     margins are measured from below/right of reserved zones (waybar). With a
 *     68px top bar, a margin of 400 lands at screen y=468, so screen
 *     coordinates must be shifted into usable-area space (y - reserved.top).
 *  2. Margins and the surface size are LOGICAL units while our rects are
 *     physical, so divide by the monitor scale.
 */
export function layerGeometry(
	bands: HighlightRect[],
	opts: { reserved?: ReservedArea; scale?: number } = {},
): LayerGeometry | null {
	const bb = boundingBox(bands);
	if (!bb) return null;
	const reserved = opts.reserved ?? { left: 0, top: 0, right: 0, bottom: 0 };
	const scale = opts.scale && opts.scale > 0 ? opts.scale : 1;
	// Work in USABLE-AREA coordinates: the compositor positions the surface
	// against the area left over after bars, so a band at screen y maps to
	// usable y = screen y - reserved.top. Origin is the min usable coordinate,
	// clamped to 0 (a band under the bar draws at a negative local offset and
	// is clipped by the surface).
	const usable = bands.map(r => ({ x: r.x - reserved.left, y: r.y - reserved.top, w: r.w, h: r.h }));
	// Drop bands that fall entirely behind a reserved zone (under the bar):
	// they can never be seen, so drawing them would only enlarge the surface.
	const keep = usable.filter(b => b.w > 0 && b.h > 0 && b.x + b.w > reserved.left && b.y + b.h > 0);
	if (keep.length === 0) return null;

	const originX = Math.max(0, Math.min(...keep.map(b => b.x)));
	const originY = Math.max(0, Math.min(...keep.map(b => b.y)));
	const x1 = Math.max(...keep.map(b => b.x + b.w));
	const y1 = Math.max(...keep.map(b => b.y + b.h));
	return {
		marginLeft: Math.round(originX / scale),
		marginTop: Math.round(originY / scale),
		width: Math.max(1, Math.round((x1 - originX) / scale)),
		height: Math.max(1, Math.round((y1 - originY) / scale)),
		bands: keep.map(b => ({
			x: (b.x - originX) / scale,
			y: (b.y - originY) / scale,
			w: b.w / scale,
			h: b.h / scale,
		})),
	};
}

/**
 * Generate the python overlay script that paints the bands for `ms`, then
 * dissolves and exits. One self-contained script per highlight:
 * spawn → paint → hold → fade → exit.
 *
 * The overlay is a layer-shell OVERLAY surface: click-through, unfocusable,
 * never steals keyboard focus — so it can paint over a terminal without
 * touching the restricted-app guardrail (which governs injection, not drawing).
 *
 * The cairo operators are chosen by NAME (imported cairo) rather than numeric
 * literals: OPERATOR_CLEAR is 0 and OPERATOR_OVER is 2, and passing the wrong
 * numbers silently ERASES every rect instead of drawing it.
 */
export function highlightOverlayScript(
	geometry: LayerGeometry,
	opts: { color?: string; ms: number; width: number; style?: HighlightStyle; fadeMs?: number },
): string {
	const color = highlightColor(opts.color);
	const style: HighlightStyle = opts.style ?? "highlighter";
	const fadeMs = opts.fadeMs ?? 450;
	return `import gi, json, cairo
gi.require_version('Gtk', '3.0')
gi.require_version('GtkLayerShell', '0.1')
from gi.repository import Gtk, GtkLayerShell, GLib

GEO = json.loads(${JSON.stringify(JSON.stringify(geometry))})
COLOR = json.loads(${JSON.stringify(JSON.stringify(color))})
MS = ${opts.ms}
FADE_MS = ${fadeMs}
WIDTH = ${opts.width}
STYLE = ${JSON.stringify(style)}

win = Gtk.Window(type=Gtk.WindowType.TOPLEVEL)
win.set_decorated(False)
win.set_app_paintable(True)
rgba = win.get_screen().get_rgba_visual()
if rgba:
    win.set_visual(rgba)
GtkLayerShell.init_for_window(win)
GtkLayerShell.set_layer(win, GtkLayerShell.Layer.OVERLAY)
# Never reserve space back onto the monitor (drawing must not move the desktop).
GtkLayerShell.set_exclusive_zone(win, 0)
GtkLayerShell.set_anchor(win, GtkLayerShell.Edge.TOP, True)
GtkLayerShell.set_anchor(win, GtkLayerShell.Edge.LEFT, True)
GtkLayerShell.set_margin(win, GtkLayerShell.Edge.LEFT, int(GEO["marginLeft"]))
GtkLayerShell.set_margin(win, GtkLayerShell.Edge.TOP, int(GEO["marginTop"]))
GtkLayerShell.set_keyboard_mode(win, GtkLayerShell.KeyboardMode.NONE)
win.set_size_request(int(GEO["width"]), int(GEO["height"]))

state = {"alpha": 1.0}

def on_draw(_w, cr):
    # CLEAR = fully transparent base (must be OPERATOR_CLEAR, never a literal).
    cr.set_operator(cairo.OPERATOR_CLEAR)
    cr.paint()
    cr.set_operator(cairo.OPERATOR_OVER)
    k = state["alpha"]
    for b in GEO["bands"]:
        x, y, w, h = b["x"], b["y"], b["w"], b["h"]
        if STYLE == "box":
            cr.set_source_rgba(COLOR["r"], COLOR["g"], COLOR["b"], COLOR["a"] * 0.25 * k)
            cr.rectangle(x, y, w, h)
            cr.fill()
            cr.set_source_rgba(COLOR["r"], COLOR["g"], COLOR["b"], 0.95 * k)
            cr.set_line_width(WIDTH)
            cr.rectangle(x, y, w, h)
            cr.stroke()
        else:
            # A felt-tip stroke: soft halo, solid core, faint edge — ink laid
            # over the glyphs, not a frame drawn around them.
            cr.set_source_rgba(COLOR["r"], COLOR["g"], COLOR["b"], COLOR["a"] * 0.35 * k)
            cr.rectangle(x - 2, y - 1, w + 4, h + 2)
            cr.fill()
            cr.set_source_rgba(COLOR["r"], COLOR["g"], COLOR["b"], COLOR["a"] * k)
            cr.rectangle(x, y, w, h)
            cr.fill()
            cr.set_source_rgba(0.05, 0.05, 0.05, 0.22 * k)
            cr.set_line_width(1.0)
            cr.rectangle(x, y, w, h)
            cr.stroke()
    return True

def tick():
    if state["alpha"] <= 0.02:
        Gtk.main_quit()
        return False
    if state["alpha"] < 1.0:
        state["alpha"] = max(0.0, state["alpha"] - 1000.0 / max(1, FADE_MS) * 0.04)
    win.queue_draw()
    return True

def start_fade():
    state["alpha"] = 0.99
    return False

win.connect("draw", on_draw)
win.connect("destroy", Gtk.main_quit)
win.show_all()
GLib.timeout_add(max(1, MS - FADE_MS), start_fade)
GLib.timeout_add(40, tick)
Gtk.main()
`;
}
