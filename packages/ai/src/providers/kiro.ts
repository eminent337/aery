/**
 * Kiro CLI provider.
 * Invokes the local kiro-cli binary in headless non-interactive mode.
 */
import { spawn } from "node:child_process";
import type { AssistantMessage, Context, Model, StreamOptions } from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { isKiroAuthenticated } from "../utils/oauth/kiro";

export interface KiroCliOptions extends StreamOptions {
	/** Path to the kiro-cli binary (defaults to KIRO_CLI_PATH env var or ~/.local/bin/kiro-cli) */
	kiroPath?: string;
}

function cleanKiroOutput(raw: string): string {
	// Strip ANSI escape codes
	const noAnsi = raw.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "");
	const lines = noAnsi.split("\n");
	const filtered = lines.filter(line => {
		const trimmed = line.trim();
		if (trimmed.startsWith("All tools are now trusted")) return false;
		if (trimmed.startsWith("Agents can sometimes do unexpected")) return false;
		if (trimmed.startsWith("Learn more at https://kiro.dev")) return false;
		if (trimmed.startsWith("▸ Credits:")) return false;
		return true;
	});
	let text = filtered.join("\n").trim();
	if (text.startsWith("> ")) {
		text = text.slice(2);
	} else if (text.startsWith("m> ")) {
		text = text.slice(3);
	}
	text = text.trim();
	// Rebrand Kiro CLI identity headers to Aery
	text = text.replace(/\bI'm Kiro\b/gi, "I'm Aery");
	text = text.replace(/\bKiro CLI\b/gi, "Aery");
	text = text.replace(/\bKiro\b/g, "Aery");
	return text;
}

/**
 * Stream from Kiro CLI by executing kiro-cli non-interactively.
 */
export function streamKiro(
	model: Model<"kiro-cli">,
	context: Context,
	options?: KiroCliOptions,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	(async () => {
		try {
			const kiroPath = options?.kiroPath || process.env.KIRO_CLI_PATH || `${process.env.HOME}/.local/bin/kiro-cli`;
			if (!(await isKiroAuthenticated(kiroPath))) {
				throw new Error("Kiro CLI is not authenticated. Please run kiro-cli login.");
			}
			// The CLI knows model ids without the provider prefix; strip a
			// leading "kiro/" (e.g. from "kiro/claude-sonnet-4.5" selectors).
			const modelId = (model.id || "claude-sonnet-4.5").replace(/^kiro\//, "");

			let promptText = "You are Aery, an advanced agentic AI coding assistant.\n\n";
			if (context.systemPrompt) {
				promptText += `System Instructions:\n${context.systemPrompt}\n\n`;
			}
			for (const msg of context.messages) {
				if (msg.role === "user") {
					const text =
						typeof msg.content === "string"
							? msg.content
							: msg.content
									.map(c => (c.type === "text" ? c.text : ""))
									.filter(Boolean)
									.join("\n");
					promptText += `User: ${text}\n`;
				} else if (msg.role === "assistant") {
					const text =
						typeof msg.content === "string"
							? msg.content
							: msg.content
									.map(c => (c.type === "text" ? c.text : ""))
									.filter(Boolean)
									.join("\n");
					promptText += `Assistant: ${text}\n`;
				}
			}

			if (!promptText.trim()) {
				promptText = "Hello";
			}

			const proc = spawn(kiroPath, ["chat", "--no-interactive", "--model", modelId, "-a", promptText], {
				env: { ...process.env, NO_COLOR: "1" },
			});

			let rawOutput = "";
			let rawStderr = "";
			let failed = false;
			const checkUnauthenticated = () => {
				if (failed) return;
				const combined = rawOutput + rawStderr;
				if (
					combined.includes("Opening browser") ||
					combined.includes("log in to Kiro") ||
					combined.includes("log in with") ||
					combined.includes("Not logged in") ||
					combined.includes("Confirm the following")
				) {
					failed = true;
					proc.kill();
					stream.fail(new Error("Kiro CLI is not authenticated. Please run kiro-cli login."));
				}
			};
			proc.stdout.on("data", (chunk: Buffer) => {
				rawOutput += chunk.toString();
				checkUnauthenticated();
			});
			proc.stderr.on("data", (chunk: Buffer) => {
				rawStderr += chunk.toString();
				checkUnauthenticated();
			});
			proc.on("error", err => {
				stream.fail(err);
			});

			proc.on("close", code => {
				if (code !== 0 && !rawOutput.trim()) {
					stream.fail(new Error(`kiro-cli failed with code ${code}: ${rawStderr}`));
					return;
				}

				const cleanedText = cleanKiroOutput(rawOutput);

				const assistantMessage: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: cleanedText }],
					model: model.id,
					api: model.api,
					provider: model.provider,
					stopReason: "stop",
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
					timestamp: Date.now(),
				};

				stream.push({ type: "start", partial: assistantMessage });
				stream.push({
					type: "text_delta",
					contentIndex: 0,
					delta: cleanedText,
					partial: assistantMessage,
				});
				stream.push({
					type: "done",
					message: assistantMessage,
					reason: "stop",
				});
			});
		} catch (err) {
			stream.fail(err);
		}
	})();

	return stream;
}
