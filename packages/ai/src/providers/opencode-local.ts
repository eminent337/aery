/**
 * Local OpenCode CLI execution provider.
 * Delegates streaming completion to the host machine's installed OpenCode binary
 * ('opencode run -m opencode/<modelId> --format json <prompt>').
 * Provides 100% resilience against Cloudflare edge 429 FreeUsageLimitError blocks.
 */
import { spawn, execSync } from "node:child_process";
import type {
	AssistantMessage,
	Context,
	Model,
	TextContent,
} from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import type { OpenAICompletionsOptions } from "./openai-completions";

let cachedOpenCodePath: string | null | undefined = undefined;

export function getLocalOpenCodeBinary(): string | null {
	if (cachedOpenCodePath !== undefined) {
		return cachedOpenCodePath;
	}
	try {
		const stdout = execSync("which opencode", { stdio: ["ignore", "pipe", "ignore"], encoding: "utf-8" });
		const binary = stdout.trim();
		cachedOpenCodePath = binary.length > 0 ? binary : null;
	} catch {
		cachedOpenCodePath = null;
	}
	return cachedOpenCodePath;
}

export function isLocalOpenCodeAvailable(): boolean {
	return getLocalOpenCodeBinary() !== null;
}

function extractPromptFromContext(context: Context): string {
	const parts: string[] = [];

	if (context.systemPrompt) {
		const sys = Array.isArray(context.systemPrompt)
			? context.systemPrompt.join("\n\n")
			: context.systemPrompt;
		if (sys.trim().length > 0) {
			parts.push(sys.trim());
		}
	}

	for (const msg of context.messages) {
		if (msg.role === "user") {
			const textParts: string[] = [];
			if (typeof msg.content === "string") {
				textParts.push(msg.content);
			} else if (Array.isArray(msg.content)) {
				for (const item of msg.content) {
					if (item.type === "text" && item.text) {
						textParts.push(item.text);
					}
				}
			}
			if (textParts.length > 0) {
				parts.push(textParts.join("\n"));
			}
		} else if (msg.role === "assistant") {
			const textParts: string[] = [];
			if (typeof msg.content === "string") {
				textParts.push(msg.content);
			} else if (Array.isArray(msg.content)) {
				for (const item of msg.content) {
					if (item.type === "text" && item.text) {
						textParts.push(item.text);
					}
				}
			}
			if (textParts.length > 0) {
				parts.push(`Assistant: ${textParts.join("\n")}`);
			}
		}
	}

	return parts.join("\n\n");
}

export function streamOpenCodeLocalCli(
	model: Model<"openai-completions">,
	context: Context,
	options?: OpenAICompletionsOptions,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const startTime = Date.now();
	let firstTokenTime: number | undefined;

	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
	};

	(async () => {
		const binary = getLocalOpenCodeBinary() || "opencode";
		const prompt = extractPromptFromContext(context);
		const modelTarget = model.id.startsWith("opencode/") ? model.id : `opencode/${model.id}`;

		const args = ["run", "-m", modelTarget, "--format", "json", prompt];

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(binary, args, {
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err) {
			output.stopReason = "error";
			output.errorMessage = err instanceof Error ? err.message : String(err);
			stream.push({ type: "error", reason: "error", error: output });
			stream.end();
			return;
		}

		let started = false;
		let textStarted = false;
		let fullText = "";
		let textBlock: TextContent | undefined;
		let buffer = "";

		const cleanupAbort = () => {
			if (options?.signal) {
				options.signal.removeEventListener("abort", onAbort);
			}
		};

		const onAbort = () => {
			try {
				child.kill("SIGTERM");
			} catch {}
			output.stopReason = "aborted";
			output.errorMessage = "Request was aborted";
			stream.push({ type: "error", reason: "aborted", error: output });
			stream.end();
		};

		if (options?.signal) {
			if (options.signal.aborted) {
				onAbort();
				return;
			}
			options.signal.addEventListener("abort", onAbort, { once: true });
		}

		const processLine = (line: string) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			try {
				const event = JSON.parse(trimmed);
				if (!started) {
					started = true;
					stream.push({ type: "start", partial: output });
				}

				if (event.type === "text" && event.part?.text) {
					const delta = event.part.text as string;
					if (!firstTokenTime) {
						firstTokenTime = Date.now();
					}
					if (!textStarted) {
						textStarted = true;
						textBlock = { type: "text", text: delta };
						output.content.push(textBlock);
						stream.push({ type: "text_start", contentIndex: 0, partial: output });
					} else if (textBlock) {
						textBlock.text += delta;
					}
					fullText += delta;
					stream.push({ type: "text_delta", contentIndex: 0, delta, partial: output });
				} else if (event.type === "step_finish" && event.part?.tokens) {
					const tokens = event.part.tokens;
					output.usage.input = tokens.input ?? output.usage.input;
					output.usage.output = tokens.output ?? output.usage.output;
					output.usage.cacheRead = tokens.cache?.read ?? 0;
					output.usage.cacheWrite = tokens.cache?.write ?? 0;
					output.usage.totalTokens = tokens.total ?? (output.usage.input + output.usage.output);
					if (event.part.reason) {
						output.stopReason = event.part.reason === "stop" ? "stop" : "stop";
					}
				}
			} catch {}
		};

		child.stdout?.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf-8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				processLine(line);
			}
		});

		let stderrOutput = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrOutput += chunk.toString("utf-8");
		});

		child.on("error", (err: Error) => {
			cleanupAbort();
			output.stopReason = "error";
			output.errorMessage = err.message;
			stream.push({ type: "error", reason: "error", error: output });
			stream.end();
		});

		child.on("close", (code: number | null) => {
			cleanupAbort();
			if (buffer.trim()) {
				processLine(buffer);
			}

			if (textStarted && textBlock) {
				stream.push({ type: "text_end", contentIndex: 0, content: fullText, partial: output });
			}

			output.duration = Date.now() - startTime;
			if (firstTokenTime) {
				output.ttft = firstTokenTime - startTime;
			}

			if (code !== 0 && fullText.length === 0) {
				output.stopReason = "error";
				output.errorMessage = stderrOutput.trim() || `OpenCode CLI exited with code ${code}`;
				stream.push({ type: "error", reason: "error", error: output });
				stream.end();
				return;
			}

			output.stopReason = "stop";
			stream.push({ type: "done", reason: "stop", message: output });
			stream.end();
		});
	})();

	return stream;
}
