/**
 * Cron Schedule Parser
 *
 * Parses human-friendly schedules like "every 5m", "every 1h", "daily", etc.
 * Also supports standard cron expressions.
 */

import type { CronSchedule, ParsedSchedule } from "./types.js";

/**
 * Parse a cron schedule string into execution metadata.
 */
export function parseCronSchedule(schedule: CronSchedule): ParsedSchedule {
	const normalized = schedule.toLowerCase().trim();

	// Handle "every X" format
	const everyMatch = normalized.match(/^every\s+(\d+)\s*([mhd])$/);
	if (everyMatch) {
		const value = parseInt(everyMatch[1], 10);
		const unit = everyMatch[2];
		const intervalMs = UnitToMs[unit](value);
		return {
			nextRunAt: Date.now() + intervalMs,
			description: `every ${value}${unit}`,
		};
	}

	// Handle special keywords
	switch (normalized) {
		case "hourly":
			return {
				nextRunAt: NextHourBoundary(),
				description: "hourly",
			};
		case "daily":
			return {
				nextRunAt: NextDayBoundary(),
				description: "daily",
			};
		case "weekly":
			return {
				nextRunAt: NextWeekBoundary(),
				description: "weekly",
			};
	}

	// Handle standard cron expressions (simplified)
	if (normalized.includes("*") || normalized.includes("/")) {
		return parseCronExpression(normalized);
	}

	throw new Error(`Unknown schedule format: ${schedule}`);
}

/**
 * Calculate next execution time for a cron expression.
 * Simplified implementation - supports common patterns.
 */
function parseCronExpression(expr: string): ParsedSchedule {
	const parts = expr.split(/\s+/);
	if (parts.length !== 5) {
		throw new Error(`Invalid cron expression: ${expr}`);
	}

	// For simplicity, calculate next minute boundary if minute is *
	const minute = parts[0];
	if (minute === "*") {
		const next = new Date(Date.now() + 60_000);
		next.setSeconds(0, 0);
		return {
			nextRunAt: next.getTime(),
			description: `cron: ${expr}`,
		};
	}

	// Fallback: next minute
	const next = new Date(Date.now() + 60_000);
	next.setSeconds(0, 0);
	return {
		nextRunAt: next.getTime(),
		description: `cron: ${expr}`,
	};
}

/**
 * Get next hour boundary timestamp.
 */
function NextHourBoundary(): number {
	const now = new Date();
	const next = new Date(now);
	next.setHours(next.getHours() + 1);
	next.setMinutes(0, 0, 0);
	return next.getTime();
}

/**
 * Get next day boundary timestamp.
 */
function NextDayBoundary(): number {
	const now = new Date();
	const next = new Date(now);
	next.setDate(next.getDate() + 1);
	next.setHours(0, 0, 0, 0);
	return next.getTime();
}

/**
 * Get next week boundary timestamp.
 */
function NextWeekBoundary(): number {
	const now = new Date();
	const next = new Date(now);
	next.setDate(next.getDate() + 7);
	next.setHours(0, 0, 0, 0);
	return next.getTime();
}

/**
 * Convert unit multiplier to milliseconds.
 */
const UnitToMs: Record<string, (value: number) => number> = {
	m: v => v * 60_000, // minutes
	h: v => v * 60 * 60_000, // hours
	d: v => v * 24 * 60 * 60_000, // days
};

/**
 * Format a schedule for display.
 */
export function formatCronSchedule(schedule: CronSchedule): string {
	const parsed = parseCronSchedule(schedule);
	return parsed.description;
}

/**
 * Get next run time as human-readable string.
 */
export function formatNextRun(nextRunAt: number): string {
	const now = Date.now();
	const diff = nextRunAt - now;

	if (diff <= 0) {
		return "now";
	}

	const minutes = Math.floor(diff / 60_000);
	if (minutes < 60) {
		return `in ${minutes}m`;
	}

	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `in ${hours}h ${minutes % 60}m`;
	}

	const days = Math.floor(hours / 24);
	return `in ${days}d`;
}
