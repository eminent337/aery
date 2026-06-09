// @ts-nocheck — example file; install @aryee337/aery-coding-agent before running
import type { ExtensionAPI } from "@aryee337/aery-coding-agent";

export default function myPlugin(aery: ExtensionAPI) {
  aery.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("my-plugin loaded from example marketplace!", "info");
  });
}
