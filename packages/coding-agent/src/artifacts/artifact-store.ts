/**
 * Artifact Store — Manages structured, persistent markdown artifacts.
 *
 * Saves documents to ~/.aery/artifacts/<sessionId>/, preserving structured metadata
 * and powering interactive feedback checkpoints.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ArtifactMetadata, StoredArtifact } from "./types";

export function getDefaultArtifactsDir(sessionId = "default"): string {
	return path.join(os.homedir(), ".aery", "artifacts", sessionId);
}

export class ArtifactStore {
	private dir: string;

	constructor(baseDir?: string) {
		this.dir = baseDir ?? getDefaultArtifactsDir();
	}

	get baseDirectory(): string {
		return this.dir;
	}

	private sanitizeName(name: string): string {
		return name
			.replace(/\.md$/i, "")
			.replace(/[^a-zA-Z0-9_-]/g, "_")
			.toLowerCase();
	}

	async saveArtifact(name: string, content: string, metadata: ArtifactMetadata): Promise<StoredArtifact> {
		await fs.mkdir(this.dir, { recursive: true });

		const id = this.sanitizeName(name);
		const filename = `${id}.md`;
		const metaFilename = `${id}.meta.json`;

		const filePath = path.join(this.dir, filename);
		const metaPath = path.join(this.dir, metaFilename);

		const now = Date.now();
		const finalMeta: ArtifactMetadata = {
			...metadata,
			createdAt: metadata.createdAt ?? now,
			updatedAt: now,
		};

		await fs.writeFile(filePath, content, "utf-8");
		await fs.writeFile(metaPath, JSON.stringify(finalMeta, null, 2), "utf-8");

		return {
			id,
			filename,
			path: filePath,
			metadata: finalMeta,
			content,
		};
	}

	async getArtifact(name: string): Promise<StoredArtifact | null> {
		const id = this.sanitizeName(name);
		const filename = `${id}.md`;
		const metaFilename = `${id}.meta.json`;

		const filePath = path.join(this.dir, filename);
		const metaPath = path.join(this.dir, metaFilename);

		try {
			const content = await fs.readFile(filePath, "utf-8");
			let metadata: ArtifactMetadata = { summary: "" };

			try {
				const metaRaw = await fs.readFile(metaPath, "utf-8");
				metadata = JSON.parse(metaRaw);
			} catch {}

			return {
				id,
				filename,
				path: filePath,
				metadata,
				content,
			};
		} catch {
			return null;
		}
	}

	async listArtifacts(): Promise<StoredArtifact[]> {
		try {
			await fs.mkdir(this.dir, { recursive: true });
			const entries = await fs.readdir(this.dir);
			const mdFiles = entries.filter(f => f.endsWith(".md"));

			const results: StoredArtifact[] = [];
			for (const file of mdFiles) {
				const artifact = await this.getArtifact(file);
				if (artifact) {
					results.push(artifact);
				}
			}

			return results;
		} catch {
			return [];
		}
	}
}
