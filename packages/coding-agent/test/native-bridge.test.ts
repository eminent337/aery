import { describe, expect, it } from "bun:test";
import {
	resolveBackend,
	resolveBackendChain,
	type BackendProbe,
} from "../src/tools/live-input";
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

	it("captures full screenshot via wlroots-bridge directly into buffer", async () => {
		const bin = resolveWlrootsBridge();
		if (!bin) return;
		const res = await runBridgeJson<{ base64?: string; width?: number; height?: number }>(bin, bridgeScreenshotArgs());
		expect(res.base64).toBeDefined();
		expect(typeof res.base64).toBe("string");
		const buf = Buffer.from(res.base64!, "base64");
		expect(buf.length).toBeGreaterThan(1000);
	});

	it("captures targeted zoom region via wlroots-bridge directly into buffer", async () => {
		const bin = resolveWlrootsBridge();
		if (!bin) return;
		const res = await runBridgeJson<{ base64?: string; width?: number; height?: number }>(
			bin,
			bridgeZoomArgs(10, 10, 200, 150),
		);
		expect(res.base64).toBeDefined();
		const buf = Buffer.from(res.base64!, "base64");
		expect(buf.length).toBeGreaterThan(500);
	});

	it("resolves backend chain with wlroots-bridge on Wayland", () => {
		const mockProbe: BackendProbe = {
			wlrootsBridge: "/usr/lib/claude-desktop-bin/resources/wlroots-bridge",
			ydotool: true,
			ydotoold: true,
			xdotool: true,
			wtype: true,
			cliclick: false,
			osascript: false,
			powershell: false,
		};
		const backend = resolveBackend(mockProbe, false, false, "linux");
		expect(backend).toBe("wlroots-bridge");

		const pointerChain = resolveBackendChain(mockProbe, "pointer", false, "linux");
		expect(pointerChain[0]).toBe("wlroots-bridge");
		expect(pointerChain).toContain("ydotool");

		const keyChain = resolveBackendChain(mockProbe, "keyboard", false, "linux");
		expect(keyChain[0]).toBe("wlroots-bridge");
		expect(keyChain).toContain("ydotool");
		expect(keyChain).toContain("wtype");
	});
});
