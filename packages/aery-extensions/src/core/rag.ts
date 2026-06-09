import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@aryee337/aery";
import { globSync } from "glob";

// In-memory vector store
const vectorStore: Array<{ path: string; chunkIndex: number; text: string; embedding: number[] }> = [];
let pipelineFn: any = null;

// Cosine similarity
function cosineSimilarity(vecA: number[], vecB: number[]) {
	let dotProduct = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < vecA.length; i++) {
		dotProduct += vecA[i] * vecB[i];
		normA += vecA[i] * vecA[i];
		normB += vecB[i] * vecB[i];
	}
	return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export default function ragExtension(aery: ExtensionAPI) {
	aery.registerTool({
		name: "rag_index",
		label: "RAG Index",
		description:
			"Index files in the current directory using local semantic embeddings. Required before using semantic_search.",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Glob pattern to match files (e.g., 'src/**/*.ts')." },
			},
			required: ["pattern"],
		},
		async execute(_id, args: any) {
			const pattern = (args as any).pattern;
			const res = await autoIndex(pattern);
			return { content: [{ type: "text", text: res }] };
		},
	});

	async function autoIndex(pattern: string = "**/*.{ts,js,md,json}") {
		let xenova;
		try {
			xenova = await import("@xenova/transformers");
		} catch (e) {
			throw new Error("Missing dependencies. Run `npm i @xenova/transformers glob` to enable RAG.");
		}

		if (!pipelineFn) {
			pipelineFn = await xenova.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
		}

		const files = globSync(pattern, { ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"] });

		let chunksIndexed = 0;
		vectorStore.length = 0; // Clear existing

		for (const file of files) {
			try {
				const text = readFileSync(file, "utf-8");
				// Chunking: extremely simple split by newlines for demo purposes
				const lines = text.split("\n");
				const chunkSize = 20;
				for (let i = 0; i < lines.length; i += chunkSize) {
					const chunk = lines
						.slice(i, i + chunkSize)
						.join("\n")
						.trim();
					if (chunk.length < 10) continue;

					const output = await pipelineFn(chunk, { pooling: "mean", normalize: true });
					vectorStore.push({
						path: file,
						chunkIndex: i,
						text: chunk,
						embedding: Array.from(output.data),
					});
					chunksIndexed++;
				}
			} catch (e) {} // Skip unreadable
		}
		return `Successfully indexed ${chunksIndexed} code chunks from ${files.length} files.`;
	}

	aery.registerTool({
		name: "semantic_search",
		label: "Semantic Search",
		description:
			"Search the local codebase semantically using natural language queries. Automatically indexes if not done yet.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "The question or concept to search for." },
				topK: { type: "number", description: "Number of results to return (default: 5)." },
			},
			required: ["query"],
		},
		async execute(_id, args: any) {
			if (vectorStore.length === 0) {
				await autoIndex(); // Auto-index if not done manually
			}

			const query = (args as any).query;
			const topK = (args as any).topK || 5;

			const output = await pipelineFn(query, { pooling: "mean", normalize: true });
			const queryVector = Array.from(output.data) as number[];

			const results = vectorStore
				.map(doc => ({ ...doc, score: cosineSimilarity(queryVector, doc.embedding) }))
				.sort((a, b) => b.score - a.score)
				.slice(0, topK);

			const resultText = results
				.map(r => `[Score: ${r.score.toFixed(3)}] File: ${r.path} (Line ~${r.chunkIndex})\n---\n${r.text}\n---`)
				.join("\n\n");

			return { content: [{ type: "text", text: resultText || "No matching results found." }] };
		},
	});
}
