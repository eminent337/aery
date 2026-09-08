/**
 * AEC Watchdog: self-healing for WebRTC echo-cancel mis-convergence.
 *
 * Evidence (live session 2026-09-07, pid 44088):
 * After the first TTS reply the echo-cancel source occasionally collapses —
 * the WebRTC AEC adaptive filter mis-locks (CPU starvation breaks its delay
 * tracking) and then suppresses the NEAR-END user as if he were echo. Peter's
 * real speech then arrives at 100-250 AC-RMS for minutes while healthy
 * captures deliver 500-5500. Quiet-room ambient through the AEC sits at
 * 22-30 RMS — indistinguishable from the digital floor — so ambient level
 * alone can NOT identify collapse.
 *
 * Reliable signature: the recorder's VAD fired (there WAS speech) but the
 * transcriber's energy measurement comes back weak, repeatedly. Three
 * consecutive weak recordings trigger an echo-cancel filter reload, which
 * re-converges the adaptive filter. Healthy speech resets the counter.
 */

import { spawn } from "node:child_process";
import { logger } from "@aryee337/aery-utils";

const WEAK_THRESHOLD = 350; // AC-RMS below this = weak arrival (speech present but suppressed)
const TRIGGER_COUNT = 3; // consecutive weak recordings before reload
const RELOAD_COOLDOWN_MS = 30_000; // never reload more often than this

let consecutiveWeak = 0;
let lastReloadAt = 0;

function reloadEchoCancel(): void {
	const now = Date.now();
	if (now - lastReloadAt < RELOAD_COOLDOWN_MS) {
		logger.warn("AEC watchdog: reload suppressed by cooldown", { consecutiveWeak });
		return;
	}
	lastReloadAt = now;
	logger.warn("AEC watchdog: reloading echo-cancel filter after repeated weak speech", {
		consecutiveWeak,
	});
	try {
		spawn("pactl", ["unload-module", "module-echo-cancel"], { stdio: "ignore" });
		setTimeout(() => {
			spawn(
				"pactl",
				[
					"load-module",
					"module-echo-cancel",
					"aec_method=webrtc",
					"source_name=echo-cancel-source",
					"sink_name=echo-cancel-sink",
				],
				{ stdio: "ignore" },
			);
			logger.warn("AEC watchdog: echo-cancel filter reloaded");
		}, 1200);
	} catch (err) {
		logger.warn("AEC watchdog: reload failed", { error: String(err) });
	}
}

/**
 * Called by the transcriber after measuring a recording's AC-RMS.
 * - rms >= WEAK_THRESHOLD: healthy speech; reset the counter.
 * - rms < WEAK_THRESHOLD: weak arrival. After TRIGGER_COUNT consecutive weak
 *   recordings, reload the echo-cancel filter.
 * Pure digital-floor silence (< 60) is reported as weak too: the VAD fired,
 * so something spoke — arriving at floor level means suppression.
 */
export function reportAudioEnergy(speechRms: number): void {
	if (speechRms >= WEAK_THRESHOLD) {
		if (consecutiveWeak > 0) {
			logger.debug("AEC watchdog: healthy audio, counter reset", { speechRms });
		}
		consecutiveWeak = 0;
		return;
	}
	consecutiveWeak++;
	logger.warn("AEC watchdog: weak audio on STT input", { speechRms, consecutiveWeak });
	if (consecutiveWeak >= TRIGGER_COUNT) {
		consecutiveWeak = 0;
		reloadEchoCancel();
	}
}

/** Test/diagnostic access. */
export function getWatchdogState(): { consecutiveWeak: number; lastReloadAt: number } {
	return { consecutiveWeak, lastReloadAt };
}
