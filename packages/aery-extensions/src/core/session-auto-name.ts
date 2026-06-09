/**
 * Auto-name sessions from the first user message.
 * Truncates to 40 chars so /resume is navigable.
 */

import type { ExtensionAPI } from "@aryee337/aery";

export default function (aery: ExtensionAPI) {
	let named = false;

	aery.on("session_start", () => {
		named = false;
	});

	aery.on("turn_end", async (_event, ctx) => {
		if (named) return;
		if (aery.getSessionName()) {
			named = true;
			return;
		}

		const entries = ctx.sessionManager.getBranch();
		const first = entries.find(e => e.type === "message" && (e as any).message?.role === "user");
		if (!first) return;

		const msg = (first as any).message;
		const text: string = Array.isArray(msg.content)
			? (msg.content.find((c: any) => c.type === "text")?.text ?? "")
			: (msg.content ?? "");

		const name = text.trim().slice(0, 40).replace(/\n/g, " ") || "session";
		aery.setSessionName(name);
		named = true;
	});
}
