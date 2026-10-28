import { describe, expect, test } from "bun:test";
import {
	beginGlide,
	endGlide,
	finalActionHit,
	glideInFlight,
	guardrailRefusal,
	looksLikePasswordPrompt,
	rememberClickTargets,
	rememberOcrText,
	restrictedAppHit,
	restrictedAppRefusal,
	validateInjection,
} from "../desktop-control";

const FRAME = { scaledW: 1280, scaledH: 800, kind: "window", address: "win1" };

describe("final-action guardrails (fail-closed)", () => {
	test("denylist hits whole-word labels", () => {
		expect(finalActionHit("Send")).toBe("send");
		expect(finalActionHit("PAY NOW")).toBe("pay");
		expect(finalActionHit("Delete")).toBe("delete");
		expect(finalActionHit("Sign out")).toBe("sign out");
	});
	test("token-aware: sender/submission don't trip", () => {
		expect(finalActionHit("Sender")).toBeNull();
		expect(finalActionHit("Submission form")).toBeNull();
		expect(finalActionHit("Inbox")).toBeNull();
		expect(finalActionHit("")).toBeNull();
	});
	test("live_click on a final-action target is refused", () => {
		const refusal = guardrailRefusal("live_click", { target: "Send" });
		expect(refusal).toContain("Refused");
		expect(refusal).toContain("send");
	});
	test("live_click on a benign target proceeds", () => {
		expect(guardrailRefusal("live_click", { target: "Compose" })).toBeNull();
		expect(guardrailRefusal("live_move", {})).toBeNull();
	});
	test("live_type naming a final action is refused", () => {
		const refusal = guardrailRefusal("live_type", { keys: "please pay now" });
		expect(refusal).toContain("pay");
	});
	test("password-prompt context refuses live_type", () => {
		rememberOcrText("Enter your password to continue");
		expect(looksLikePasswordPrompt("Enter your password")).toBe(true);
		const refusal = guardrailRefusal("live_type", { keys: "hello world" });
		expect(refusal).toContain("password");
		// …but live_key chords (Tab/Return navigation) still work.
		expect(guardrailRefusal("live_key", { keys: "Tab" })).toBeNull();
		// benign screen: typing proceeds
		rememberOcrText("Inbox — 3 messages");
		expect(guardrailRefusal("live_type", { keys: "hello world" })).toBeNull();
	});
});

describe("restricted-app guardrails (terminals)", () => {
	test("terminal classes hit", () => {
		expect(restrictedAppHit("kitty")).toBe("kitty");
		expect(restrictedAppHit("Alacritty")).toBe("alacritty");
		expect(restrictedAppHit("org.gnome.Terminal")).toBe("terminal");
		expect(restrictedAppHit(undefined)).toBeNull();
	});
	test("browsers and editors don't hit", () => {
		expect(restrictedAppHit("brave")).toBeNull();
		expect(restrictedAppHit("firefox")).toBeNull();
		expect(restrictedAppHit("Code")).toBeNull();
	});
	test("live_type/live_click into kitty are refused", () => {
		const win = { class: "kitty", title: "aery TUI" };
		expect(restrictedAppRefusal("live_type", win)).toContain("bash tool");
		expect(restrictedAppRefusal("live_click", win)).toContain("kitty");
	});
	test("move/key/scroll into a terminal stay allowed", () => {
		const win = { class: "kitty", title: "aery TUI" };
		expect(restrictedAppRefusal("live_move", win)).toBeNull();
		expect(restrictedAppRefusal("live_key", win)).toBeNull();
		expect(restrictedAppRefusal("live_scroll", win)).toBeNull();
	});
	test("typing into a browser proceeds", () => {
		expect(restrictedAppRefusal("live_type", { class: "brave", title: "Gmail" })).toBeNull();
	});
});

