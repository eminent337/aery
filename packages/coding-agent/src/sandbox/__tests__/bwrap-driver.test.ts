import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { buildBwrapArgs } from "../bwrap-driver";
import type { SandboxConfig } from "../types";

describe("Bubblewrap Sandbox Driver", () => {
	it("generates correct isolation arguments with read-only root and workspace write", () => {
		const workspace = "/home/aryee/test-project";
		const config: SandboxConfig = {
			enabled: true,
			workspaceDir: workspace,
			allowNetwork: false,
		};

		const args = buildBwrapArgs(config);

		// Read-only root
		expect(args).toContain("--ro-bind");
		expect(args).toContain("/");

		// Standard pseudo-filesystems
		expect(args).toContain("--dev");
		expect(args).toContain("/dev");
		expect(args).toContain("--proc");
		expect(args).toContain("/proc");
		expect(args).toContain("--tmpfs");
		expect(args).toContain("/tmp");

		// Workspace read-write mount
		expect(args).toContain("--bind");
		expect(args).toContain(workspace);

		// Network isolation
		expect(args).toContain("--unshare-net");
	});

	it("shadows sensitive credential directories if they exist", () => {
		const config: SandboxConfig = {
			enabled: true,
			workspaceDir: "/tmp/workspace",
			allowNetwork: true,
		};

		const args = buildBwrapArgs(config);

		// Network should not be unshared when allowNetwork is true
		expect(args).not.toContain("--unshare-net");

		// Sensitive dirs like ~/.ssh should have --tmpfs shadowing
		const sshPath = path.join(os.homedir(), ".ssh");
		const sshIndex = args.indexOf(sshPath);
		if (sshIndex !== -1) {
			expect(args[sshIndex - 1]).toBe("--tmpfs");
		}
	});
});
