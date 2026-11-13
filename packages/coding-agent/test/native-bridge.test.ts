import { describe, expect, it } from "bun:test";
import {
	resolveBackend,
	resolveBackendChain,
	type BackendProbe,
} from "../src/tools/live-input";
import {
	resolveWlrootsBridge,
	resolveGnomeBridge,
	resolveKwinBridge,
	resolveX11Bridge,
	resolveActiveLinuxBridge,
	runBridgeJson,
	bridgePointerMoveArgs,
	bridgePointerClickArgs,
	bridgePointerScrollArgs,
	bridgePointerDragArgs,
	bridgeKeySequenceArgs,
	bridgeTypeTextArgs,
	bridgeScreenshotArgs,
	bridgeZoomArgs,
	bridgeWindowsArgs,
	bridgeFrontmostAppArgs,
	bridgeActivateWindowArgs,
} from "../src/tools/native-bridge";

describe("Native Wayland/Linux Bridge Dispatcher", () => {
	it("discovers wlroots-bridge on the host system", () => {
		const bin = resolveWlrootsBridge();
		expect(bin).not.toBeNull();
		expect(typeof bin).toBe("string");
		expect(bin?.includes("wlroots-bridge")).toBe(true);
	});

	it("discovers gnome-portal-bridge, kwin-portal-bridge, and x11-bridge", () => {
		const gnomeBin = resolveGnomeBridge();
		expect(gnomeBin).not.toBeNull();
		const kwinBin = resolveKwinBridge();
		expect(kwinBin).not.toBeNull();
		expect(kwinBin?.includes("kwin-portal-bridge")).toBe(true);
		const x11Bin = resolveX11Bridge();
		expect(x11Bin).not.toBeNull();
	});

	it("resolves active Linux bridge based on desktop environment", () => {
		const wlrootsRes = resolveActiveLinuxBridge({
			HYPRLAND_INSTANCE_SIGNATURE: "mock_hypr",
		});
		expect(wlrootsRes).not.toBeNull();
		expect(wlrootsRes?.type).toBe("wlroots");

		const gnomeRes = resolveActiveLinuxBridge({
			XDG_CURRENT_DESKTOP: "GNOME",
			WAYLAND_DISPLAY: "wayland-0",
		});
		expect(gnomeRes).not.toBeNull();
		expect(gnomeRes?.type).toBe("gnome");

		const kwinRes = resolveActiveLinuxBridge({
			XDG_CURRENT_DESKTOP: "KDE",
			WAYLAND_DISPLAY: "wayland-0",
		});
		expect(kwinRes).not.toBeNull();
		expect(kwinRes?.type).toBe("kwin");

		const x11Res = resolveActiveLinuxBridge({
			XDG_SESSION_TYPE: "x11",
			DISPLAY: ":0",
		});
		expect(x11Res).not.toBeNull();
		expect(x11Res?.type).toBe("x11");
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

		expect(bridgeWindowsArgs()).toEqual(["windows"]);
		expect(bridgeFrontmostAppArgs()).toEqual(["frontmost-app"]);
		expect(bridgeActivateWindowArgs("4278190084")).toEqual(["activate-window", "--window", "4278190084"]);
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
		try {
			const res = await runBridgeJson<{ base64?: string; width?: number; height?: number }>(bin, bridgeScreenshotArgs());
			expect(res.base64).toBeDefined();
			expect(typeof res.base64).toBe("string");
			const buf = Buffer.from(res.base64!, "base64");
			expect(buf.length).toBeGreaterThan(1000);
		} catch (err: any) {
			// On some virtual displays / idle frames, screencopy may yield no ready event
			if (String(err).includes("screencopy did not complete")) {
				return;
			}
			throw err;
		}
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

	it("queries foreign toplevel windows and frontmost app via wlroots-bridge", async () => {
		const bin = resolveWlrootsBridge();
		if (!bin) return;
		const winList = await runBridgeJson<Array<{ id: string; title?: string }>>(bin, bridgeWindowsArgs());
		expect(Array.isArray(winList)).toBe(true);
		expect(winList.length).toBeGreaterThan(0);
		expect(winList[0].id).toBeDefined();

		const front = await runBridgeJson<{ bundleId?: string; displayName?: string }>(bin, bridgeFrontmostAppArgs());
		expect(front).toBeDefined();
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
		const backend = resolveBackend(mockProbe, false, "pointer", "linux");
		expect(backend).toBe("wlroots-bridge");

		const pointerChain = resolveBackendChain(mockProbe, false, "pointer", "linux");
		expect(pointerChain[0]).toBe("wlroots-bridge");
		expect(pointerChain).toContain("ydotool");

		const keyChain = resolveBackendChain(mockProbe, false, "keyboard", "linux");
		expect(keyChain[0]).toBe("wlroots-bridge");
		expect(keyChain).toContain("ydotool");
		expect(keyChain).toContain("wtype");
	});

	it("resolves backend chain with activeBridge on GNOME and KDE Plasma", () => {
		const gnomeProbe: BackendProbe = {
			activeBridge: {
				bin: "/usr/lib/claude-desktop-bin/resources/gnome-portal-bridge",
				type: "gnome",
				timeoutMs: 30000,
			},
			ydotool: true,
			ydotoold: true,
			xdotool: false,
			wtype: false,
		};
		expect(resolveBackend(gnomeProbe, false, "pointer", "linux")).toBe("native-bridge");
		expect(resolveBackendChain(gnomeProbe, false, "pointer", "linux")[0]).toBe("native-bridge");
		expect(resolveBackendChain(gnomeProbe, false, "keyboard", "linux")[0]).toBe("native-bridge");

		const kwinProbe: BackendProbe = {
			activeBridge: {
				bin: "/usr/lib/claude-desktop-bin/resources/kwin-portal-bridge",
				type: "kwin",
				timeoutMs: 20000,
			},
			ydotool: false,
			ydotoold: false,
			xdotool: false,
			wtype: false,
		};
		expect(resolveBackend(kwinProbe, false, "type", "linux")).toBe("native-bridge");
		expect(resolveBackendChain(kwinProbe, false, "type", "linux")).toEqual(["native-bridge"]);
	});
});
