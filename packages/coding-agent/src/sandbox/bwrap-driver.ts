/**
 * Bubblewrap (bwrap) Sandbox Driver for Aery.
 *
 * Confines bash execution to the workspace, prevents unauthorized host modifications,
 * and masks sensitive credential locations (~/.ssh, ~/.aws).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SandboxConfig, SandboxProbeResult } from "./types";

let cachedProbe: SandboxProbeResult | null = null;

/**
 * Checks whether bubblewrap is available and functional on this system.
 */
export function probeSandbox(): SandboxProbeResult {
	if (cachedProbe) return cachedProbe;

	if (process.platform !== "linux") {
		cachedProbe = { available: false, backend: "none", reason: "Sandboxing currently requires Linux" };
		return cachedProbe;
	}

	const candidates = ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"];
	for (const p of candidates) {
		try {
			if (fs.existsSync(p)) {
				cachedProbe = { available: true, backend: "bwrap", path: p };
				return cachedProbe;
			}
		} catch {}
	}

	cachedProbe = { available: false, backend: "none", reason: "bwrap binary not found in standard paths" };
	return cachedProbe;
}

/**
 * Builds bubblewrap CLI arguments to wrap a command execution.
 */
export function buildBwrapArgs(config: SandboxConfig): string[] {
	const args: string[] = [
		// Mount host root read-only
		"--ro-bind",
		"/",
		"/",
		// Standard dev and proc mounts
		"--dev",
		"/dev",
		"--proc",
		"/proc",
		// Isolated tmpfs for /tmp
		"--tmpfs",
		"/tmp",
		// Allow full read-write in the active workspace
		"--bind",
		config.workspaceDir,
		config.workspaceDir,
		// Die when parent dies
		"--die-with-parent",
	];

	// Network containment
	if (config.allowNetwork === false) {
		args.push("--unshare-net");
	}

	// Additional mounts
	if (config.additionalReadWritePaths) {
		for (const p of config.additionalReadWritePaths) {
			if (fs.existsSync(p)) {
				args.push("--bind", p, p);
			}
		}
	}

	if (config.additionalReadOnlyPaths) {
		for (const p of config.additionalReadOnlyPaths) {
			if (fs.existsSync(p)) {
				args.push("--ro-bind", p, p);
			}
		}
	}

	// Shadow sensitive user directories by mounting empty tmpfs over them if they exist
	if (config.shadowSensitivePaths !== false) {
		const home = os.homedir();
		const sensitive = [
			path.join(home, ".ssh"),
			path.join(home, ".aws"),
			path.join(home, ".gnupg"),
			path.join(home, ".docker"),
		];

		for (const dir of sensitive) {
			try {
				if (fs.existsSync(dir)) {
					args.push("--tmpfs", dir);
				}
			} catch {}
		}
	}

	return args;
}

/**
 * Wraps a shell command string with bwrap if sandboxing is available and enabled.
 */
export function wrapWithSandbox(command: string, config: SandboxConfig): string {
	if (!config.enabled) return command;

	const probe = probeSandbox();
	if (!probe.available || !probe.path) return command;

	const bwrapArgs = buildBwrapArgs(config);
	// Escape command for bash inside sandbox
	const escapedArgs = bwrapArgs.map(a => `"${a.replace(/"/g, '\\"')}"`).join(" ");
	return `${probe.path} ${escapedArgs} bash -c "${command.replace(/"/g, '\\"')}"`;
}
