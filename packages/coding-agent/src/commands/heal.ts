/**
 * Autonomous Self-Healing CLI Command (`aery heal`).
 *
 * Runs a command; if it fails, spawns an isolated worktree to diagnose and heal the failure.
 */

import { Command } from "@aryee337/aery-utils/cli";
import { AutonomousHealer } from "../healing/autonomous-healer";

export async function handleHealCli(argv: string[]): Promise<void> {
	if (argv.length === 0) {
		console.error("Usage: aery heal <command> [--apply] [--attempts <n>]");
		process.exit(1);
	}

	const autoApply = argv.includes("--apply");
	const attemptsIdx = argv.indexOf("--attempts");
	const maxAttempts = attemptsIdx !== -1 && argv[attemptsIdx + 1] ? parseInt(argv[attemptsIdx + 1], 10) : 3;

	const cmdArgs = argv.filter(a => a !== "--apply" && a !== "--attempts" && a !== String(maxAttempts));
	const command = cmdArgs.join(" ");

	console.log(`\n🩺 Aery Autonomous Healer: Verifying '${command}'...`);

	const healer = new AutonomousHealer(process.cwd());
	const result = await healer.heal(command, undefined, {
		autoApply,
		maxAttempts,
		cwd: process.cwd(),
	});

	if (result.success) {
		console.log(`\n✅ ${result.summary}`);
		if (result.repairedDiff) {
			console.log("\nGenerated Healing Patch:");
			console.log("--------------------------------------------------");
			console.log(result.repairedDiff);
			console.log("--------------------------------------------------");
			if (result.applied) {
				console.log("Applied patch to working directory.");
			} else {
				console.log("Run with --apply to automatically apply this patch.");
			}
		}
	} else {
		console.error(`\n❌ ${result.summary}`);
		console.error("Initial Error Output:\n", result.initialError);
		process.exit(1);
	}
}

export default class HealCommand extends Command {
	static description = "Autonomously heal failing build or test commands in an isolated worktree";
	static strict = false;

	async run(): Promise<void> {
		const { argv } = await this.parse(HealCommand);
		await handleHealCli(argv as string[]);
	}
}
