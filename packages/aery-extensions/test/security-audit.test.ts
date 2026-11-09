import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@aryee337/aery";
import damageControl, { loadConfig } from "../src/core/damage-control";
import { resolveAuditLogPath, SecurityAuditLogger, type SecurityDecisionEntry } from "../src/core/security-audit";

interface ToolCallResult {
	block?: boolean;
	reason?: string;
}

function createMockAery() {
	let handler:
		| ((
				event: { toolName: string; input: any },
				ctx: any,
		  ) => Promise<ToolCallResult | undefined> | ToolCallResult | undefined)
		| null = null;

	const mockApi = {
		on: (event: string, fn: any) => {
			if (event === "tool_call") {
				handler = fn;
			}
		},
	} as unknown as ExtensionAPI;

	return {
		api: mockApi,
		callTool: async (toolName: string, input: any) => {
			if (!handler) throw new Error("Handler not registered");
			return await handler({ toolName, input }, {});
		},
	};
}

describe("SecurityAuditLogger unit tests", () => {
	const originalEnv = process.env.AERY_SECURITY_AUDIT_LOG;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `sec-audit-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		delete process.env.AERY_SECURITY_AUDIT_LOG;
	});

	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.AERY_SECURITY_AUDIT_LOG = originalEnv;
		} else {
			delete process.env.AERY_SECURITY_AUDIT_LOG;
		}
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("resolves default path when neither option nor env is set", () => {
		const expected = join(homedir(), ".aery", "logs", "security-audit.jsonl");
		expect(resolveAuditLogPath()).toBe(expected);

		const logger = new SecurityAuditLogger();
		expect(logger.logPath).toBe(expected);
	});

	it("resolves env AERY_SECURITY_AUDIT_LOG when set", () => {
		const envPath = join(tempDir, "env-audit.jsonl");
		process.env.AERY_SECURITY_AUDIT_LOG = envPath;

		expect(resolveAuditLogPath()).toBe(envPath);
		const logger = new SecurityAuditLogger();
		expect(logger.logPath).toBe(envPath);
	});

	it("resolves constructor path option with priority over env", () => {
		process.env.AERY_SECURITY_AUDIT_LOG = join(tempDir, "ignored.jsonl");
		const explicitPath = join(tempDir, "explicit.jsonl");

		const logger = new SecurityAuditLogger(explicitPath);
		expect(logger.logPath).toBe(explicitPath);

		const loggerWithOptions = new SecurityAuditLogger({ logPath: explicitPath });
		expect(loggerWithOptions.logPath).toBe(explicitPath);
	});

	it("expands tilde (~) in paths correctly", () => {
		const pathWithTilde = "~/custom/audit.jsonl";
		const expected = join(homedir(), "custom", "audit.jsonl");
		expect(resolveAuditLogPath(pathWithTilde)).toBe(expected);
	});

	it("logs decision entries to JSONL file and creates parent directories", () => {
		const logFile = join(tempDir, "nested", "sub", "audit.jsonl");
		const logger = new SecurityAuditLogger(logFile);

		const entry1: SecurityDecisionEntry = {
			timestamp: new Date().toISOString(),
			toolName: "bash",
			action: "execute",
			target: "git status",
			decision: "allow",
		};

		const entry2: SecurityDecisionEntry = {
			timestamp: new Date().toISOString(),
			toolName: "write",
			action: "write",
			target: ".git/config",
			decision: "block",
			rule: "blockGitWrites",
			reason: "Blocked by damage control: direct writes to .git metadata are forbidden",
			metadata: { test: true },
		};

		logger.logDecision(entry1);
		logger.logDecision(entry2);

		expect(existsSync(logFile)).toBe(true);
		const lines = readFileSync(logFile, "utf-8").trim().split("\n");
		expect(lines.length).toBe(2);

		const parsed1 = JSON.parse(lines[0]);
		expect(parsed1.toolName).toBe("bash");
		expect(parsed1.decision).toBe("allow");
		expect(parsed1.target).toBe("git status");

		const parsed2 = JSON.parse(lines[1]);
		expect(parsed2.toolName).toBe("write");
		expect(parsed2.decision).toBe("block");
		expect(parsed2.rule).toBe("blockGitWrites");
		expect(parsed2.metadata).toEqual({ test: true });
	});

	it("fails silently and does not throw when log destination is unwritable", () => {
		// Use a path where a file acts as a parent directory to trigger an ENOTDIR error
		const blockingFile = join(tempDir, "blocking-file");
		writeFileSync(blockingFile, "file-content");
		const invalidPath = join(blockingFile, "cannot", "write.jsonl");

		const logger = new SecurityAuditLogger(invalidPath);
		expect(() => {
			logger.logDecision({
				timestamp: new Date().toISOString(),
				toolName: "bash",
				action: "execute",
				target: "ls",
				decision: "allow",
			});
		}).not.toThrow();

		expect(() => logger.close()).not.toThrow();
	});
});

describe("damage-control audit logging integration", () => {
	let tempDir: string;
	let auditLogFile: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `sec-audit-dc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		auditLogFile = join(tempDir, "damage-audit.jsonl");
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("logs blocked commands to JSONL with rule and reason", async () => {
		const { api, callTool } = createMockAery();
		damageControl(api, {
			audit_log_path: auditLogFile,
			block: ["drop table"],
		});

		// 1. Always blocked command
		const resFork = await callTool("bash", { command: ":(){:|:&};:" });
		expect(resFork?.block).toBe(true);

		// 2. Git mutation command
		const resGit = await callTool("bash", { command: "rm -rf .git" });
		expect(resGit?.block).toBe(true);

		// 3. User block rule
		const resUser = await callTool("bash", { command: "psql -c 'drop table users;'" });
		expect(resUser?.block).toBe(true);

		expect(existsSync(auditLogFile)).toBe(true);
		const lines = readFileSync(auditLogFile, "utf-8").trim().split("\n");
		expect(lines.length).toBe(3);

		const parsedFork = JSON.parse(lines[0]);
		expect(parsedFork.decision).toBe("block");
		expect(parsedFork.toolName).toBe("bash");
		expect(parsedFork.rule).toBe("always_blocked");
		expect(parsedFork.target).toBe(":(){:|:&};:");
		expect(parsedFork.reason).toContain("dangerous command pattern detected");

		const parsedGit = JSON.parse(lines[1]);
		expect(parsedGit.decision).toBe("block");
		expect(parsedGit.toolName).toBe("bash");
		expect(parsedGit.rule).toBe("blockGitWrites");
		expect(parsedGit.target).toBe("rm -rf .git");

		const parsedUser = JSON.parse(lines[2]);
		expect(parsedUser.decision).toBe("block");
		expect(parsedUser.toolName).toBe("bash");
		expect(parsedUser.rule).toBe("user_rule");
		expect(parsedUser.target).toContain("drop table users");
	});

	it("logs blocked write and edit operations to JSONL", async () => {
		const { api, callTool } = createMockAery();
		damageControl(api, {
			audit_log_path: auditLogFile,
			protect: ["~/.ssh", "*.pem"],
			read_only: ["/etc/hosts"],
		});

		// 1. Git metadata write
		const resGitWrite = await callTool("write", {
			path: ".git/hooks/pre-push",
			content: "#!/bin/sh",
		});
		expect(resGitWrite?.block).toBe(true);

		// 2. Protected path write
		const resProtect = await callTool("write", {
			path: "~/.ssh/id_rsa",
			content: "SECRET",
		});
		expect(resProtect?.block).toBe(true);

		// 3. Read only path edit
		const resReadOnly = await callTool("edit", {
			path: "/etc/hosts",
			target: "127.0.0.1",
			replacement: "0.0.0.0",
		});
		expect(resReadOnly?.block).toBe(true);

		const lines = readFileSync(auditLogFile, "utf-8").trim().split("\n");
		expect(lines.length).toBe(3);

		const entryGit = JSON.parse(lines[0]);
		expect(entryGit.decision).toBe("block");
		expect(entryGit.toolName).toBe("write");
		expect(entryGit.rule).toBe("blockGitWrites");
		expect(entryGit.target).toBe(".git/hooks/pre-push");

		const entryProtect = JSON.parse(lines[1]);
		expect(entryProtect.decision).toBe("block");
		expect(entryProtect.toolName).toBe("write");
		expect(entryProtect.rule).toBe("protected_path");
		expect(entryProtect.target).toBe("~/.ssh/id_rsa");

		const entryReadOnly = JSON.parse(lines[2]);
		expect(entryReadOnly.decision).toBe("block");
		expect(entryReadOnly.toolName).toBe("edit");
		expect(entryReadOnly.rule).toBe("read_only");
		expect(entryReadOnly.target).toBe("/etc/hosts");
	});

	it("logs allowed operations to JSONL", async () => {
		const { api, callTool } = createMockAery();
		damageControl(api, { audit_log_path: auditLogFile });

		const resCmd = await callTool("bash", { command: "git status" });
		expect(resCmd).toBeUndefined();

		const resWrite = await callTool("write", {
			path: "src/utils.ts",
			content: "export const ok = true;",
		});
		expect(resWrite).toBeUndefined();

		const lines = readFileSync(auditLogFile, "utf-8").trim().split("\n");
		expect(lines.length).toBe(2);

		const entryCmd = JSON.parse(lines[0]);
		expect(entryCmd.decision).toBe("allow");
		expect(entryCmd.toolName).toBe("bash");
		expect(entryCmd.action).toBe("execute");
		expect(entryCmd.target).toBe("git status");
		expect(entryCmd.timestamp).toBeDefined();

		const entryWrite = JSON.parse(lines[1]);
		expect(entryWrite.decision).toBe("allow");
		expect(entryWrite.toolName).toBe("write");
		expect(entryWrite.action).toBe("write");
		expect(entryWrite.target).toBe("src/utils.ts");
		expect(entryWrite.timestamp).toBeDefined();
	});

	it("loads audit_log_path from YAML configuration", () => {
		const configPath = join(tempDir, "damage-control.yaml");
		const targetAuditPath = join(tempDir, "configured-audit.jsonl");

		writeFileSync(
			configPath,
			`allow_git_writes: false\naudit_log_path: "${targetAuditPath}"\nblock:\n  - dangerous\n`,
		);

		const config = loadConfig(configPath);
		expect(config.audit_log_path).toBe(targetAuditPath);
	});

	it("continues execution smoothly even if audit log writing fails due to unwritable path", async () => {
		const blockingFile = join(tempDir, "cannot-write-file");
		writeFileSync(blockingFile, "not-a-directory");
		const badAuditPath = join(blockingFile, "invalid-dir", "audit.jsonl");

		const { api, callTool } = createMockAery();
		damageControl(api, {
			audit_log_path: badAuditPath,
		});

		// Calling tool should evaluate and return without crashing
		const resAllowed = await callTool("bash", { command: "echo hello" });
		expect(resAllowed).toBeUndefined();

		const resBlocked = await callTool("bash", { command: "rm -rf /" });
		expect(resBlocked?.block).toBe(true);
	});
});
