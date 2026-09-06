import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Image, TUI } from "@aryee337/aery-tui";
import { acquireStableImageId, setKittyGraphics } from "@aryee337/aery-tui/kitty-graphics";
import {
	type CellDimensions,
	getCellDimensions,
	ImageProtocol,
	renderImage,
	setCellDimensions,
	TERMINAL,
} from "@aryee337/aery-tui/terminal-capabilities";
import { VirtualTerminal } from "./virtual-terminal";

type MutableTerminalInfo = {
	imageProtocol: ImageProtocol | null;
};

const terminal = TERMINAL as unknown as MutableTerminalInfo;
const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
const SQUARE_DIMENSIONS = { widthPx: 100, heightPx: 100 };

/** All kitty graphics APCs in `bytes`, as param maps (params live before the `;` payload). */
function kittyApcs(bytes: string): Array<Record<string, string>> {
	const out: Array<Record<string, string>> = [];
	const re = /\x1b_G([^\\]*)\x1b\\/g;
	for (const m of bytes.matchAll(re)) {
		const body = m[1] ?? "";
		const [rawParams] = body.split(";");
		const map: Record<string, string> = {};
		for (const kv of (rawParams ?? "").split(",")) {
			const [k, v] = kv.split("=");
			if (k && v !== undefined) map[k] = v;
		}
		out.push(map);
	}
	return out;
}

