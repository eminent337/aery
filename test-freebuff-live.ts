import { streamSimple } from "./packages/ai/src/stream.ts";

async function main() {
    const rawModel = {
        id: "deepseek/deepseek-v4-flash",
        name: "Base 2 Free",
        api: "openai-completions",
        provider: "freebuff",
        baseUrl: "https://www.codebuff.com/api/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096
    };

    const context = {
        messages: [{ role: "user", content: "Say the exact word: BINGO", timestamp: Date.now() }]
    };

    try {
        const resultStream = streamSimple(rawModel as any, context as any, { apiKey: "79a55aad-2c59-4af5-88a1-1504e3d1d072" });
        for await (const chunk of resultStream) {
            console.log(chunk.type, chunk.error || chunk.delta || chunk.reason);
        }
        console.log("\nDone!");
    } catch (e) {
        console.error("Error:", e);
    }
}
main();
