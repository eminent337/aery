import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listSupportedExternalAgents } from "./adapters";
import type { DiscoveredExternalAgent } from "./types";

const execFileAsync = promisify(execFile);

/**
 * Searches system PATH for the given binary name.
 * Returns the full absolute path if found and executable, null otherwise.
 */
export async function findBinaryInPath(binaryName: string): Promise<string | null> {
	if (path.isAbsolute(binaryName)) {
		try {
			await fs.access(binaryName, fs.constants.X_OK);
			return binaryName;
		} catch {
			return null;
		}
	}

	const pathEnv = process.env.PATH ?? "";
	const pathDirs = pathEnv.split(path.delimiter).filter(Boolean);

	for (const dir of pathDirs) {
		const fullPath = path.join(dir, binaryName);
		try {
			await fs.access(fullPath, fs.constants.X_OK);
			return fullPath;
		} catch {
			// Continue searching next directory
		}
	}

	return null;
}

export interface ExternalAgentDiscoveryResult {
	installed: DiscoveredExternalAgent[];
	uninstalled: Array<{ id: string; displayName: string; defaultBinary: string }>;
}

/**
 * Scans the host system for all supported external AI coding agents by
 * searching PATH entries and probing version information where available.
 */
export async function detectExternalAgents(): Promise<ExternalAgentDiscoveryResult> {
	const adapters = listSupportedExternalAgents().filter(a => a.id !== "custom");
	const installed: DiscoveredExternalAgent[] = [];
	const uninstalled: Array<{ id: string; displayName: string; defaultBinary: string }> = [];

	await Promise.all(
		adapters.map(async adapter => {
			const binaryPath = await findBinaryInPath(adapter.defaultBinary);
			if (binaryPath) {
				let version: string | undefined;
				try {
					const { stdout } = await execFileAsync(binaryPath, adapter.versionArgs, { timeout: 3000 });
					version = adapter.parseVersion ? adapter.parseVersion(stdout) : stdout.trim();
				} catch {
					version = undefined;
				}

				installed.push({
					id: adapter.id,
					displayName: adapter.displayName,
					binaryPath,
					installed: true,
					version,
				});
			} else {
				uninstalled.push({
					id: adapter.id,
					displayName: adapter.displayName,
					defaultBinary: adapter.defaultBinary,
				});
			}
		}),
	);

	// Sort alphabetically for deterministic output
	installed.sort((a, b) => a.id.localeCompare(b.id));
	uninstalled.sort((a, b) => a.id.localeCompare(b.id));

	return { installed, uninstalled };
}
