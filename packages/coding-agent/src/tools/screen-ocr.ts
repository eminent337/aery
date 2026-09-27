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

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileNiced } from "./capture-priority";

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
	/** Canonical 0..1 fraction (parseTsvWordBoxes divides TSV conf by 100).
	 *  Callers MUST NOT rescale — feed through normalizeOcrConfidence instead,
	 *  which folds either scale to 0..1. Rescaling a fraction is exactly how
	 *  every real frame read as motion-smeared on a news page. */
	confidence: number;
	/** TSV structural ids (page/block/par/line) identifying the text line
	 *  this word sits on. Present only when parsed from TSV; used to rebuild
	 *  the reading in order without a second tesseract pass. */
	lineKey?: string;
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
		const { stdout, stderr } = await execFileNiced(cmd, args, {
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
 *
 * The block/par/line ids ride along on each box so the text layer can be
 * rebuilt from the SAME pass (see textFromTsvWords) without re-running
 * tesseract.
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
			lineKey: `${cols[1]}/${cols[2]}/${cols[3]}/${cols[4]}`,
		});
	}
	return boxes;
}

/**
 * Reconstruct the text layer from TSV word boxes.
 *
 * Tesseract's TSV output already carries every recognized word in its text
 * column, so a single TSV pass is enough for BOTH the reading and the click
 * targets — the separate plain-text pass is redundant work. Words are
 * regrouped into lines by their block/par/line ids and ordered top-to-bottom,
 * left-to-right, so the reconstructed text reads like a document rather than
 * an unordered bag of words.
 *
 * Returns '' when there is nothing to reconstruct, so callers can tell
 * "no words" from "reconstruction produced text".
 */
export function textFromTsvWords(boxes: OcrWordBox[]): string {
	if (boxes.length === 0) return "";
	// Group by the TSV line id when present — that is tesseract's own notion
	// of "these words share a text line", which is more reliable than any
	// geometry guess. Boxes synthesized by callers (no lineKey) fall back to
	// a coarse vertical bucket so the function never throws.
	const lines: Array<{ key: string; words: OcrWordBox[] }> = [];
	const byKey = new Map<string, { key: string; words: OcrWordBox[] }>();
	for (const box of boxes) {
		const key = box.lineKey ?? `~${Math.round(box.y / Math.max(1, Math.round(box.h * 0.6)))}`;
		let group = byKey.get(key);
		if (!group) {
			group = { key, words: [] };
			byKey.set(key, group);
			lines.push(group);
		}
		group.words.push(box);
	}
	// Reading order: top-to-bottom, then left-to-right within a line.
	lines.sort((a, b) => a.words[0]!.y - b.words[0]!.y || a.words[0]!.x - b.words[0]!.x);
	return lines
		.map(group =>
			[...group.words]
				.sort((a, b) => a.x - b.x)
				.map(w => w.text)
				.join(" "),
		)
		.filter(line => line.length > 0)
		.join("\n");
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
 * OCR a captured frame. ONE tesseract pass produces BOTH the reading and the
 * click-target boxes: the TSV output already carries every recognized word in
 * its text column, so the text layer is rebuilt from the boxes rather than
 * paid for with a second, redundant plain-text pass.
 *
 * Adaptive: native first, then a 2x upscaled retry only when the first pass
 * is sparse (<20 non-ws chars) AND the frame is <1200px wide. Keeps whichever
 * pass reads more. Returns text ('' when none/error), the mode used, timing,
 * and an error string when tesseract is missing/fails.
 *
 * Failure contract: if the single TSV pass fails outright, one plain-text
 * pass is run as a fallback so a reading is still produced (without boxes).
 * The reading is never silently lost to a speed optimization.
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

	// Single pass: TSV yields the words AND the text layer.
	const tsv = await runTessTsv(imgPath, opts);
	if (tsv.code === 0) {
		words = parseTsvWordBoxes(tsv.stdout);
		text = textFromTsvWords(words);
	} else {
		error = tsv.stderr || `tesseract exit ${tsv.code}`;
		// Fail-safe: the boxes are unavailable, but a reading is still worth
		// one extra pass. Degraded (no click targets), never empty.
		const fallback = await runTess(imgPath, opts);
		if (fallback.code === 0) {
			text = fallback.stdout.trim();
			error = undefined;
		}
	}

	const sparse = nonWs(text) < 20;
	const dims = await identifyDims(imgPath);
	if (sparse && dims && dims[0] > 0 && dims[0] < 1200 && fs.existsSync(imgPath)) {
		const upscale = path.join(os.tmpdir(), `aerys-screen-ocr-${Date.now()}-2x.png`);
		const up = await runCmd("convert", [imgPath, "-resize", "200%", upscale]);
		if (up.code === 0 && fs.existsSync(upscale)) {
			// One pass on the upscaled image: it must re-derive BOTH layers,
			// because the native pass came back sparse.
			const upTsv = await runTessTsv(upscale, opts);
			if (upTsv.code === 0) {
				const upWords = parseTsvWordBoxes(upTsv.stdout, 2);
				const upText = textFromTsvWords(upWords);
				if (nonWs(upText) > nonWs(text)) {
					text = upText;
					words = upWords;
					error = undefined;
					mode = "upscaled";
				}
			}
		}
		fs.rm(upscale, { force: true }, () => {});
	}

	return { text, error, mode, ms: Date.now() - t0, ...(words ? { words } : {}) };
}
