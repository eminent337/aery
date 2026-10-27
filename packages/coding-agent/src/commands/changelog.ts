/**
 * Changelog Viewer CLI (`aery changelog`).
 *
 * Implements Google Antigravity-style changelog and release notes viewing.
 */

import { Command } from "@aryee337/aery-utils/cli";
import { getChangelogPath, parseChangelog } from "../utils/changelog";

export default class ChangelogCommand extends Command {
	static description = "Show changelog and release notes";
	static strict = false;

	async run(): Promise<void> {
		const { argv } = await this.parse(ChangelogCommand);
		const asJson = argv.includes("--json");
		const countArg = argv.find(a => /^\d+$/.test(a));
		const limit = countArg ? parseInt(countArg, 10) : 5;

		const changelogPath = getChangelogPath();
		const entries = await parseChangelog(changelogPath);

		if (entries.length === 0) {
			console.log("No changelog entries found.");
			return;
		}

		const displayed = entries.slice(0, limit);

		if (asJson) {
			console.log(JSON.stringify(displayed, null, 2));
			return;
		}

		console.log(`\n📦 Aery Changelog & Release Notes (Showing latest ${displayed.length} releases)\n`);
		for (const entry of displayed) {
			console.log(entry.content);
			console.log("\n----------------------------------------------------------------------\n");
		}
	}
}
