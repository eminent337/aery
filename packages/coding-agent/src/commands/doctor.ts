import { Command, Flags } from "@aryee337/aery-utils/cli";
import { runDoctorCommand } from "../cli/doctor-cli";

export default class Doctor extends Command {
	static description = "Diagnose local Aery installation, config, auth, and runtime health";

	static flags = {
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON output", default: false }),
		summary: Flags.boolean({ char: "s", description: "Only show grouped check rows and summary", default: false }),
		all: Flags.boolean({ char: "a", description: "Expand long lists in detailed human output", default: false }),
	};

	static examples = ["aery doctor", "aery doctor --summary", "aery doctor --json"];

	async run(): Promise<void> {
		const { flags } = await this.parse(Doctor);
		await runDoctorCommand({
			json: flags.json,
			summary: flags.summary,
			all: flags.all,
		});
	}
}
