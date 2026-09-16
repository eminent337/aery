// Shared on-screen OCR helper ("Live Eye reading tier").
//
// Extracted from the desktop-control `live_eye` OCR path so both the tool and
// the ambient Screen Vision attach (voice/input turns) use the SAME proven
// tesseract tuning on this box:
//   - OMP_THREAD_LIMIT=1 is decisive: tesseract's OpenMP thread contention
//     HANGS multi-threaded runs on big window PNGs (30s+ timeouts). Single-
//     threaded LSTM finishes in ~1-2s.
//   - --oem 1 keeps the accurate LSTM engine.
//   - --psm 6 assumes a uniform text block.
//   - Adaptive: a native-size pass first (fast path); only when it comes back
//     sparse (<20 non-whitespace chars) and the frame is <1200px wide, upscale
//     2x and retry, keeping whichever pass reads more.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** One OCR word and its bounding box in the frame's native pixel space.
 *  Click-target primitive: the model matches `text` to a UI label, then
 *  passes the box to live_move/live_click. (Agent-S s3 / waywarp pattern:
 *  tesseract TSV word boxes, not a vision model.) */
export interface OcrWordBox {
	text: string;
	x: number;
	y: number;
	w: number;
	h: number;
	confidence: number;
}

export interface OcrFrameResult {
	text: string;
	error?: string;
	mode: "native" | "upscaled";
	ms: number;
	/** Word-level boxes in native frame pixels (present when TSV was run). */
	words?: OcrWordBox[];
}

