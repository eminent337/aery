import { describe, expect, it } from "bun:test";
import {
	resolveWlrootsBridge,
	resolveGnomeBridge,
	resolveX11Bridge,
	runBridgeJson,
	bridgePointerMoveArgs,
	bridgePointerClickArgs,
	bridgePointerScrollArgs,
	bridgePointerDragArgs,
	bridgeKeySequenceArgs,
	bridgeTypeTextArgs,
	bridgeScreenshotArgs,
	bridgeZoomArgs,
} from "../src/tools/native-bridge";

describe("Native Wayland/Linux Bridge Dispatcher", () => {
	it("discovers wlroots-bridge on the host system", () => {
		const bin = resolveWlrootsBridge();
		expect(bin).not.toBeNull();
		expect(typeof bin).toBe("string");
		expect(bin?.includes("wlroots-bridge")).toBe(true);
	});

	it("discovers gnome-portal-bridge and x11-bridge", () => {
		const gnomeBin = resolveGnomeBridge();
		expect(gnomeBin).not.toBeNull();
		const x11Bin = resolveX11Bridge();
		expect(x11Bin).not.toBeNull();
	});

	it("builds exact CLI argument vectors for pointer and keyboard commands", () => {
		expect(bridgePointerMoveArgs(100, 250)).toEqual(["pointer-move", "--x", "100", "--y", "250"]);

		expect(bridgePointerClickArgs(100, 250, "right", 2, ["ctrl"])).toEqual([
			"pointer-click",
			"--x",
			"100",
			"--y",
			"250",
			"--button",
			"right",
			"--count",
			"2",
			"--modifier",
			"ctrl",
		]);

		expect(bridgePointerScrollArgs(300, 400, 0, -5)).toEqual([
			"pointer-scroll",
			"--x",
			"300",
			"--y",
			"400",
			"--dx",
			"0",
			"--dy",
			"-5",
		]);

		expect(bridgePointerDragArgs(100, 150, 400, 450)).toEqual([
			"pointer-drag",
			"--from-x",
			"100",
			"--from-y",
			"150",
			"--to-x",
			"400",
			"--to-y",
			"450",
		]);

		expect(bridgeKeySequenceArgs("ctrl+c", 2)).toEqual(["key-sequence", "--keys", "ctrl+c", "--repeat", "2"]);

		expect(bridgeTypeTextArgs("Hello World")).toEqual(["type", "--text", "Hello World"]);

		expect(bridgeScreenshotArgs()).toEqual(["screenshot"]);
		expect(bridgeScreenshotArgs("eDP-1")).toEqual(["screenshot", "--display", "eDP-1"]);

		expect(bridgeZoomArgs(50, 60, 200, 300)).toEqual([
			"zoom",
			"--x",
			"50",
			"--y",
			"60",
			"--w",
			"200",
			"--h",
			"300",
		]);
	});

	it("executes live doctor inspection on wlroots-bridge", async () => {
		const bin = resolveWlrootsBridge();
		if (!bin) return;
		const doc = await runBridgeJson<{ compositor?: string; wayland_display?: string }>(bin, ["doctor"]);
		expect(doc).toBeDefined();
		expect(doc.compositor).toBe("hyprland");
	});
});
