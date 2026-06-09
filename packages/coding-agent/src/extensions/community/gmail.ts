import type { AeryExtension, ExtensionAPI } from "@aryee337/aery-sdk";

const extension: AeryExtension = (api: ExtensionAPI) => {
	api.registerTool({
		name: "gmail_read",
		description: "Read emails from Gmail",
		parameters: { query: { type: "string", description: "Search query for emails", required: true } },
		execute: async (params: Record<string, unknown>) => {
			const query = params.query as string;
			return { content: `Reading emails matching: ${query}` };
		},
	});

	api.registerTool({
		name: "gmail_send",
		description: "Send an email via Gmail",
		parameters: {
			to: { type: "string", description: "Recipient email", required: true },
			subject: { type: "string", description: "Email subject", required: true },
			body: { type: "string", description: "Email body", required: true },
		},
		execute: async (params: Record<string, unknown>) => {
			const to = params.to as string;
			const subject = params.subject as string;
			return { content: `Email sent to ${to} with subject: ${subject}` };
		},
	});

	api.registerTool({
		name: "gmail_search",
		description: "Search Gmail",
		parameters: { query: { type: "string", description: "Search query", required: true } },
		execute: async (params: Record<string, unknown>) => {
			const query = params.query as string;
			return { content: `Search results for: ${query}` };
		},
	});

	api.registerTool({
		name: "gmail_label",
		description: "Apply a label to a Gmail thread",
		parameters: {
			threadId: { type: "string", description: "Thread ID", required: true },
			labelIds: { type: "array", description: "Label IDs to apply", required: true },
		},
		execute: async (params: Record<string, unknown>) => {
			const threadId = params.threadId as string;
			const labelIds = params.labelIds as string[];
			return { content: `Applied labels ${labelIds.join(",")} to thread ${threadId}` };
		},
	});
};

export default extension;
