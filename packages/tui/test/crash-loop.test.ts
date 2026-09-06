import { describe, expect, it } from "bun:test";
import { setKittyGraphics } from "../src/kitty-graphics";
import { ImageProtocol, setCellDimensions, setTerminalImageProtocol } from "../src/terminal-capabilities";
import { type Component, TUI } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";

class HugeChild implements Component {
	constructor(private readonly n: number) {}
	invalidate(): void {}
	render(_width: number): string[] {
		return Array.from({ length: this.n }, (_, i) => `line-${i}`);
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
	await Bun.sleep(20);
	await term.flush();
}

function withKittyEnv(): void {
	for (const key of ["TMUX", "STY", "ZELLIJ", "TERMUX_VERSION"]) {
		delete process.env[key];
		(Bun.env as Record<string, string | undefined>)[key] = undefined;
	}
	process.env.KITTY_WINDOW_ID = "1";
	process.env.TERM = "xterm-kitty";
}

describe("render loop safety: huge child line arrays", () => {
	it("aggregates a >1M-line child via loop-push without RangeError (spread-push regression)", async () => {
		withKittyEnv();
		setCellDimensions({ widthPx: 10, heightPx: 20 });
		setKittyGraphics({ unicodePlaceholders: true });
		setTerminalImageProtocol(ImageProtocol.Kitty);

		const term = new VirtualTerminal(100, 30, 4000000);
		const tui = new TUI(term);
		tui.addChild(new HugeChild(1_005_000));
		tui.start();
		await settle(term);
		tui.stop();
		// The crash was a RangeError thrown during aggregate render of a large
		// child array; the loop-push builds the frame instead. The viewport is
		// still bounded by terminal height even for a giant child.
		expect(term.getViewport().length).toBe(30);
	}, 120_000);
});
