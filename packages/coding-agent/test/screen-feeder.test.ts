import { describe, expect, it } from "bun:test";
import { LiveScreenFeeder } from "../src/voice/screen-feeder";

describe("LiveScreenFeeder", () => {
	it("initializes with default options and clamps fps", () => {
		const feeder = new LiveScreenFeeder({ fps: 0.01 });
		expect(feeder.isRunning).toBe(false);

		const feederFast = new LiveScreenFeeder({ fps: 10 });
		expect(feederFast.isRunning).toBe(false);
	});

	it("computes sample hash deterministically", () => {
		const feeder = new LiveScreenFeeder();
		const buf1 = Buffer.from("test png data payload 1234567890abcdef");
		const buf2 = Buffer.from("test png data payload 1234567890abcdef");
		const buf3 = Buffer.from("different data 1234567890abcdefghijklm");

		// @ts-expect-error private method test
		const hash1 = feeder.computeSampleHash(buf1);
		// @ts-expect-error private method test
		const hash2 = feeder.computeSampleHash(buf2);
		// @ts-expect-error private method test
		const hash3 = feeder.computeSampleHash(buf3);

		expect(hash1).toBe(hash2);
		expect(hash1).not.toBe(hash3);
	});

	it("starts and stops cleanly", () => {
		const feeder = new LiveScreenFeeder({ fps: 1 });
		feeder.start();
		expect(feeder.isRunning).toBe(true);
		feeder.stop();
		expect(feeder.isRunning).toBe(false);
	});
});