describe("validateInjection (fail-closed, pre-injection)", () => {
	test("in-bounds pointer action passes with resolved coords", () => {
		const v = validateInjection({ action: "live_move", x: 100, y: 200, frame: FRAME, focusedAddress: "win1" });
		expect(v.ok).toBe(true);
		if (v.ok) {
			expect(v.tx).toBe(100);
			expect(v.ty).toBe(200);
		}
	});
	test("no frame refuses pointer actions", () => {
		const v = validateInjection({ action: "live_click", x: 10, y: 10, frame: null, focusedAddress: "win1" });
		expect(v).toMatchObject({ ok: false, code: "no_frame" });
	});
	test("stale frame refuses", () => {
		const v = validateInjection({ action: "live_move", x: 1, y: 1, frame: FRAME, focusedAddress: "other" });
		expect(v).toMatchObject({ ok: false, code: "frame_stale" });
	});
	test("out-of-bounds coordinates refuse", () => {
		const v = validateInjection({ action: "live_click", x: 2000, y: 900, frame: FRAME, focusedAddress: "win1" });
		expect(v).toMatchObject({ ok: false, code: "out_of_bounds" });
		const neg = validateInjection({ action: "live_click", x: -5, y: 10, frame: FRAME, focusedAddress: "win1" });
		expect(neg).toMatchObject({ ok: false, code: "out_of_bounds" });
	});
	test("out-of-bounds drag end refuses", () => {
		const v = validateInjection({
			action: "live_drag",
			x: 10,
			y: 10,
			x2: 9999,
			y2: 10,
			frame: FRAME,
			focusedAddress: "win1",
		});
		expect(v).toMatchObject({ ok: false, code: "out_of_bounds" });
	});
	test("missing drag end refuses", () => {
		const v = validateInjection({ action: "live_drag", x: 10, y: 10, frame: FRAME, focusedAddress: "win1" });
		expect(v).toMatchObject({ ok: false, code: "missing_xy2" });
	});
	test("target resolution through remembered click targets", () => {
		rememberClickTargets([{ text: "Compose", x: 100, y: 200, w: 120, h: 30, confidence: 0.9 }]);
		const v = validateInjection({ action: "live_click", target: "compose", frame: FRAME, focusedAddress: "win1" });
		expect(v.ok).toBe(true);
		if (v.ok) {
			expect(v.tx).toBe(160); // 100 + 120/2
			expect(v.ty).toBe(215);
		}
	});
	test("guardrail refusal wins before bounds checks", () => {
		const v = validateInjection({
			action: "live_click",
			target: "Send",
			x: 10,
			y: 10,
			frame: FRAME,
			focusedAddress: "win1",
		});
		expect(v).toMatchObject({ ok: false, code: "guardrail_refusal" });
	});
	test("keyboard payloads are required", () => {
		expect(validateInjection({ action: "live_type", frame: FRAME, focusedAddress: "win1" })).toMatchObject({
			ok: false,
			code: "missing_text",
		});
		expect(validateInjection({ action: "live_key", frame: FRAME, focusedAddress: "win1" })).toMatchObject({
			ok: false,
			code: "missing_keys",
		});
		expect(validateInjection({ action: "live_key", keys: "Return", frame: FRAME, focusedAddress: "win1" }).ok).toBe(
			true,
		);
	});
});

describe("glide-in-flight refusal (D002: never inject into a moving pointer)", () => {
	// Same-turn calls dispatch as "shared" and never wait on each other, so a
	// click/type can arrive while a path glide still owns the pointer. The
	// press would land mid-path, at a coordinate the model never chose.
	test("click refuses while a glide holds the pointer", () => {
		beginGlide();
		try {
			const v = validateInjection({ action: "live_click", x: 100, y: 100, frame: FRAME, focusedAddress: "win1" });
			expect(v).toMatchObject({ ok: false, code: "glide_in_flight" });
			if (!v.ok) expect(v.error).toContain("mid-path");
		} finally {
			endGlide();
		}
	});
	test("type and key refuse too — every press is blocked, not just clicks", () => {
		beginGlide();
		try {
			expect(
				validateInjection({ action: "live_type", keys: "hello", frame: FRAME, focusedAddress: "win1" }),
			).toMatchObject({
				ok: false,
				code: "glide_in_flight",
			});
			expect(
				validateInjection({ action: "live_key", keys: "Return", frame: FRAME, focusedAddress: "win1" }),
			).toMatchObject({
				ok: false,
				code: "glide_in_flight",
			});
		} finally {
			endGlide();
		}
	});
	test("the pointer itself stays legal — a second glide must not deadlock", () => {
		beginGlide();
		try {
			expect(
				validateInjection({ action: "live_move", x: 100, y: 100, frame: FRAME, focusedAddress: "win1" }).ok,
			).toBe(true);
		} finally {
			endGlide();
		}
	});
	test("overlapping glides need matching releases (counter, not boolean)", () => {
		beginGlide();
		beginGlide();
		endGlide();
		// Still held: a boolean would have cleared the first glide's hold here
		// and let a press through mid-glide.
		expect(glideInFlight()).toBe(true);
		const v = validateInjection({ action: "live_click", x: 100, y: 100, frame: FRAME, focusedAddress: "win1" });
		expect(v).toMatchObject({ ok: false, code: "glide_in_flight" });
		endGlide();
		expect(glideInFlight()).toBe(false);
		expect(validateInjection({ action: "live_click", x: 100, y: 100, frame: FRAME, focusedAddress: "win1" }).ok).toBe(
			true,
		);
	});
	test("an extra release can never go negative", () => {
		endGlide();
		endGlide();
		expect(glideInFlight()).toBe(false);
	});
});
