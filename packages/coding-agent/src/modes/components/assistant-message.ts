import type { AssistantMessage, ImageContent, Usage } from "@aryee337/aery-ai";
import { Container, Image, ImageProtocol, Markdown, Spacer, TERMINAL, Text } from "@aryee337/aery-tui";
import { formatNumber } from "@aryee337/aery-utils";
import { settings } from "../../config/settings";
import type { AssistantThinkingRenderer } from "../../extensibility/extensions/types";
import { filterTaggableText } from "../../extensions/hide-thinking-text";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import { isSilentAbort } from "../../session/messages";
import { resolveImageOptions } from "../../tools/render-utils";

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	#contentContainer: Container;
	#lastMessage?: AssistantMessage;
	#toolImagesByCallId = new Map<string, ImageContent[]>();
	#usageInfo?: Usage;
	#convertedKittyImages = new Map<string, ImageContent>();
	#kittyConversionsInFlight = new Set<string>();

	constructor(
		message?: AssistantMessage,
		private hideThinkingBlock = false,
		private readonly onImageUpdate?: () => void,
		private readonly thinkingRenderers: readonly AssistantThinkingRenderer[] = [],
	) {
		super();

		// Container for text/thinking content
		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override render(width: number): string[] {
		// Read bar color from the live theme singleton on every render so theme
		// switches are reflected immediately — the same pattern OpenClaude uses
		// by calling useTheme() inside each component's render function.
		const BAR_COLOR = theme.fg.bind(theme, "accent");
		const RESET = "\x1b[0m";
		const bar = `${BAR_COLOR("▎")} `;

		// Reduce width to account for the left bar
		const contentWidth = Math.max(1, width - 2);
		const lines = super.render(contentWidth);
		if (lines.length === 0) {
			return lines;
		}

		// Insert the header immediately before the content, avoiding double-spacing if possible.
		// We'll just prepend the header as a new line.
		const header = `${bar}${theme.bold(BAR_COLOR("Aery"))}`;

		// Prefix all content lines
		for (let i = 0; i < lines.length; i++) {
			lines[i] = bar + lines[i];
		}

		return ["", header, ...lines];
	}

	override invalidate(): void {
		super.invalidate();
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
	}

	setToolResultImages(toolCallId: string, images: ImageContent[]): void {
		if (!toolCallId) return;
		const validImages = images.filter(img => img.type === "image" && img.data && img.mimeType);
		for (const key of Array.from(this.#convertedKittyImages.keys())) {
			if (key.startsWith(`${toolCallId}:`)) {
				this.#convertedKittyImages.delete(key);
			}
		}
		for (const key of Array.from(this.#kittyConversionsInFlight)) {
			if (key.startsWith(`${toolCallId}:`)) {
				this.#kittyConversionsInFlight.delete(key);
			}
		}
		if (validImages.length === 0) {
			this.#toolImagesByCallId.delete(toolCallId);
		} else {
			this.#toolImagesByCallId.set(toolCallId, validImages);
			this.#convertToolImagesForKitty(toolCallId, validImages);
		}
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage);
		}
	}

	#convertToolImagesForKitty(toolCallId: string, images: ImageContent[]): void {
		if (TERMINAL.imageProtocol !== ImageProtocol.Kitty) return;
		for (let index = 0; index < images.length; index++) {
			const image = images[index];
			if (!image || image.mimeType === "image/png") continue;
			const key = `${toolCallId}:${index}`;
			if (this.#convertedKittyImages.has(key) || this.#kittyConversionsInFlight.has(key)) continue;
			this.#kittyConversionsInFlight.add(key);
			new Bun.Image(Buffer.from(image.data, "base64"))
				.png()
				.toBase64()
				.then(data => {
					this.#kittyConversionsInFlight.delete(key);
					this.#convertedKittyImages.set(key, {
						type: "image",
						data,
						mimeType: "image/png",
					});
					if (this.#lastMessage) {
						this.updateContent(this.#lastMessage);
					}
					this.onImageUpdate?.();
				})
				.catch(() => {
					this.#kittyConversionsInFlight.delete(key);
				});
		}
	}

	setUsageInfo(usage: Usage): void {
		this.#usageInfo = usage;
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage);
		}
	}

	#renderToolImages(): void {
		const imageEntries = Array.from(this.#toolImagesByCallId.entries()).flatMap(([toolCallId, images]) =>
			images.map((image, index) => ({ image, key: `${toolCallId}:${index}` })),
		);
		if (imageEntries.length === 0) return;

		this.#contentContainer.addChild(new Spacer(1));
		for (const { image, key } of imageEntries) {
			const displayImage =
				TERMINAL.imageProtocol === ImageProtocol.Kitty && image.mimeType !== "image/png"
					? this.#convertedKittyImages.get(key)
					: image;
			if (TERMINAL.imageProtocol && displayImage) {
				this.#contentContainer.addChild(
					new Image(
						displayImage.data,
						displayImage.mimeType,
						{ fallbackColor: (text: string) => theme.fg("toolOutput", text) },
						resolveImageOptions(),
					),
				);
				continue;
			}
			this.#contentContainer.addChild(new Text(theme.fg("toolOutput", `[Image: ${image.mimeType}]`), 1, 0));
		}
	}

	#appendThinkingExtensions(contentIndex: number, thinkingIndex: number, text: string): void {
		for (const renderer of this.thinkingRenderers) {
			try {
				const component = renderer(
					{
						contentIndex,
						thinkingIndex,
						text,
						requestRender: () => this.onImageUpdate?.(),
					},
					theme,
				);
				if (component) {
					this.#contentContainer.addChild(component);
				}
			} catch {
				// Ignore extension renderer failures and keep the original thinking block visible.
			}
		}
	}

	updateContent(message: AssistantMessage): void {
		this.#lastMessage = message;

		// Clear content container
		this.#contentContainer.clear();

		const hasVisibleContent = message.content.some(
			c => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.#contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		let thinkingIndex = 0;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Strip <think> text tags for display (some models embed thinking inline)
				const displayText = filterTaggableText(content.text.trim(), this.hideThinkingBlock);
				if (displayText) {
					this.#contentContainer.addChild(new Markdown(displayText, 1, 0, getMarkdownTheme()));
				}
			} else if (content.type === "thinking" && content.thinking.trim()) {
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some(c => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				if (this.hideThinkingBlock) {
					// We completely hide the thinking block. The user is informed via the
					// working indicator spinner at the bottom which says "Thinking...".
				} else {
					const thinkingText = content.thinking.trim();
					// Thinking traces in thinkingText color, italic
					this.#contentContainer.addChild(
						new Markdown(thinkingText, 1, 0, getMarkdownTheme(), {
							color: (text: string) => theme.fg("thinkingText", text),
							italic: true,
						}),
					);
					this.#appendThinkingExtensions(i, thinkingIndex, thinkingText);
					thinkingIndex += 1;
					if (hasVisibleContentAfter) {
						this.#contentContainer.addChild(new Spacer(1));
					}
				}
			}
		}

		this.#renderToolImages();
		// Check if aborted - show after partial content
		// But only if there are no tool calls (tool execution components will show the error)
		const hasToolCalls = message.content.some(c => c.type === "toolCall");
		if (!hasToolCalls) {
			if (message.stopReason === "aborted" && !isSilentAbort(message.errorMessage)) {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				if (hasVisibleContent) {
					this.#contentContainer.addChild(new Spacer(1));
				} else {
					this.#contentContainer.addChild(new Spacer(1));
				}
				this.#contentContainer.addChild(new Text(theme.fg("error", abortMessage), 1, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.#contentContainer.addChild(new Spacer(1));
				this.#contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), 1, 0));
			}
		}
		if (
			message.errorMessage &&
			!isSilentAbort(message.errorMessage) &&
			message.stopReason !== "aborted" &&
			message.stopReason !== "error"
		) {
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("error", `Error: ${message.errorMessage}`), 1, 0));
		}

		// Token usage metadata
		if (settings.get("display.showTokenUsage") && this.#usageInfo) {
			const usage = this.#usageInfo;
			const totalInput = usage.input + usage.cacheWrite;
			const parts: string[] = [];
			parts.push(`${theme.icon.input} ${formatNumber(totalInput)}`);
			parts.push(`${theme.icon.output} ${formatNumber(usage.output)}`);
			if (usage.cacheRead > 0) {
				parts.push(`cache: ${formatNumber(usage.cacheRead)}`);
			}
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("dim", parts.join("  ")), 1, 0));
		}
	}
}
