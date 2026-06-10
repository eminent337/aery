/**
 * Module-level state for the Ferment extension.
 * One active ferment per process.
 */

import type { Ferment } from "../types.js";

let activeFerment: Ferment | undefined;
let continuationPolicy: "automated" | "manual" = "manual";

export function getActive(): Ferment | undefined {
	return activeFerment;
}

export function setActive(ferment: Ferment | undefined): void {
	activeFerment = ferment;
}

export function getContinuationPolicy(): "automated" | "manual" {
	return continuationPolicy;
}

export function setContinuationPolicy(policy: "automated" | "manual"): void {
	continuationPolicy = policy;
}

export function getActiveId(): string | undefined {
	return activeFerment?.id;
}

/** Clear the active ferment reference. */
export function clearActive(): void {
	activeFerment = undefined;
}

/** Number of completed turns in the current session. */
let turnCount = 0;

export function getTurnCount(): number {
	return turnCount;
}

export function setTurnCount(count: number): void {
	turnCount = count;
}

export function incrementTurnCount(): void {
	turnCount++;
}

export function resetTurnCount(): void {
	turnCount = 0;
}
