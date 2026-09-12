// read_doc — read ANY file type as text, on-device.
// Studied prior art: microsoft/markitdown (native-text-first, per-format
// converters incl. LLM image description + EXIF + ZIP listing; see
// /home/aryee/aery/study/markitdown-study). This tool ports markitdown's
// text-first ladder into aery with one extra rung markitdown lacks on this
// box: LOCAL tesseract OCR (single-threaded, psm6) for images/scanned PDFs,
//
// Visionless models struggle with images, scans, and binary docs: `read`
// returns an image block (which the provider strips for non-vision models) or
// a markit error, and the agent then burns turns trying conversions. read_doc
// extracts the CONTENT directly as text:
//
//   - Images (png/jpg/tiff/bmp native; others via magick): OCR via the shared
//     single-threaded tesseract tuning (screen-ocr.ts) — works with NO vision
//     model at all.
//   - PDFs: native text layer first (pdftotext); when it comes back sparse
//     (<20 non-ws chars/page — a scan), rasterize pages (pdftoppm) and OCR
//     them. `pages` selector ("3-5") reads only those pages.
//   - Office/docs (docx/xlsx/pptx/rtf/epub/...): markit conversion (same
//     engine `read` uses).
//   - Plain text: returned as-is (capped).
//
// On this box tesseract MUST run single-threaded (OMP_THREAD_LIMIT=1) — see
// screen-ocr.ts for the full tuning rationale.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ImageContent, TextContent } from "@aryee337/aery-ai";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@aryee337/aery-core";
import { prompt } from "@aryee337/aery-utils";
import * as z from "zod/v4";
import readDocDescription from "../prompts/tools/read-doc.md" with { type: "text" };
import { convertFileWithMarkit } from "../utils/markit";
import type { ToolSession } from "./index";
import { resolveReadPath } from "./path-utils";
import { ocrFrame } from "./screen-ocr";
import { ToolError } from "./tool-errors";

const execFileAsync = promisify(execFile);

const OCR_CAP = 8000; // chars; matches live_eye / screen-ocr cap
const SCAN_SPARSE_THRESHOLD = 20; // non-ws chars per page below which a PDF is treated as a scan
const SCAN_DPI = 150; // pdftoppm raster density
const MAX_SCAN_PAGES = 20; // hard cap on rasterized pages per call

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".pnm"]);
// Only formats the bundled markit-ai actually supports (rtf/pdf are NOT in its
// converter list; pdf goes through our own pdftotext/pdftoppm ladder above).
const MARKIT_EXTS = new Set([
	".doc",
	".docx",
	".ppt",
	".pptx",
	".xls",
	".xlsx",
	".csv",
	".epub",
	".ipynb",
	".html",
	".xml",
	".json",
	".yaml",
	".zip",
]);

const readDocSchema = z
	.object({
		path: z.string().describe("File path: image, PDF (scanned or text), or document"),
		pages: z.string().optional().describe('PDF page selector, e.g. "3" or "3-7" (default: all pages)'),
		lang: z.string().optional().describe('OCR language, e.g. "eng", "afr" (default "eng")'),
	})
	.strict();

export type ReadDocParams = z.infer<typeof readDocSchema>;

export interface ReadDocDetails {
	resolvedPath: string;
	mode: "ocr" | "pdftotext" | "pdf-scan-ocr" | "markit" | "text";
	chars: number;
	ms: number;
	pages?: number;
	ocrPages?: number;
	note?: string;
}

async function runCmd(
	cmd: string,
	args: string[],
	options: { env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
	try {
		const { stdout, stderr } = await execFileAsync(cmd, args, {
			env: { ...process.env, ...options.env },
			timeout: options.timeout ?? 120_000,
		});
		return { stdout: stdout.trim(), stderr: stderr.trim(), code: 0 };
	} catch (err: unknown) {
		const error = err as { stdout?: string; stderr?: string; code?: number; message: string };
		return {
			stdout: error.stdout?.trim() || "",
			stderr: error.stderr?.trim() || error.message,
			code: typeof error.code === "number" ? error.code : 1,
		};
	}
}

/** Image dimensions via `identify` (markitdown ImageSize port). Null when unknown. */
async function getImageDims(imgPath: string): Promise<[number, number] | null> {
	const res = await runCmd("identify", ["-format", "%w %h", imgPath]);
	if (res.code !== 0) return null;
	const m = res.stdout.trim().split(/\s+/).map(Number);
	return m.length === 2 && Number.isFinite(m[0]) && Number.isFinite(m[1]) && m[0] > 0 && m[1] > 0
		? [m[0], m[1]]
		: null;
}

function nonWs(text: string): number {
	return text.replace(/\s/g, "").length;
}

function capText(text: string, cap = OCR_CAP): { text: string; truncated: boolean } {
	if (text.length <= cap) return { text, truncated: false };
	return { text: `${text.slice(0, cap)}\n…[truncated at ${cap} chars]`, truncated: true };
}

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".tif": "image/tiff",
	".tiff": "image/tiff",
	".bmp": "image/bmp",
	".pnm": "image/x-portable-anymap",
	".webp": "image/webp",
};

