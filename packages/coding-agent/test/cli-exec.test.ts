import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { prepareExecArgs, writeOutputLastMessage } from "../src/cli/exec-cli";
import { isSubcommand } from "../src/cli-commands";

describe("Exec CLI Subsystem", () => {
	it("registers exec and alias e in CLI command registry", () => {
		expect(isSubcommand("exec")).toBe(true);
		expect(isSubcommand("e")).toBe(true);
	});

	it("prepares headless execution arguments correctly", () => {
		const { parsed } = prepareExecArgs(["Summarize changes"], {
			prompt: "Summarize changes",
			json: true,
			ephemeral: true,
			model: "anthropic/claude-3-7-sonnet",
			outputSchema: "schema.json",
		});

		expect(parsed.print).toBe(true);
		expect(parsed.mode).toBe("json");
		expect(parsed.outputFormat).toBe("json");
		expect(parsed.noSession).toBe(true);
		expect(parsed.model).toBe("anthropic/claude-3-7-sonnet");
		expect(parsed.jsonSchema).toBe("schema.json");
		expect(parsed.messages).toContain("Summarize changes");
	});

	it("writes final message content to specified file", async () => {
		const tempFile = path.join(
			os.tmpdir(),
			`aery-exec-last-msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`,
		);

		await writeOutputLastMessage(tempFile, "Task completed successfully.");
		const content = await fs.readFile(tempFile, "utf8");

		expect(content).toBe("Task completed successfully.");
		await fs.unlink(tempFile);
	});
});