async function runCmd(
	cmd: string,
	args: string[],
	options: { env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
	try {
		const { stdout, stderr } = await execFileAsync(cmd, args, {
			env: { ...process.env, ...options.env },
			timeout: options.timeout ?? 10_000,
		});
		return { stdout: stdout.trim(), stderr: stderr.trim(), code: 0 };
	} catch (err: unknown) {
		const error = err as { stdout?: string; stderr?: string; code?: number; message: string };
		return {
			stdout: error.stdout?.trim() || "",
			stderr: error.stderr?.trim() || error.message,
			code: error.code ?? 1,
		};
	}
}

async function identifyDims(filePath: string): Promise<[number, number] | null> {
	const res = await runCmd("identify", ["-format", "%w %h", filePath]);
	if (res.code !== 0) return null;
	const m = res.stdout.trim().split(/\s+/).map(Number);
	return m.length === 2 && Number.isFinite(m[0]) && Number.isFinite(m[1]) && m[0] > 0 && m[1] > 0
		? [m[0], m[1]]
		: null;
}

function nonWs(text: string): number {
	return text.replace(/\s/g, "").length;
}

/** Thread env for tesseract. Single-threaded (OMP_THREAD_LIMIT=1) is the
 *  proven tuning on this 4-core box: 2 threads tie (~1.55s), 3+ threads
 *  contend badly (~2.3s OMP=3, ~7s OMP=4). OCR_FAST is accepted but
 *  currently maps to the same single-threaded value; keep it for a future
 *  box with more cores. */
function ocrThreadEnv(): NodeJS.ProcessEnv {
	return { OMP_THREAD_LIMIT: "1" };
}

/** Run tesseract TSV on one image file. Engine (--oem 1) and layout (--psm
 *  6) stay fixed. TSV yields word-level bounding boxes (the clickable-OCR
 *  primitive); this pass's stdout text is NOT used for the reading — the
 *  plain runTess pass owns the text layer. */
async function runTessTsv(
	imgPath: string,
	opts: { lang?: string; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; code: number }> {
	return runCmd("tesseract", [imgPath, "stdout", "--oem", "1", "-l", opts.lang ?? "eng", "--psm", "6", "tsv"], {
		timeout: opts.timeoutMs ?? 30_000,
		env: ocrThreadEnv(),
	});
}

/**
 * Parse tesseract TSV into word boxes. TSV columns:
 * level page block par line word left top width height conf text.
 * Level-5 rows are words; conf is 0..100 (-1 on skipped rows). Coordinates
 * come back in the image's own pixel space; `divisor` folds an upscaled
 * pass back to native pixels. Rows with empty text, non-finite or
 * non-positive geometry are dropped.
 */
export function parseTsvWordBoxes(tsv: string, divisor = 1): OcrWordBox[] {
	const boxes: OcrWordBox[] = [];
	const lines = tsv.split("\n");
	for (const line of lines.slice(1)) {
		const cols = line.split("\t");
		if (cols.length < 12) continue;
		if (Number(cols[0]) !== 5) continue;
		const text = (cols[11] ?? "").trim();
		const conf = Number(cols[10]);
		const left = Number(cols[6]);
		const top = Number(cols[7]);
		const width = Number(cols[8]);
		const height = Number(cols[9]);
		if (!text) continue;
		if (![left, top, width, height, conf].every(Number.isFinite)) continue;
		if (width <= 0 || height <= 0 || conf < 0) continue;
		const d = divisor > 0 ? divisor : 1;
		boxes.push({
			text,
			x: Math.round(left / d),
			y: Math.round(top / d),
			w: Math.max(1, Math.round(width / d)),
			h: Math.max(1, Math.round(height / d)),
			confidence: Math.round(conf) / 100,
		});
	}
	return boxes;
}

async function runTess(
	imgPath: string,
	opts: { lang?: string; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; code: number }> {
	return runCmd("tesseract", [imgPath, "stdout", "--oem", "1", "-l", opts.lang ?? "eng", "--psm", "6"], {
		timeout: opts.timeoutMs ?? 30_000,
		env: ocrThreadEnv(),
	});
}

/**
 * OCR a captured frame. Adaptive: native first, then a 2x upscaled retry only
 * when the first pass is sparse (<20 non-ws chars) AND the frame is <1200px
 * wide. Keeps whichever pass reads more. Returns text ('' when none/error),
 * the mode used, timing, and an error string when tesseract is missing/fails.
 */
export async function ocrFrame(
	imgPath: string,
	opts: { lang?: string; timeoutMs?: number } = {},
): Promise<OcrFrameResult> {
	const t0 = Date.now();
	let text = "";
	let error: string | undefined;
	let mode: "native" | "upscaled" = "native";
	let words: OcrWordBox[] | undefined;

	const [res, tsv] = await Promise.all([runTess(imgPath, opts), runTessTsv(imgPath, opts)]);
	if (res.code === 0) {
		text = res.stdout.trim();
	} else {
		error = res.stderr || `tesseract exit ${res.code}`;
	}

	// Word boxes ride on the native pass by default; the upscaled branch
	// below re-runs TSV (divisor 2) only when it wins the text comparison.
	// Text + boxes run concurrently in separate tesseract processes, so the
	// pair costs ~one pass instead of two serial passes.
	if (tsv.code === 0) words = parseTsvWordBoxes(tsv.stdout);

	const sparse = nonWs(text) < 20;
	const dims = await identifyDims(imgPath);
	if (sparse && dims && dims[0] > 0 && dims[0] < 1200 && fs.existsSync(imgPath)) {
		const upscale = path.join(os.tmpdir(), `aerys-screen-ocr-${Date.now()}-2x.png`);
		const up = await runCmd("convert", [imgPath, "-resize", "200%", upscale]);
		if (up.code === 0 && fs.existsSync(upscale)) {
			const upRes = await runTess(upscale, opts);
			if (upRes.code === 0 && nonWs(upRes.stdout.trim()) > nonWs(text)) {
				text = upRes.stdout.trim();
				error = undefined;
				mode = "upscaled";
				// Boxes must land in native pixels: re-run TSV on the upscaled
				// image and fold coords back with divisor 2.
				const upTsv = await runTessTsv(upscale, opts);
				if (upTsv.code === 0) words = parseTsvWordBoxes(upTsv.stdout, 2);
			}
		}
		fs.rm(upscale, { force: true }, () => {});
	}

	return { text, error, mode, ms: Date.now() - t0, ...(words ? { words } : {}) };
}
