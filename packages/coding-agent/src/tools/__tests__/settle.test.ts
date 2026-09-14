import { describe, expect, test } from "bun:test";
import { hashBytes, settle } from "../desktop-control";

describe("settle (drive-loop wait-for-quiet)", () => {
	test("hashBytes is deterministic and discriminating", () => {
		const a = new Uint8Array([1, 2, 3, 4]);
		const b = new Uint8Array([1, 2, 3, 4]);
		const c = new Uint8Array([1, 2, 3, 5]);
		expect(hashBytes(a)).toBe(hashBytes(b));
		expect(hashBytes(a)).not.toBe(hashBytes(c));
		expect(hashBytes(new Uint8Array([]))).toBeTypeOf("string");
	});
	test("settle on a quiet desktop returns quickly with 0 changes", async () => {
		// uiFingerprint degrades gracefully (4s capture timeouts) so this
		// resolves even on a locked/wedged compositor.
		const t0 = Date.now();
		const changes = await settle(400, 50);
		const elapsed = Date.now() - t0;
		expect(changes).toBe(0);
		expect(elapsed).toBeLessThan(12000);
	}, 20000);
});