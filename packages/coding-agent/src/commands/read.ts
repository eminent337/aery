/**
 * Show what the read tool will return for a given path.
 */
import { Args, Command } from "@aryee337/aery-utils/cli";
import { type ReadCommandArgs, runReadCommand } from "../cli/read-cli";
import { initTheme } from "../modes/theme/theme";

export default class Read extends Command {
	static description = "Show what the read tool will return for a path or URL";

	static args = {
		path: Args.string({
			description: "Path or URL to read (append :sel for line ranges or raw mode, e.g. src/foo.ts:50-100)",
			required: true,
		}),
	};

	static examples = [
		"aery read src/foo.ts",
		"aery read src/foo.ts:50-100",
		"aery read src/foo.ts:raw",
		"aery read https://example.com",
		"aery read path/to/archive.zip:dir/file.ts",
		"aery read path/to/db.sqlite:users:42",
	];

	async run(): Promise<void> {
		const { args } = await this.parse(Read);
		const cmd: ReadCommandArgs = {
			path: args.path ?? "",
		};
		await initTheme();
		await runReadCommand(cmd);
	}
}
