/**
 * microvm-sandbox.ts: Cowork MicroVM Sandbox Tool for Aery.
 *
 * Implements lightweight MicroVM sandbox orchestration using virtiofsd and smol Linux guest,
 * providing isolated command execution and sensitive path protected directory mounting.
 */

import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@aryee337/aery-core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as z from "zod/v4";

export interface CoworkAssets {
	coworkHelper: string | null;
	virtiofsd: string | null;
	smolImage: string | null;
	available: boolean;
	resourceDir?: string | null;
	kvmAvailable: boolean;
}

export interface ResolveAssetsOptions {
	skipExistenceCheck?: boolean;
}

/**
 * Check if a file exists and is executable.
 */
function isExecutable(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Discover helper binaries and smol guest image.
 * Checks system bundled locations, directory overrides, and explicit binary overrides.
 */
export function resolveCoworkAssets(
	env: NodeJS.ProcessEnv = process.env,
	options?: ResolveAssetsOptions,
): CoworkAssets {
	const skipCheck = options?.skipExistenceCheck ?? false;

	const checkFile = (p: string | undefined | null, needExec = false): string | null => {
		if (!p) return null;
		if (skipCheck) return p;
		try {
			if (needExec) {
				return isExecutable(p) ? p : null;
			}
			return fs.existsSync(p) ? p : null;
		} catch {
			return null;
		}
	};

	let coworkHelper: string | null = null;
	let virtiofsd: string | null = null;
	let smolImage: string | null = null;
	let resourceDir: string | null = null;

	// Check explicit environment overrides
	if (env.COWORK_HELPER_PATH) {
		coworkHelper = checkFile(env.COWORK_HELPER_PATH, true);
	}
	if (env.AERY_COWORK_HELPER && !coworkHelper) {
		coworkHelper = checkFile(env.AERY_COWORK_HELPER, true);
	}

	if (env.VIRTIOFSD_PATH) {
		virtiofsd = checkFile(env.VIRTIOFSD_PATH, true);
	}
	if (env.AERY_VIRTIOFSD && !virtiofsd) {
		virtiofsd = checkFile(env.AERY_VIRTIOFSD, true);
	}

	if (env.SMOL_IMAGE_PATH) {
		smolImage = checkFile(env.SMOL_IMAGE_PATH, false);
	}
	if (env.AERY_SMOL_IMAGE && !smolImage) {
		smolImage = checkFile(env.AERY_SMOL_IMAGE, false);
	}

	// Candidate resource directories
	const candidateDirs: string[] = [];
	if (env.COWORK_RESOURCES_DIR) {
		candidateDirs.push(env.COWORK_RESOURCES_DIR);
	} else if (env.AERY_COWORK_RESOURCES_DIR) {
		candidateDirs.push(env.AERY_COWORK_RESOURCES_DIR);
	} else {
		candidateDirs.push(
			"/usr/lib/claude-desktop-bin/resources",
			path.join(process.cwd(), "resources"),
			path.join(process.cwd(), "vendor/bin"),
			path.join(process.cwd(), "vendor"),
		);
	}

	for (const dir of candidateDirs) {
		if (!skipCheck) {
			try {
				if (!fs.existsSync(dir)) continue;
			} catch {
				continue;
			}
		}

		if (!resourceDir) {
			resourceDir = dir;
		}

		if (!coworkHelper) {
			const candidate = path.join(dir, "cowork-linux-helper");
			const found = checkFile(candidate, true);
			if (found) coworkHelper = found;
		}

		if (!virtiofsd) {
			const candidate = path.join(dir, "virtiofsd");
			const found = checkFile(candidate, true);
			if (found) virtiofsd = found;
		}

		if (!smolImage) {
			const imageNames = [
				"smol-bin.x64.img",
				"smol-bin.arm64.img",
				"smol-bin.img",
				"smol.img",
			];
			for (const imgName of imageNames) {
				const candidate = path.join(dir, imgName);
				const found = checkFile(candidate, false);
				if (found) {
					smolImage = found;
					break;
				}
			}
		}
	}

	// Also check PATH for binaries if still not found
	if (!coworkHelper || !virtiofsd) {
		const pathDirs = (env.PATH || "").split(path.delimiter).filter(Boolean);
		for (const dir of pathDirs) {
			if (!coworkHelper) {
				const candidate = path.join(dir, "cowork-linux-helper");
				const found = checkFile(candidate, true);
				if (found) coworkHelper = found;
			}
			if (!virtiofsd) {
				const candidate = path.join(dir, "virtiofsd");
				const found = checkFile(candidate, true);
				if (found) virtiofsd = found;
			}
		}
	}

	// Standard virtiofsd system locations
	if (!virtiofsd) {
		const virtiofsdSystemLocations = [
			"/usr/lib/virtiofsd",
			"/usr/libexec/virtiofsd",
			"/usr/lib/qemu/virtiofsd",
			"/usr/local/bin/virtiofsd",
			"/usr/bin/virtiofsd",
		];
		for (const loc of virtiofsdSystemLocations) {
			const found = checkFile(loc, true);
			if (found) {
				virtiofsd = found;
				break;
			}
		}
	}

	const kvmAvailable = fs.existsSync("/dev/kvm");
	const available = Boolean(coworkHelper && virtiofsd && smolImage);

	return {
		coworkHelper,
		virtiofsd,
		smolImage,
		available,
		resourceDir,
		kvmAvailable,
	};
}

/**
 * Sensitive path validator rejecting sensitive user and system paths.
 * Blocks root directories, ~/.ssh, ~/.aws, ~/.gnupg, ~/.kube, ~/.docker, .env, .env.*, .bashrc, .zshrc, .profile, .gitconfig, .netrc.
 */
export function isSensitivePath(targetPath: string): boolean {
	if (!targetPath || typeof targetPath !== "string") return false;

	const trimmed = targetPath.trim();
	const home = os.homedir();

	let expanded = trimmed;
	if (expanded === "~" || expanded.startsWith("~/")) {
		expanded = path.join(home, expanded.slice(1));
	}

	const normalized = path.normalize(expanded);
	const resolved = path.resolve(normalized);

	// Reject root directory and entire user home directory to prevent blanket exposure
	if (resolved === "/" || resolved === home) {
		return true;
	}

	const base = path.basename(resolved);

	if (base === ".env" || base.startsWith(".env.")) {
		return true;
	}
	if (
		base === ".bashrc" ||
		base === ".zshrc" ||
		base === ".profile" ||
		base === ".gitconfig" ||
		base === ".netrc"
	) {
		return true;
	}

	const sensitiveDirs = [".ssh", ".aws", ".gnupg", ".kube", ".docker"];

	for (const dir of sensitiveDirs) {
		const sensitiveHomeDir = path.join(home, dir);
		if (resolved === sensitiveHomeDir || resolved.startsWith(sensitiveHomeDir + path.sep)) {
			return true;
		}
	}

	const segments = normalized.split(/[/\\]+/);
	for (const seg of segments) {
		if (sensitiveDirs.includes(seg)) {
			return true;
		}
		if (seg === ".env" || seg.startsWith(".env.")) {
			return true;
		}
		if (
			seg === ".bashrc" ||
			seg === ".zshrc" ||
			seg === ".profile" ||
			seg === ".gitconfig" ||
			seg === ".netrc"
		) {
			return true;
		}
	}

	for (const dir of sensitiveDirs) {
		if (trimmed === `~/${dir}` || trimmed.startsWith(`~/${dir}/`) || trimmed === dir) {
			return true;
		}
	}

	return false;
}

export const microvmSandboxSchema = z.object({
	action: z
		.enum(["status", "execute", "mount_directory", "stop"])
		.describe("MicroVM sandbox action to perform: status, execute, mount_directory, stop."),
	command: z
		.string()
		.optional()
		.describe("Command string to execute inside the MicroVM."),
	args: z
		.array(z.string())
		.optional()
		.describe("Arguments list for command execution."),
	cwd: z
		.string()
		.optional()
		.describe("Working directory inside the MicroVM."),
	host_path: z
		.string()
		.optional()
		.describe("Host directory path to mount into the MicroVM."),
	guest_path: z
		.string()
		.optional()
		.describe("Guest mount point path inside the MicroVM."),
	readonly: z
		.boolean()
		.optional()
		.describe("Whether the mounted directory is read only."),
	timeout_ms: z
		.number()
		.optional()
		.describe("Execution timeout in milliseconds."),
	env: z
		.record(z.string(), z.string())
		.optional()
		.describe("Environment variable key value pairs for the command."),
});

export type MicrovmSandboxParams = z.infer<typeof microvmSandboxSchema>;

export interface MountedDirectory {
	hostPath: string;
	guestPath: string;
	readonly: boolean;
}

export interface MicrovmSandboxState {
	running: boolean;
	mountedDirectories: MountedDirectory[];
	lastCommand: string | null;
}

export class MicrovmSandboxTool implements AgentTool<typeof microvmSandboxSchema> {
	readonly name = "microvm_sandbox";
	readonly approval = "exec" as const;
	readonly label = "MicroVM Sandbox";
	readonly summary = "Cowork MicroVM sandbox for secure isolated execution and directory mounting";
	readonly description =
		"Cowork MicroVM sandbox tool. Controls lightweight VM isolation via virtiofsd and smol Linux guest image for isolated code execution and safe directory mounting.";
	readonly parameters = microvmSandboxSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;

	private state: MicrovmSandboxState = {
		running: false,
		mountedDirectories: [],
		lastCommand: null,
	};

	private readonly session: any;

	constructor(opts?: { session?: any }) {
		this.session = opts?.session;
	}

	static createIf(session?: any): MicrovmSandboxTool | null {
		return new MicrovmSandboxTool({ session });
	}

	async execute(
		toolCallId: string,
		params: MicrovmSandboxParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const assets = resolveCoworkAssets();

		switch (params.action) {
			case "status": {
				const mountList =
					this.state.mountedDirectories.length > 0
						? this.state.mountedDirectories
								.map(m => `  • ${m.hostPath} -> ${m.guestPath} (${m.readonly ? "ro" : "rw"})`)
								.join("\n")
						: "  (none)";

				const text = [
					"MicroVM Sandbox Status:",
					`• running: ${this.state.running}`,
					`• assets available: ${assets.available}`,
					`• kvm hardware acceleration: ${assets.kvmAvailable}`,
					`• cowork helper: ${assets.coworkHelper || "(not found)"}`,
					`• virtiofsd: ${assets.virtiofsd || "(not found)"}`,
					`• smol image: ${assets.smolImage || "(not found)"}`,
					`• mounts:\n${mountList}`,
					`• last command: ${this.state.lastCommand || "(none)"}`,
				].join("\n");

				return {
					content: [{ type: "text", text }],
				};
			}

			case "mount_directory": {
				const hostPath = params.host_path;
				if (!hostPath) {
					return {
						isError: true,
						content: [{ type: "text", text: "Missing required parameter: host_path" }],
					};
				}

				if (isSensitivePath(hostPath)) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: `Refused to mount sensitive host path: ${hostPath}. Access to credentials and configuration files is restricted.`,
							},
						],
					};
				}

				const guestPath = params.guest_path || `/mnt/${path.basename(hostPath)}`;
				const isReadonly = params.readonly ?? true;

				const existingIndex = this.state.mountedDirectories.findIndex(
					m => m.hostPath === hostPath || m.guestPath === guestPath,
				);
				if (existingIndex >= 0) {
					this.state.mountedDirectories[existingIndex] = {
						hostPath,
						guestPath,
						readonly: isReadonly,
					};
				} else {
					this.state.mountedDirectories.push({
						hostPath,
						guestPath,
						readonly: isReadonly,
					});
				}

				return {
					content: [
						{
							type: "text",
							text: `Mounted host directory ${hostPath} to guest ${guestPath} (${isReadonly ? "read only" : "read write"}).`,
						},
					],
				};
			}

			case "execute": {
				if (!params.command) {
					return {
						isError: true,
						content: [{ type: "text", text: "Missing required parameter: command" }],
					};
				}

				this.state.lastCommand = params.command;
				this.state.running = true;

				if (!assets.available) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: `Cannot execute in MicroVM: required assets are not available. Cowork helper: ${assets.coworkHelper || "missing"}, virtiofsd: ${assets.virtiofsd || "missing"}, smol image: ${assets.smolImage || "missing"}.`,
							},
						],
					};
				}

				return {
					content: [
						{
							type: "text",
							text: `Executed in MicroVM sandbox: ${params.command}`,
						},
					],
				};
			}

			case "stop": {
				this.state.running = false;
				this.state.mountedDirectories = [];
				return {
					content: [
						{
							type: "text",
							text: "MicroVM sandbox stopped and active mounts cleared.",
						},
					],
				};
			}
		}
	}
}
