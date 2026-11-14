import chalk from "chalk";
import { features as defaultFeatures, type FeatureManager } from "../config/features";
import { Settings } from "../config/settings";

export interface FeaturesCliOptions {
	json?: boolean;
}

export async function runFeaturesCommand(
	action: string | undefined,
	featureName: string | undefined,
	options: FeaturesCliOptions = {},
	manager: FeatureManager = defaultFeatures,
): Promise<void> {
	if (manager === defaultFeatures) {
		try {
			await Settings.init();
		} catch {}
	}

	const sub = action ?? "list";

	switch (sub) {
		case "list": {
			const list = manager.list();
			if (options.json) {
				process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
				return;
			}

			// Format columns: Name (36), Stage (20), Effective (8)
			for (const feat of list) {
				const nameCol = feat.name.padEnd(36);
				const stageCol = feat.stage.padEnd(20);
				const stateCol = feat.effective ? chalk.green("true") : chalk.dim("false");
				process.stdout.write(`${nameCol} ${stageCol} ${stateCol}\n`);
			}
			return;
		}

		case "enable": {
			if (!featureName) {
				process.stderr.write(`${chalk.red("Error: Feature name is required for enable")}\n`);
				process.exit(1);
			}
			const ok = await manager.set(featureName, true);
			if (!ok) {
				process.stderr.write(`${chalk.red(`Error: Unknown feature "${featureName}"`)}\n`);
				process.exit(1);
			}
			process.stdout.write(`${chalk.green("Enabled")} feature ${featureName}\n`);
			return;
		}

		case "disable": {
			if (!featureName) {
				process.stderr.write(`${chalk.red("Error: Feature name is required for disable")}\n`);
				process.exit(1);
			}
			const ok = await manager.set(featureName, false);
			if (!ok) {
				process.stderr.write(`${chalk.red(`Error: Unknown feature "${featureName}"`)}\n`);
				process.exit(1);
			}
			process.stdout.write(`${chalk.yellow("Disabled")} feature ${featureName}\n`);
			return;
		}

		default: {
			process.stderr.write(
				`${chalk.red(`Error: Unknown action "${action}". Valid actions are: list, enable, disable`)}\n`,
			);
			process.exit(1);
		}
	}
}
