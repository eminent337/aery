import { describe, expect, it } from "bun:test";
import { parseArgs } from "../args";

describe("CLI Flags Parity with Google Antigravity (agy)", () => {
	it("parses --dangerously-skip-permissions as autoApprove", () => {
		const parsed = parseArgs(["--dangerously-skip-permissions"]);
		expect(parsed.autoApprove).toBe(true);
		expect(parsed.dangerouslySkipPermissions).toBe(true);
	});

	it("parses --proceed-in-sandbox approval mode", () => {
		const parsed = parseArgs(["--approval-mode", "proceed-in-sandbox"]);
		expect(parsed.approvalMode).toBe("proceed-in-sandbox");
	});

	it("parses --input-format and --output-format stream-json", () => {
		const parsed = parseArgs(["--input-format", "stream-json", "--output-format", "stream-json"]);
		expect(parsed.inputFormat).toBe("stream-json");
		expect(parsed.outputFormat).toBe("stream-json");
	});

	it("parses --json-schema argument", () => {
		const schema = '{"type":"object","properties":{"name":{"type":"string"}}}';
		const parsed = parseArgs(["--json-schema", schema]);
		expect(parsed.jsonSchema).toBe(schema);
	});

	it("parses --hub and --remote-control flags", () => {
		const parsed = parseArgs(["--hub", "--remote-control"]);
		expect(parsed.hub).toBe(true);
		expect(parsed.remoteControl).toBe(true);
	});
});
