import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	MicrovmSandboxTool,
	isSensitivePath,
	microvmSandboxSchema,
	resolveCoworkAssets,
} from "../src/tools/microvm-sandbox";

describe("MicroVM Sandbox Tool", () => {
	describe("isSensitivePath", () => {
		it("rejects ssh configuration and keys", () => {
			const home = os.homedir();
			expect(isSensitivePath("~/.ssh")).toBe(true);
			expect(isSensitivePath("~/.ssh/id_rsa")).toBe(true);
			expect(isSensitivePath(`${home}/.ssh`)).toBe(true);
			expect(isSensitivePath(`${home}/.ssh/config`)).toBe(true);
			expect(isSensitivePath(".ssh")).toBe(true);
		});

		it("rejects cloud and container credentials", () => {
			const home = os.homedir();
			expect(isSensitivePath("~/.aws")).toBe(true);
			expect(isSensitivePath("~/.aws/credentials")).toBe(true);
			expect(isSensitivePath(`${home}/.aws`)).toBe(true);
			expect(isSensitivePath("~/.gnupg")).toBe(true);
			expect(isSensitivePath(`${home}/.gnupg/pubring.kbx`)).toBe(true);
			expect(isSensitivePath("~/.kube")).toBe(true);
			expect(isSensitivePath(`${home}/.kube/config`)).toBe(true);
			expect(isSensitivePath("~/.docker")).toBe(true);
			expect(isSensitivePath(`${home}/.docker/config.json`)).toBe(true);
		});

		it("rejects env files and variants", () => {
			expect(isSensitivePath(".env")).toBe(true);
			expect(isSensitivePath(".env.local")).toBe(true);
			expect(isSensitivePath(".env.production")).toBe(true);
			expect(isSensitivePath("/project/.env")).toBe(true);
			expect(isSensitivePath("/project/sub/.env.secret")).toBe(true);
		});

		it("rejects shell and git configuration files", () => {
			const home = os.homedir();
			expect(isSensitivePath("~/.bashrc")).toBe(true);
			expect(isSensitivePath(`${home}/.bashrc`)).toBe(true);
			expect(isSensitivePath("~/.zshrc")).toBe(true);
			expect(isSensitivePath(`${home}/.zshrc`)).toBe(true);
			expect(isSensitivePath("~/.profile")).toBe(true);
			expect(isSensitivePath(`${home}/.profile`)).toBe(true);
			expect(isSensitivePath("~/.gitconfig")).toBe(true);
			expect(isSensitivePath(`${home}/.gitconfig`)).toBe(true);
			expect(isSensitivePath(".gitconfig")).toBe(true);
			expect(isSensitivePath("~/.netrc")).toBe(true);
			expect(isSensitivePath(`${home}/.netrc`)).toBe(true);
		});

		it("rejects root directory and home directory root", () => {
			const home = os.homedir();
			expect(isSensitivePath("/")).toBe(true);
			expect(isSensitivePath("~")).toBe(true);
			expect(isSensitivePath(home)).toBe(true);
		});

		it("permits standard non sensitive workspace paths", () => {
			expect(isSensitivePath("/home/aryee/workspace/project")).toBe(false);
			expect(isSensitivePath("/tmp/sandbox-test")).toBe(false);
			expect(isSensitivePath("src/components/button.tsx")).toBe(false);
			expect(isSensitivePath("/var/log/app.log")).toBe(false);
		});
	});

	describe("resolveCoworkAssets", () => {
		it("detects bundled system assets if present", () => {
			const assets = resolveCoworkAssets();
			expect(typeof assets.available).toBe("boolean");
			expect(typeof assets.kvmAvailable).toBe("boolean");
			if (assets.coworkHelper) {
				expect(assets.coworkHelper).toContain("cowork-linux-helper");
			}
			if (assets.virtiofsd) {
				expect(assets.virtiofsd).toContain("virtiofsd");
			}
			if (assets.smolImage) {
				expect(assets.smolImage).toContain("smol");
			}
		});

		it("honors environment overrides for all assets", () => {
			const mockEnv = {
				COWORK_HELPER_PATH: "/custom/bin/cowork-linux-helper",
				VIRTIOFSD_PATH: "/custom/bin/virtiofsd",
				SMOL_IMAGE_PATH: "/custom/images/smol-bin.x64.img",
			};
			const assets = resolveCoworkAssets(mockEnv, { skipExistenceCheck: true });
			expect(assets.coworkHelper).toBe("/custom/bin/cowork-linux-helper");
			expect(assets.virtiofsd).toBe("/custom/bin/virtiofsd");
			expect(assets.smolImage).toBe("/custom/images/smol-bin.x64.img");
			expect(assets.available).toBe(true);
		});

		it("returns unavailable when assets are missing", () => {
			const emptyEnv = {
				PATH: "",
				COWORK_HELPER_PATH: "",
				VIRTIOFSD_PATH: "",
				SMOL_IMAGE_PATH: "",
				COWORK_RESOURCES_DIR: "/nonexistent-dir",
			};
			const assets = resolveCoworkAssets(emptyEnv);
			expect(assets.available).toBe(false);
		});
	});

	describe("microvmSandboxSchema", () => {
		it("validates actions and parameters", () => {
			const statusParsed = microvmSandboxSchema.parse({ action: "status" });
			expect(statusParsed.action).toBe("status");

			const mountParsed = microvmSandboxSchema.parse({
				action: "mount_directory",
				host_path: "/home/aryee/workspace",
				guest_path: "/workspace",
				readonly: true,
			});
			expect(mountParsed.action).toBe("mount_directory");
			expect(mountParsed.host_path).toBe("/home/aryee/workspace");
			expect(mountParsed.guest_path).toBe("/workspace");
			expect(mountParsed.readonly).toBe(true);

			const executeParsed = microvmSandboxSchema.parse({
				action: "execute",
				command: "ls -la",
				cwd: "/workspace",
				timeout_ms: 5000,
			});
			expect(executeParsed.action).toBe("execute");
			expect(executeParsed.command).toBe("ls -la");

			const stopParsed = microvmSandboxSchema.parse({ action: "stop" });
			expect(stopParsed.action).toBe("stop");
		});

		it("rejects unknown actions", () => {
			expect(() => {
				microvmSandboxSchema.parse({ action: "destroy_everything" });
			}).toThrow();
		});
	});

	describe("MicrovmSandboxTool execution", () => {
		it("handles status check lifecycle", async () => {
			const tool = new MicrovmSandboxTool();
			const result = await tool.execute("call-1", { action: "status" });
			expect(result.isError).toBeFalsy();
			expect(result.content[0].type).toBe("text");
			expect(result.content[0].text).toContain("MicroVM Sandbox Status");
		});

		it("rejects mounting sensitive directories", async () => {
			const tool = new MicrovmSandboxTool();
			const result = await tool.execute("call-2", {
				action: "mount_directory",
				host_path: "~/.ssh",
				guest_path: "/root/.ssh",
			});
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("Refused to mount sensitive host path");
		});

		it("allows mounting safe workspace directory", async () => {
			const tool = new MicrovmSandboxTool();
			const result = await tool.execute("call-3", {
				action: "mount_directory",
				host_path: "/tmp/safe-sandbox-dir",
				guest_path: "/workspace",
				readonly: false,
			});
			expect(result.isError).toBeFalsy();
			expect(result.content[0].text).toContain("Mounted host directory");
		});

		it("handles execution and missing parameters", async () => {
			const tool = new MicrovmSandboxTool();
			const missingCmdResult = await tool.execute("call-missing", {
				action: "execute",
			});
			expect(missingCmdResult.isError).toBe(true);
			expect(missingCmdResult.content[0].text).toContain("Missing required parameter: command");

			const missingHostResult = await tool.execute("call-no-host", {
				action: "mount_directory",
			});
			expect(missingHostResult.isError).toBe(true);
			expect(missingHostResult.content[0].text).toContain("Missing required parameter: host_path");

			const execResult = await tool.execute("call-exec", {
				action: "execute",
				command: "echo test",
			});
			expect(execResult.content[0].type).toBe("text");
		});

		it("instantiates through factory createIf", () => {
			const instance = MicrovmSandboxTool.createIf();
			expect(instance).toBeInstanceOf(MicrovmSandboxTool);
			expect(instance?.name).toBe("microvm_sandbox");
		});

		it("handles stop action", async () => {
			const tool = new MicrovmSandboxTool();
			const result = await tool.execute("call-4", { action: "stop" });
			expect(result.isError).toBeFalsy();
			expect(result.content[0].text).toContain("MicroVM sandbox stopped");
		});
	});
});
