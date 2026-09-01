import { describe, expect, it } from "bun:test";
import {
	containsSensitiveContent,
	scanTextForSensitiveContent,
	shouldEscalateToBlock,
} from "../src/privacy/sensitive-content";

describe("sensitive-content: hashline path markers", () => {
	it("detects a top-level ¶.env#tag hashline header", () => {
		const text =
			"¶.env#A1B2\nDATABASE_URL=postgres://admin:s3cr3t@db:5432/prod\nAPI_KEY=sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789\n";
		const r = scanTextForSensitiveContent(text);
		const kinds = r.findings.map(f => f.kind);
		expect(kinds).toContain("dotenv");
	});
	it("detects ¶credentials.json#tag", () => {
		const r = scanTextForSensitiveContent('¶credentials.json#F00D\n{"type":"service_account"}');
		expect(r.findings.map(f => f.kind)).toContain("credentials");
	});
	it("detects a relative path mention `.env`", () => {
		const r = scanTextForSensitiveContent("the .env file has the keys");
		expect(r.findings.map(f => f.kind)).toContain("dotenv");
	});
	it("detects src/.env and ~/.env", () => {
		expect(scanTextForSensitiveContent("read src/.env for the port").findings.length).toBeGreaterThan(0);
		expect(scanTextForSensitiveContent("~/.env contains secrets").findings.length).toBeGreaterThan(0);
	});
	it("detects .env.local / .env.production but NOT .env.example", () => {
		expect(scanTextForSensitiveContent("¶.env.local#BEEF").findings.map(f => f.kind)).toContain("dotenv");
		expect(scanTextForSensitiveContent("¶.env.production#BEEF").findings.map(f => f.kind)).toContain("dotenv");
		expect(scanTextForSensitiveContent(".env.example is committed").findings).toEqual([]);
		expect(scanTextForSensitiveContent(".env.sample is committed").findings).toEqual([]);
		expect(scanTextForSensitiveContent(".env.template is harmless").findings).toEqual([]);
	});
});

describe("sensitive-content: credentials / private keys / auth stores", () => {
	it("detects credentials.json path", () => {
		expect(
			scanTextForSensitiveContent("λ client_secret.json for the oauth flow").findings.map(f => f.kind),
		).toContain("credentials");
		expect(scanTextForSensitiveContent("service-account.json in gcloud").findings.map(f => f.kind)).toContain(
			"credentials",
		);
	});
	it("detects private key files", () => {
		const r = scanTextForSensitiveContent("¶id_rsa#TAG\n-----BEGIN OPENSSH PRIVATE KEY-----");
		expect(r.findings.map(f => f.kind)).toContain("private-key-file");
		expect(scanTextForSensitiveContent("deploy-2024.pem").findings.map(f => f.kind)).toContain("private-key-file");
	});
	it("detects auth stores", () => {
		expect(scanTextForSensitiveContent("read ~/.aery/agent/auth.json").findings.map(f => f.kind)).toContain(
			"auth-db",
		);
		expect(scanTextForSensitiveContent("agent.db rows").findings.map(f => f.kind)).toContain("auth-db");
	});
	it("detects models.yml", () => {
		expect(scanTextForSensitiveContent("models.yml key fields").findings.map(f => f.kind)).toContain("models-yml");
		expect(scanTextForSensitiveContent("models.yaml").findings.map(f => f.kind)).toContain("models-yml");
	});
});

describe("sensitive-content: negatives (no false positives)", () => {
	it("ignores process.env and NODE_ENV", () => {
		expect(scanTextForSensitiveContent("process.env.PORT || 3000").findings).toEqual([]);
		expect(scanTextForSensitiveContent("NODE_ENV=production foo").findings).toEqual([]);
	});
	it("ignores .env.example / .env.sample", () => {
		expect(scanTextForSensitiveContent(".env.example keys are placeholders").findings).toEqual([]);
	});
	it("ignores ordinary source identifiers", () => {
		expect(scanTextForSensitiveContent('import env from "./env.ts"').findings).toEqual([]);
		expect(scanTextForSensitiveContent('const config = { env: "prod" }').findings).toEqual([]);
		expect(scanTextForSensitiveContent("config.json is the app config").findings).toEqual([]);
	});
	it("ignores normal code that mentions words like credentials", () => {
		expect(scanTextForSensitiveContent("the credentials module exports a client").findings).toEqual([]);
	});
});

describe("sensitive-content: dotenv structure heuristic", () => {
	it("flags 3+ secret-shaped KEY=value lines", () => {
		const env = [
			"DB_HOST=postgres.example.com",
			"DB_PASSWORD=hunter2password",
			"API_TOKEN=sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
		].join("\n");
		const r = scanTextForSensitiveContent(env);
		expect(r.findings.map(f => f.kind)).toContain("dotenv");
	});
	it("does not flag 1-2 lines or short placeholders", () => {
		const short = ["FOO=bar", "BAR=baz"].join("\n");
		expect(scanTextForSensitiveContent(short).findings).toEqual([]);
		const oneSecretLine = "PASSWORD=supersecretvalue";
		expect(scanTextForSensitiveContent(oneSecretLine).findings).toEqual([]);
	});
	it("does not flag normal code with assignments", () => {
		const code = ['const name = "alice"', "const age = 30", 'const city = "paris"'].join("\n");
		expect(scanTextForSensitiveContent(code).findings).toEqual([]);
	});
});

describe("sensitive-content: escalation", () => {
	it("escalates dotenv marker + secret to block", () => {
		const text = "¶.env#A1B2\nOPENAI_API_KEY=sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd";
		expect(shouldEscalateToBlock(text)).toBe(true);
	});
	it("does not escalate a bare marker without a secret", () => {
		expect(shouldEscalateToBlock("¶.env#A1B2\nPORT=3000")).toBe(false);
	});
	it("does not escalate a secret with no marker", () => {
		expect(shouldEscalateToBlock("the key AKIAIOSFODNN7EXAMPLE was rotated")).toBe(false);
	});
	it("does not escalate a prose mention of a sensitive file even with a secret", () => {
		// merch mention: "models.yml" appears in prose, not as a path read —
		// the strong `¶`/`src/`/`read ` context is absent, so no block.
		expect(
			shouldEscalateToBlock("configure models.yml with OPENAI_API_KEY=sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd"),
		).toBe(false);
	});
	it("escalates a path-context marker (read .env) + secret", () => {
		expect(
			shouldEscalateToBlock("read .env and here is OPENAI_API_KEY=sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd"),
		).toBe(true);
	});
});

describe("sensitive-content: containsSensitiveContent", () => {
	it("returns true for sensitive markers", () => {
		expect(containsSensitiveContent("¶.env#TAG content")).toBe(true);
	});
	it("returns false for ordinary text", () => {
		expect(containsSensitiveContent("just normal code review feedback")).toBe(false);
	});
});
