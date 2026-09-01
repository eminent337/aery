import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { __getPrivacyAuditLogPath, __setPrivacyAuditLogPath, appendPrivacyAudit } from "../src/privacy/audit-log";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-audit-test-"));

afterEach(() => {
	__setPrivacyAuditLogPath(undefined);
});

describe("privacy audit log", () => {
	it("appends one JSONL line per entry, never the secret", async () => {
		__setPrivacyAuditLogPath(path.join(tmpDir, "audit.jsonl"));
		appendPrivacyAudit({
			ts: 1_710_000_000_000,
			provider: "opencode-zen",
			model: "muse-spark-1.2-contributor-free",
			categories: ["aws-access-key"],
			sensitiveKinds: [],
			action: "block",
		});
		appendPrivacyAudit({
			ts: 1_710_000_000_001,
			provider: "opencode-zen",
			model: "muse-spark-1.2-contributor-free",
			categories: ["openai-api-key"],
			sensitiveKinds: [],
			action: "warn",
		});

		const resolved = __getPrivacyAuditLogPath();
		// appendFile is async/fire-and-forget; wait for the writes to land.
		for (let i = 0; i < 50; i++) {
			if (fs.existsSync(resolved) && fs.readFileSync(resolved, "utf8").split("\n").filter(Boolean).length >= 2)
				break;
			await Bun.sleep(10);
		}
		const lines = fs.readFileSync(resolved, "utf8").split("\n").filter(Boolean);
		const parsed = lines
			.map(line => JSON.parse(line!) as { ts: number; action: string; model: string; categories: string[] })
			.sort((a, b) => a.ts - b.ts);
		expect(parsed).toHaveLength(2);

		const first = parsed[0]!;
		expect(first.model).toBe("muse-spark-1.2-contributor-free");
		expect(first.categories).toEqual(["aws-access-key"]);
		expect(JSON.stringify(first)).not.toContain("AKIA");
		expect(JSON.stringify(first)).not.toContain("secret-value");
		expect((first as Record<string, unknown>).aws_access_key_value).toBeUndefined();
	});

	it("never throws when the path is unwritable/invalid", async () => {
		__setPrivacyAuditLogPath(path.join(tmpDir, "no-such-dir", "audit.jsonl"));
		expect(() =>
			appendPrivacyAudit({
				ts: 1_710_000_000_002,
				provider: "x",
				model: "y",
				categories: [],
				sensitiveKinds: ["dotenv"],
				action: "warn",
			}),
		).not.toThrow();
		await Bun.sleep(20); // give the rejected promise a chance to surface (must stay silent)
	});

	it("defaults to the real agent dir", () => {
		__setPrivacyAuditLogPath(undefined);
		expect(__getPrivacyAuditLogPath()).toContain("privacy-audit.log");
	});
});
