import type { ExtensionAPI } from "@aryee337/aery";
import { RegistryFetcher } from "./registry";

export default function marketplaceExtension(aery: ExtensionAPI) {
	aery.setLabel("Aery Marketplace");

	const fetcher = new RegistryFetcher();

	aery.registerCommand("marketplace", {
		description: "Browse, install, and manage Aery extensions",
		handler: async (args, ctx) => {
			const command = args[0] || "list";

			if (command === "list") {
				try {
					ctx.ui.setStatus("marketplace", "Fetching registry...");
					const registry = await fetcher.fetchRegistry();
					let message = `**Aery Marketplace Registry v${registry.version}**\n\n`;
					for (const [id, pack] of Object.entries(registry.packs)) {
						message += `- **${id}** (v${pack.version}) [${pack.tier}]\n`;
						message += `  ${pack.description}\n`;
					}

					// For now we just print it to the user.
					// Phase 4 will introduce the FlexBox grid rendering.
					aery.appendEntry("chat", { role: "assistant", content: [{ type: "text", text: message }] });
				} catch (err) {
					ctx.ui.setStatus("marketplace", `Failed to fetch registry: ${err}`);
				}
			} else if (command === "install") {
				const packId = args[1];
				if (!packId) {
					ctx.ui.setStatus("marketplace", "Usage: /marketplace install <name>");
					return;
				}
				ctx.ui.setStatus("marketplace", `Marketplace: Install not yet implemented for ${packId}`);
			} else {
				ctx.ui.setStatus("marketplace", `Marketplace: Unknown command '${command}'`);
			}
		},
	});
}
