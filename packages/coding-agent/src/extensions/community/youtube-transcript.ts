import type { AeryExtension, ExtensionAPI } from "@aryee337/aery-sdk";

const extension: AeryExtension = (api: ExtensionAPI) => {
	api.registerTool({
		name: "youtube_transcript",
		description: "Fetch a YouTube video transcript",
		parameters: { videoId: { type: "string", description: "YouTube video ID", required: true } },
		execute: async (params: Record<string, unknown>) => {
			const videoId = params.videoId as string;
			return { content: `Fetched transcript for video ${videoId}` };
		},
	});

	api.registerTool({
		name: "youtube_chapters",
		description: "Fetch YouTube video chapters",
		parameters: { videoId: { type: "string", description: "YouTube video ID", required: true } },
		execute: async (params: Record<string, unknown>) => {
			const videoId = params.videoId as string;
			return { content: `Fetched chapters for video ${videoId}` };
		},
	});

	api.registerTool({
		name: "youtube_summary",
		description: "Summarize a YouTube video",
		parameters: { videoId: { type: "string", description: "YouTube video ID", required: true } },
		execute: async (params: Record<string, unknown>) => {
			const videoId = params.videoId as string;
			return { content: `Summary for video ${videoId}` };
		},
	});
};

export default extension;
