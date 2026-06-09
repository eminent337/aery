import type { AeryExtension, ExtensionAPI } from "@aryee337/aery-sdk";

const extension: AeryExtension = (api: ExtensionAPI) => {
	api.registerTool({
		name: "stitch_list",
		description: "List Stitch designs",
		parameters: { projectId: { type: "string", description: "Project ID", required: true } },
		execute: async (params: Record<string, unknown>) => {
			const projectId = params.projectId as string;
			return { content: `Listing designs for Stitch project ${projectId}` };
		},
	});

	api.registerTool({
		name: "stitch_fetch",
		description: "Fetch a Google Stitch design",
		parameters: { designId: { type: "string", description: "Design ID", required: true } },
		execute: async (params: Record<string, unknown>) => {
			const designId = params.designId as string;
			return { content: `Fetched Stitch design ${designId}` };
		},
	});

	api.registerTool({
		name: "stitch_generate",
		description: "Generate code from a Stitch design",
		parameters: { designId: { type: "string", description: "Design ID", required: true } },
		execute: async (params: Record<string, unknown>) => {
			const designId = params.designId as string;
			return { content: `Generated code for Stitch design ${designId}` };
		},
	});
};

export default extension;
