import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface SessionInfo {
	sessionId: string;
	model: string;
	createdAt: number;
	messageCount: number;
}

export class SessionManager {
	#sessionsDir: string;

	constructor() {
		this.#sessionsDir = path.join(os.homedir(), ".aery", "sessions");
	}

	async listSessions(): Promise<SessionInfo[]> {
		try {
			await fs.mkdir(this.#sessionsDir, { recursive: true });
			const files = await fs.readdir(this.#sessionsDir);
			const infos: SessionInfo[] = [];

			for (const file of files) {
				if (!file.endsWith(".jsonl")) continue;
				const filePath = path.join(this.#sessionsDir, file);
				const stat = await fs.stat(filePath);
				const content = await fs.readFile(filePath, "utf-8");
				const lines = content.trim().split("\n");

				let model = "unknown";
				if (lines[0]) {
					try {
						const first = JSON.parse(lines[0]);
						if (first.model) model = first.model;
					} catch {}
				}

				infos.push({
					sessionId: file.replace(".jsonl", ""),
					model,
					createdAt: stat.birthtimeMs,
					messageCount: lines.length,
				});
			}
			return infos;
		} catch {
			return [];
		}
	}
}
