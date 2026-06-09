// @ts-nocheck — example file; install @aryee337/aery-coding-agent before running
import type { ExtensionAPI } from "@aryee337/aery-coding-agent";

export default function helloExtension(aery: ExtensionAPI) {
  // Show a greeting whenever a session starts.
  aery.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Hello from hello-extension!", "info");
  });

  // Register a /hello slash command that sends a greeting into the conversation.
  aery.registerCommand("hello", {
    description: "Send a greeting into the conversation",
    handler: async (args, ctx) => {
      const name = args.trim() || "there";
      aery.sendMessage(
        {
          customType: "hello-extension",
          content: `Hello, ${name}!`,
          display: true,
          attribution: "user",
        },
        { triggerTurn: false }
      );
      ctx.ui.notify("Message sent!", "info");
    },
  });
}