describe("kitty image dedup (stable id + placeholder placement)", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	let originalCellDims: CellDimensions;

	beforeEach(() => {
		originalCellDims = { ...getCellDimensions() };
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		terminal.imageProtocol = ImageProtocol.Kitty;
		setKittyGraphics({ unicodePlaceholders: true });
	});

	afterEach(() => {
		setCellDimensions(originalCellDims);
		terminal.imageProtocol = originalProtocol;
		setKittyGraphics({ unicodePlaceholders: false });
	});

	it("renderImage emits a transmit-once payload plus placeholder placement, never anonymous a=T", () => {
		const result = renderImage(BASE64_ONE_PIXEL_PNG, SQUARE_DIMENSIONS, {
			maxWidthCells: 10,
			maxHeightCells: 4,
			imageId: 77,
			includeTransmit: true,
		});

		expect(result).not.toBeNull();
		expect(result?.lines).toBeDefined();
		const lines = result?.lines ?? [];

		// Exactly `rows` text lines; line 0 carries transmit + virtual placement.
		expect(lines.length).toBe(4);
		const apcs = kittyApcs(lines.join(""));
		expect(apcs.length).toBe(2);

		const transmit = apcs.find(p => p.a === "t");
		const placement = apcs.find(p => p.a === "p");
		expect(transmit).toBeDefined();
		expect(placement).toBeDefined();
		expect(transmit?.f).toBe("100");
		expect(transmit?.i).toBe("77");
		expect(placement?.U).toBe("1");
		expect(placement?.i).toBe("77");
		expect(placement?.c).toBe("4");
		expect(placement?.r).toBe("4");

		// Placeholder cells: U+10EEEE grid occupies the lines (real text cells the
		// TUI can slice/repaint/erase like any other text row).
		for (const line of lines) {
			expect(line.includes("\u{10eeee}")).toBe(true);
		}
	});

	it("re-render with the same id re-emits a byte-identical placement and no payload", () => {
		const first = renderImage(BASE64_ONE_PIXEL_PNG, SQUARE_DIMENSIONS, {
			imageId: 42,
			includeTransmit: true,
		});
		const again = renderImage(BASE64_ONE_PIXEL_PNG, SQUARE_DIMENSIONS, {
			imageId: 42,
			includeTransmit: false,
		});

		const firstPlacement = (first?.lines ?? [""])[0] ?? "";
		const againPlacement = (again?.lines ?? [""])[0] ?? "";
		// Placement APC byte-identical → idempotent re-emission (replace, not stack).
		// The placement APC substring must be byte-identical → idempotent
		// re-emission (replace, not stack); the first render additionally
		// prefixes the one-time transmit.
		const placementOf = (line: string) => /\x1b_Ga=p[^\\]*\x1b\\/.exec(line)?.[0] ?? "";
		expect(placementOf(againPlacement)).not.toBe("");
		expect(placementOf(againPlacement)).toBe(placementOf(firstPlacement));
		expect(kittyApcs(again?.lines?.join("") ?? "").some(p => p.a === "t")).toBe(false);
	});

	it("acquireStableImageId returns the same id for the same key across re-creations", () => {
		expect(acquireStableImageId("tool:call-1:0")).toBe(acquireStableImageId("tool:call-1:0"));
		expect(acquireStableImageId("tool:call-1:0")).not.toBe(acquireStableImageId("tool:call-1:1"));
	});

	it("component rebuild from the same imageKey transmits once and never stacks a duplicate", async () => {
		await withCleanEnv(async () => {
			const term = new VirtualTerminal(40, 12, 4000);
			const tui = new TUI(term);
			const image = new Image(
				BASE64_ONE_PIXEL_PNG,
				"image/png",
				{ fallbackColor: (s: string) => s },
				{ imageKey: "tool:abc:0" },
			);
			tui.addChild(image);
			try {
				// Capture from BEFORE the first frame so the whole session's bytes are
				// audited: initial paint + a transcript rebuild (same logical image).
				const writes = capture(term);
				tui.start();
				await settle(term);
				await settle(term);

				// Simulate the rebuild a resize/clear triggers: brand-new component,
				// same logical image key.
				tui.removeChild(image);
				const rebuilt = new Image(
					BASE64_ONE_PIXEL_PNG,
					"image/png",
					{ fallbackColor: (s: string) => s },
					{ imageKey: "tool:abc:0" },
				);
				tui.addChild(rebuilt);
				tui.requestRender();
				await settle(term);
				await settle(term);

				const bytes = writes.join("");
				const apcs = kittyApcs(bytes);
				expect(apcs.length).toBeGreaterThan(0);

				// Every kitty APC carries the SAME stable id, and the payload goes out
				// exactly ONCE (a=t). A rebuilt component rebinds by id; the TUI's own
				// diff makes the follow-up frame a noop because placeholder cells are
				// ordinary text identical to what is already on screen.
				// (Baseline anonymous a=T has no i= at all and re-transmits on every
				// pass — this assertion fails there.)
				const ids = new Set(apcs.map(p => p.i).filter(Boolean));
				expect(ids.size).toBe(1);
				for (const p of apcs) {
					expect(p.a === "t" || (p.a === "p" && p.U === "1")).toBe(true);
					expect(p.i).toBeDefined();
				}
				expect(apcs.filter(p => p.a === "t").length).toBe(1);
				expect(bytes).not.toContain("a=T,");

				// The visible block is the placeholder text grid.
				expect(bytes.includes("\u{10eeee}")).toBe(true);
			} finally {
				tui.stop();
			}
		});
	});
});

async function settle(term: VirtualTerminal): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
	await Bun.sleep(20);
	await term.flush();
}

function capture(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	(term as unknown as { write: (s: string) => void }).write = (data: string) => {
		writes.push(data);
		realWrite(data);
	};
	return writes;
}

async function withCleanEnv<T>(run: () => T | Promise<T>): Promise<T> {
	const keys = [
		"TMUX",
		"STY",
		"ZELLIJ",
		"TERMUX_VERSION",
		"PI_NO_KITTY_PLACEHOLDERS",
		"PI_KITTY_PLACEHOLDERS",
		"PI_FORCE_IMAGE_PROTOCOL",
	] as const;
	const saved = new Map<string, string | undefined>();
	for (const key of keys) {
		saved.set(key, process.env[key]);
		delete process.env[key];
		(Bun.env as Record<string, string | undefined>)[key] = undefined;
	}
	try {
		return await run();
	} finally {
		for (const key of keys) {
			const value = saved.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
			(Bun.env as Record<string, string | undefined>)[key] = value;
		}
	}
}
