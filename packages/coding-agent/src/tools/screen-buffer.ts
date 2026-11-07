import { spawn } from "node:child_process";

/**
 * Probe image dimensions directly from PNG IHDR chunk in memory (0ms, zero subprocesses).
 * PNG format:
 * Bytes 0-7: PNG signature (0x89 0x50 0x4e 0x47 0x0d 0x0a 0x1a 0x0a)
 * Bytes 8-11: Chunk length (0x00 0x00 0x00 0x0d)
 * Bytes 12-15: Chunk type ("IHDR")
 * Bytes 16-19: Width (big-endian uint32)
 * Bytes 20-23: Height (big-endian uint32)
 */
export function probePngDimensions(buffer: Buffer): [number, number] | null {
	if (
		buffer.length >= 24 &&
		buffer[0] === 0x89 &&
		buffer[1] === 0x50 &&
		buffer[2] === 0x4e &&
		buffer[3] === 0x47 &&
		buffer[4] === 0x0d &&
		buffer[5] === 0x0a &&
		buffer[6] === 0x1a &&
		buffer[7] === 0x0a
	) {
		const width = buffer.readUInt32BE(16);
		const height = buffer.readUInt32BE(20);
		if (width > 0 && height > 0) return [width, height];
	}
	return null;
}

/**
 * Resize PNG buffer using an in-memory streaming pipe through ImageMagick (`convert`).
 * If buffer dimensions fit within maxWidth x maxHeight, skips processing entirely.
 */
export async function resizePngBuffer(
	buffer: Buffer,
	maxWidth = 1920,
	maxHeight = 1080,
): Promise<{ buffer: Buffer; width: number; height: number }> {
	const dims = probePngDimensions(buffer);
	const width = dims ? dims[0] : 0;
	const height = dims ? dims[1] : 0;

	if (width <= maxWidth && height <= maxHeight && width > 0 && height > 0) {
		return { buffer, width, height };
	}

	return new Promise((resolve, reject) => {
		const proc = spawn(
			"convert",
			[
				"-",
				"-resize",
				`${maxWidth}x${maxHeight}>`,
				"-filter",
				"LanczosSharp",
				"-define",
				"png:compression-level=1",
				"png:-",
			],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);

		const chunks: Buffer[] = [];
		let stderr = "";
		let settled = false;

		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				try { proc.kill("SIGKILL"); } catch {}
				reject(new Error("resizePngBuffer timed out after 6000ms"));
			}
		}, 6000);

		proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		proc.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		proc.on("close", code => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code !== 0) {
				return reject(new Error(`convert failed with code ${code}: ${stderr}`));
			}
			const outBuf = Buffer.concat(chunks);
			const outDims = probePngDimensions(outBuf) || [width, height];
			resolve({ buffer: outBuf, width: outDims[0], height: outDims[1] });
		});

		proc.on("error", err => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(err);
		});

		proc.stdin.on("error", () => {
			// ignore EPIPE
		});

		proc.stdin.end(buffer);
	});
}
