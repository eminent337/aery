import * as fs from "node:fs/promises";
import type { Args } from "./args";
import { parseArgs } from "./args";

export interface ExecOptions {
	prompt?: string;
	outputLastMessage?: string;
	json?: boolean;
	ephemeral?: boolean;
	outputSchema?: string;
	model?: string;
}

export function prepareExecArgs(argv: string[], options: ExecOptions = {}): { parsed: Args; rawArgs: string[] } {
	const rawArgs = [...argv];
	const parsed = parseArgs(rawArgs);

	// Force non-interactive print mode
	parsed.print = true;

	if (options.json) {
		parsed.mode = "json";
		parsed.outputFormat = "json";
	}

	if (options.ephemeral) {
		parsed.noSession = true;
	}

	if (options.outputSchema) {
		parsed.jsonSchema = options.outputSchema;
	}

	if (options.model) {
		parsed.model = options.model;
	}

	if (options.prompt && (!parsed.messages || parsed.messages.length === 0)) {
		parsed.messages = [options.prompt];
	}

	return { parsed, rawArgs };
}

export async function writeOutputLastMessage(filePath: string, content: string): Promise<void> {
	await fs.writeFile(filePath, content, "utf8");
}
