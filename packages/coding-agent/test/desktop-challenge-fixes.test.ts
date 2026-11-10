import { describe, expect, it } from "bun:test";
import { resolveTargetWindow } from "../src/tools/desktop-control";
import { normalizeRole, compactAccessibilityTree } from "../src/tools/desktop-accessibility";
import type { DesktopWindowInfo } from "../src/tools/desktop-control";

describe("Desktop Challenge Solutions", () => {
	const mockWindows: DesktopWindowInfo[] = [
		{
			address: "0x55aa1",
			title: "aryee@thinkpad: ~/brave-repo (kitty)",
			class: "kitty",
			workspace: 1,
			at: [0, 0],
			size: [900, 1080],
			focused: true,
			xwayland: false,
		},
		{
			address: "0x55aa2",
			title: "Google Antigravity Authentication - Brave",
			class: "brave-browser",
			workspace: 2,
			at: [900, 0],
			size: [1020, 1080],
			focused: false,
			xwayland: false,
		},
		{
			address: "0x55aa3",
			title: "LinkedIn: Log In or Sign Up - Brave",
			class: "brave-browser",
			workspace: 2,
			at: [900, 0],
			size: [1020, 1080],
			focused: false,
			xwayland: false,
		},
		{
			address: "0x55aa4",
			title: "Word Documents - Files",
			class: "org.gnome.Nautilus",
			workspace: 3,
			at: [100, 100],
			size: [800, 600],
			focused: false,
			xwayland: false,
		},
	];

	describe("resolveTargetWindow (Challenge 4 - Window targeting and focus ambiguity)", () => {
		it("resolves exact address match directly", () => {
			const res = resolveTargetWindow(mockWindows, "0x55aa2");
			expect(res?.address).toBe("0x55aa2");
		});

		it("prefers real application over terminal whose title mentions the app", () => {
			// Kitty has "brave-repo" in title, but user wants "brave"
			const res = resolveTargetWindow(mockWindows, "brave");
			expect(res).toBeDefined();
			expect(res?.class).toBe("brave-browser");
			expect(res?.address).toBe("0x55aa2");
		});

		it("finds window by page title keyword while avoiding terminal", () => {
			const res = resolveTargetWindow(mockWindows, "linkedin");
			expect(res).toBeDefined();
			expect(res?.address).toBe("0x55aa3");
		});

		it("finds window using multi-word matching across title and class", () => {
			const res = resolveTargetWindow(mockWindows, "brave linkedin");
			expect(res).toBeDefined();
			expect(res?.address).toBe("0x55aa3");
		});

		it("allows explicitly targeting terminal when query specifies terminal class", () => {
			const res = resolveTargetWindow(mockWindows, "kitty");
			expect(res).toBeDefined();
			expect(res?.class).toBe("kitty");
			expect(res?.address).toBe("0x55aa1");
		});

		it("finds Nautilus window using friendly or title match", () => {
			const res = resolveTargetWindow(mockWindows, "nautilus");
			expect(res).toBeDefined();
			expect(res?.address).toBe("0x55aa4");

			const resTitle = resolveTargetWindow(mockWindows, "word documents");
			expect(resTitle).toBeDefined();
			expect(resTitle?.address).toBe("0x55aa4");
		});

		it("returns undefined when query matches nothing", () => {
			const res = resolveTargetWindow(mockWindows, "nonexistent-app-xyz");
			expect(res).toBeUndefined();
		});
	});

	describe("normalizeRole (Challenge 2 - Role/name matching quirks)", () => {
		it("maps common UI shorthand to standard AT-SPI roles", () => {
			expect(normalizeRole("btn")).toBe("button");
			expect(normalizeRole("button")).toBe("button");
			expect(normalizeRole("input")).toBe("textfield");
			expect(normalizeRole("entry")).toBe("textfield");
			expect(normalizeRole("check")).toBe("checkbox");
			expect(normalizeRole("chk")).toBe("checkbox");
			expect(normalizeRole("win")).toBe("window");
		});

		it("preserves already canonical roles", () => {
			expect(normalizeRole("menuitem")).toBe("menuitem");
			expect(normalizeRole("table")).toBe("table");
			expect(normalizeRole(undefined)).toBeUndefined();
		});
	});

	describe("compactAccessibilityTree (Challenge 9 - Output size and usability)", () => {
		it("prunes redundant empty intermediate container wrappers while keeping actionable children", () => {
			const tree = {
				role: "window",
				name: "Brave Window",
				children: [
					{
						role: "group",
						children: [
							{
								role: "group",
								children: [
									{
										role: "button",
										name: "Reload",
										ref_id: "@s1:e10",
										available_actions: ["Click"],
									},
								],
							},
						],
					},
				],
			};

			const compacted = compactAccessibilityTree(tree);
			expect(compacted).toBeDefined();
			// The deeply nested chain of anonymous empty groups should be collapsed
			expect(compacted.children?.length).toBe(1);
			expect(compacted.children?.[0].ref_id).toBe("@s1:e10");
			expect(compacted.children?.[0].name).toBe("Reload");
		});

		it("preserves named groups and groups with ref_ids", () => {
			const tree = {
				role: "group",
				name: "Navigation Bar",
				children: [
					{
						role: "button",
						name: "Back",
						ref_id: "@s1:e1",
					},
				],
			};

			const compacted = compactAccessibilityTree(tree);
			expect(compacted.name).toBe("Navigation Bar");
			expect(compacted.children?.length).toBe(1);
		});
	});
});
