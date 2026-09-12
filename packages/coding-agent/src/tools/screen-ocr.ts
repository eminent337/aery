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

export interface OcrFrameResult {
	text: string;
	error?: string;
	mode: "native" | "upscaled";
	ms: number;
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

/** Run tesseract on one image file with the proven single-threaded tuning. */
async function runTess(
	imgPath: string,
	opts: { lang?: string; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; code: number }> {
	return runCmd("tesseract", [imgPath, "stdout", "--oem", "1", "-l", opts.lang ?? "eng", "--psm", "6"], {
		timeout: opts.timeoutMs ?? 30_000,
		env: { OMP_THREAD_LIMIT: "1" },
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

	const res = await runTess(imgPath, opts);
	if (res.code === 0) {
		text = res.stdout.trim();
	} else {
		error = res.stderr || `tesseract exit ${res.code}`;
	}

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
			}
		}
		fs.rm(upscale, { force: true }, () => {});
	}

	return { text, error, mode, ms: Date.now() - t0 };
}
