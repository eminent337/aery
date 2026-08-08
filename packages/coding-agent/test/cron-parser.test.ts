/**
 * Cron Parser Tests
 */

import { describe, expect, it } from "bun:test";
import { parseCronSchedule, formatCronSchedule, formatNextRun } from "../src/cron/parser.js";

describe("CronParser", () => {
	describe("parseCronSchedule", () => {
		it("should parse 'every 5m'", () => {
			const result = parseCronSchedule("every 5m");
			expect(result.description).toBe("every 5m");
			expect(result.nextRunAt).toBeGreaterThan(Date.now());
		});

		it("should parse 'every 1h'", () => {
			const result = parseCronSchedule("every 1h");
			expect(result.description).toBe("every 1h");
			expect(result.nextRunAt).toBeGreaterThan(Date.now());
		});

		it("should parse 'every 2d'", () => {
			const result = parseCronSchedule("every 2d");
			expect(result.description).toBe("every 2d");
			expect(result.nextRunAt).toBeGreaterThan(Date.now());
		});

		it("should parse 'hourly'", () => {
			const result = parseCronSchedule("hourly");
			expect(result.description).toBe("hourly");
		});

		it("should parse 'daily'", () => {
			const result = parseCronSchedule("daily");
			expect(result.description).toBe("daily");
		});

		it("should throw for invalid schedule", () => {
			expect(() => parseCronSchedule("invalid")).toThrow();
		});
	});

	describe("formatCronSchedule", () => {
		it("should format schedule", () => {
			expect(formatCronSchedule("every 5m")).toBe("every 5m");
			expect(formatCronSchedule("hourly")).toBe("hourly");
		});
	});

	describe("formatNextRun", () => {
		it("should format near future", () => {
			const nextRun = Date.now() + 5 * 60 * 1000;
			const result = formatNextRun(nextRun);
			// Allow 1 minute tolerance due to timing
			expect(result).toMatch(/in \d+m/);
		});

		it("should format future hours", () => {
			const nextRun = Date.now() + 2 * 60 * 60 * 1000;
			const result = formatNextRun(nextRun);
			expect(result).toMatch(/in \d+h/);
		});

		it("should format past as now", () => {
			const nextRun = Date.now() - 1000;
			expect(formatNextRun(nextRun)).toBe("now");
		});
	});
});