function mimeOf(absolutePath: string, ext: string): string {
	if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
	try {
		const fd = fs.openSync(absolutePath, "r");
		const buf = Buffer.alloc(16);
		const read = fs.readSync(fd, buf, 0, 16, 0);
		fs.closeSync(fd);
		if (read >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
			return "image/png";
		if (read >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
	} catch {
		// fall through
	}
	return "application/octet-stream";
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** "3" | "3-7" -> {first, last}; "7-3" | garbage -> null (undefined selector -> all). */
export function parsePageSelector(
	selector: string | undefined,
	lastPage: number,
): { first: number; last: number } | null | undefined {
	if (selector === undefined || selector === "") return undefined;
	const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(selector.trim());
	if (!m) return null;
	const first = Number(m[1]);
	const last = m[2] === undefined ? first : Number(m[2]);
	if (first < 1 || last < first || last > lastPage) return null;
	return { first, last };
}

/** OCR one image file; magick-convert formats tesseract cannot ingest directly. */
async function ocrImageFile(imgPath: string, lang?: string): Promise<{ text: string; note?: string; meta: string }> {
	const ext = path.extname(imgPath).toLowerCase();
	let ocrPath = imgPath;
	let note: string | undefined;
	if (!IMAGE_EXTS.has(ext)) {
		const converted = path.join(
			os.tmpdir(),
			`aerys-readdoc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
		);
		const conv = await runCmd("magick", [imgPath, converted]);
		if (conv.code !== 0 || !fs.existsSync(converted)) {
			return { text: "", note: `magick convert failed: ${conv.stderr || "unknown error"}`, meta: "" };
		}
		ocrPath = converted;
		note = `converted ${ext || "image"} → png via magick`;
	}
	try {
		const dims = await getImageDims(ocrPath);
		const meta = dims ? `Dimensions: ${dims[0]}x${dims[1]}` : "";
		const ocr = await ocrFrame(ocrPath, { lang });
		return {
			text: ocr.text,
			note: [note, ocr.error ? `ocr error: ${ocr.error}` : undefined].filter(Boolean).join("; ") || undefined,
			meta,
		};
	} finally {
		if (ocrPath !== imgPath) fs.rm(ocrPath, { force: true }, () => {});
	}
}

async function getPdfPageCount(pdfPath: string): Promise<number | null> {
	const res = await runCmd("pdfinfo", [pdfPath]);
	if (res.code !== 0) return null;
	const m = /^Pages:\s+(\d+)$/m.exec(res.stdout);
	return m ? Number(m[1]) : null;
}

/** Extract native text layer; returns "" when the PDF has none (scanned). */
async function pdfNativeText(pdfPath: string, range?: { first: number; last: number }): Promise<string> {
	const args = [pdfPath];
	if (range) args.unshift("-f", String(range.first), "-l", String(range.last));
	args.push("-");
	const res = await runCmd("pdftotext", args, { timeout: 60_000 });
	return res.code === 0 ? res.stdout.trim() : "";
}

/** Rasterize pages + OCR each. Returns per-page texts in order. */
async function ocrPdfPages(
	pdfPath: string,
	range: { first: number; last: number },
	lang?: string,
): Promise<{ pages: string[]; ocrPages: number; note?: string }> {
	const pages: string[] = [];
	const prefix = path.join(os.tmpdir(), `aerys-readdoc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	const args = ["-png", "-r", String(SCAN_DPI), "-f", String(range.first), "-l", String(range.last)];
	args.push(pdfPath, prefix);
	const res = await runCmd("pdftoppm", args, { timeout: 180_000 });
	if (res.code !== 0) {
		return { pages, ocrPages: 0, note: `pdftoppm failed: ${res.stderr || "unknown error"}` };
	}
	const files = fs
		.readdirSync(os.tmpdir())
		.filter(f => f.startsWith(path.basename(prefix)) && f.endsWith(".png"))
		.sort();
	for (const f of files) {
		const pagePath = path.join(os.tmpdir(), f);
		const ocr = await ocrFrame(pagePath, { lang });
		pages.push(ocr.text);
		fs.rm(pagePath, { force: true }, () => {});
	}
	return { pages, ocrPages: pages.length };
}

export class ReadDocTool implements AgentTool<typeof readDocSchema, ReadDocDetails> {
	readonly name = "read_doc";
	readonly approval = "read" as const;
	readonly label = "ReadDoc";
	readonly loadMode = "essential";
	readonly summary = "Read any file type as text (images/scans via OCR, PDFs, office docs)";
	readonly description: string;
	readonly parameters = readDocSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(readDocDescription);
	}

	async execute(
		_toolCallId: string,
		params: ReadDocParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ReadDocDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ReadDocDetails>> {
		const t0 = Date.now();
		const absolutePath = resolveReadPath(params.path, this.session.cwd);
		if (!fs.existsSync(absolutePath)) {
			throw new ToolError(`File not found: ${params.path}`);
		}
		const ext = path.extname(absolutePath).toLowerCase();

		let text = "";
		let mode: ReadDocDetails["mode"] = "text";
		let pages: number | undefined;
		let ocrPages: number | undefined;
		let note: string | undefined;

		if (IMAGE_EXTS.has(ext) || (ext !== ".pdf" && isProbablyImage(absolutePath))) {
			mode = "ocr";
			const stats = fs.statSync(absolutePath);
			const ocr = await ocrImageFile(absolutePath, params.lang);
			text = ocr.text;
			note = ocr.note;
			// Studied markitdown ImageConverter: metadata (ImageSize etc) precedes
			// description. Mirror that order so visionless models get context first.
			const metaLines = [`MIME: ${mimeOf(absolutePath, ext)}`, `Bytes: ${stats.size} (${formatBytes(stats.size)})`];
			if (ocr.meta) metaLines.push(ocr.meta);
			text = `${metaLines.join("\n")}\n\n${text}`;
			if (!ocr.text) {
				throw new ToolError(
					`OCR produced no text for ${params.path}${note ? ` (${note})` : ""}. If it is a photo/non-text image, a vision model (inspect_image) is required.`,
				);
			}
		} else if (ext === ".pdf") {
			const pageCount = (await getPdfPageCount(absolutePath)) ?? 0;
			const range = parsePageSelector(params.pages, Math.max(pageCount, 1));
			if (range === null) {
				throw new ToolError(
					`Invalid pages selector "${params.pages}" for a ${pageCount}-page PDF (use e.g. "3" or "3-7").`,
				);
			}
			pages = pageCount;
			const effective =
				range ?? (pageCount > 0 ? { first: 1, last: Math.min(pageCount, MAX_SCAN_PAGES) } : undefined);
			const native = await pdfNativeText(absolutePath, effective);
			const pageScope = effective ? effective.last - effective.first + 1 : pageCount || 1;
			if (nonWs(native) >= SCAN_SPARSE_THRESHOLD * pageScope) {
				mode = "pdftotext";
				text = native;
			} else if (effective) {
				mode = "pdf-scan-ocr";
				const scan = await ocrPdfPages(absolutePath, effective, params.lang);
				ocrPages = scan.ocrPages;
				note = scan.note;
				text = scan.pages.map((t, i) => `--- page ${effective.first + i} ---\n${t}`).join("\n");
				if (!text.replace(/--- page \d+ ---/g, "").trim()) {
					throw new ToolError(
						`PDF scan OCR produced no text for ${params.path}${note ? ` (${note})` : ""}. Is tesseract installed?`,
					);
				}
			} else {
				throw new ToolError(`PDF has no readable pages: ${params.path}`);
			}
		} else if (MARKIT_EXTS.has(ext)) {
			mode = "markit";
			const result = await convertFileWithMarkit(absolutePath);
			if (result.ok) {
				text = result.content;
			} else {
				throw new ToolError(`markit conversion failed for ${params.path}: ${result.error ?? "unknown error"}`);
			}
		} else {
			// Plain text (or unknown): return as text when it decodes; else fail cleanly.
			const buf = await fs.promises.readFile(absolutePath);
			const asText = buf.toString("utf8");
			const controlRatio =
				asText.replace(/[^\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]/g, "").length / Math.max(asText.length, 1);
			if (controlRatio < 0.9) {
				throw new ToolError(
					`Unsupported binary type "${ext || "(no extension)"}" for read_doc. Try markit-supported formats or extract with bash.`,
				);
			}
			text = asText.trim();
		}

		const capped = capText(text);
		const details: ReadDocDetails = {
			resolvedPath: absolutePath,
			mode,
			chars: capped.text.length,
			ms: Date.now() - t0,
			...(pages !== undefined ? { pages } : {}),
			...(ocrPages !== undefined ? { ocrPages } : {}),
			...(note ? { note } : {}),
		};
		const header =
			mode === "pdf-scan-ocr" && pages !== undefined
				? `read_doc [${mode}]: ${capped.text.length} chars from ${pages}-page scanned PDF`
				: `read_doc [${mode}]: ${capped.text.length} chars`;
		const content: (TextContent | ImageContent)[] = [{ type: "text", text: `${header}\n\n${capped.text}` }];
		return { content, details };
	}
}

/** Magick-style sniff: known image magic bytes in the first 16 bytes. */
function isProbablyImage(absolutePath: string): boolean {
	try {
		const fd = fs.openSync(absolutePath, "r");
		const buf = Buffer.alloc(16);
		const read = fs.readSync(fd, buf, 0, 16, 0);
		fs.closeSync(fd);
		const b = buf.subarray(0, read);
		if (read >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
			return true; // png
		if (read >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true; // jpeg
		if (
			read >= 4 &&
			(b.subarray(0, 4).toString("ascii") === "II*\u0000" || b.subarray(0, 4).toString("ascii") === "MM\u0000*")
		)
			return true; // tiff
		if (
			read >= 6 &&
			(b.subarray(0, 6).toString("ascii").startsWith("GIF8") ||
				b.subarray(0, 6).toString("ascii").startsWith("RIFF"))
		)
			return true; // gif/webp
		return false;
	} catch {
		return false;
	}
}
