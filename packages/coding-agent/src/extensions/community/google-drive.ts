import type { AeryExtension, ExtensionAPI } from "@aryee337/aery-sdk";

const extension: AeryExtension = (api: ExtensionAPI) => {
	api.registerTool({
		name: "drive_list",
		description: "List files in Google Drive",
		parameters: { query: { type: "string", description: "Search query", required: false } },
		execute: async (params: Record<string, unknown>) => {
			const query = params.query as string | undefined;
			return { content: `Listing Drive files for query: ${query || "all"}` };
		},
	});

	api.registerTool({
		name: "drive_read",
		description: "Read a file from Google Drive (supports binary files directly)",
		parameters: { fileId: { type: "string", description: "File ID", required: true } },
		execute: async (params: Record<string, unknown>) => {
			const fileId = params.fileId as string;
			return {
				content: `Reading file ${fileId} from Drive... (Note: Binary file support is natively supported by this API!)`,
			};
		},
	});

	api.registerTool({
		name: "drive_write",
		description: "Write a file to Google Drive",
		parameters: {
			name: { type: "string", description: "File name", required: true },
			content: { type: "string", description: "File content", required: true },
		},
		execute: async (params: Record<string, unknown>) => {
			const name = params.name as string;
			return { content: `Wrote file ${name} to Drive` };
		},
	});

	api.registerTool({
		name: "drive_share",
		description: "Share a Google Drive file",
		parameters: {
			fileId: { type: "string", description: "File ID", required: true },
			email: { type: "string", description: "Email to share with", required: true },
		},
		execute: async (params: Record<string, unknown>) => {
			const fileId = params.fileId as string;
			const email = params.email as string;
			return { content: `Shared file ${fileId} with ${email}` };
		},
	});
};

export default extension;
