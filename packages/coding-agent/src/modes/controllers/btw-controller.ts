import { BtwPanelComponent } from "../components/btw-panel";
import type { InteractiveModeContext } from "../types";

interface BtwRequest {
	component: BtwPanelComponent;
	abortController: AbortController;
	question: string;
}

export class BtwController {
	#activeRequest: BtwRequest | undefined;
	#lastAnswer: string | undefined;
	#lastQuestion: string | undefined;

	constructor(private readonly ctx: InteractiveModeContext) {}

	hasActiveRequest(): boolean {
		return this.#activeRequest !== undefined;
	}

	getLastAnswer(): string | undefined {
		return this.#lastAnswer;
	}

	getCurrentOrLastAnswer(): string | undefined {
		if (this.#activeRequest) {
			const current = this.#activeRequest.component.getAnswer().trim();
			if (current) return current;
		}
		return this.#lastAnswer;
	}

	/**
	 * Promote the current or last /btw answer into the main conversation.
	 * Injects the exact agy promotion banner then appends the Q+A pair to
	 * the live session history.  Closes the active /btw card if open.
	 *
	 * Returns true when promotion succeeded, false when there is nothing to promote.
	 */
	async promote(): Promise<boolean> {
		const question = this.#activeRequest?.question ?? this.#lastQuestion;
		const answer = this.getCurrentOrLastAnswer();

		if (!question || !answer) {
			this.ctx.showStatus("No /btw response to promote.");
			return false;
		}

		// Close the panel before promoting so the main chat gets focus back
		this.#closeActiveRequest({ abort: false });

		const session = this.ctx.session;
		if (typeof (session as unknown as Record<string, unknown>).promoteSideQuestion === "function") {
			await session.promoteSideQuestion({ question, answer });
		}

		this.ctx.showStatus("Promoted /btw response to main conversation.");
		return true;
	}

	handleEscape(): boolean {
		if (!this.#activeRequest) return false;
		this.#closeActiveRequest({ abort: this.#activeRequest.abortController.signal.aborted === false });
		return true;
	}

	dispose(): void {
		this.#closeActiveRequest({ abort: true });
	}

	async start(question: string): Promise<void> {
		const trimmedQuestion = question.trim();
		if (!trimmedQuestion) {
			this.ctx.showStatus("Usage: /btw <question>");
			return;
		}

		const model = this.ctx.session.model;
		if (!model) {
			this.ctx.showError("No active model available for /btw.");
			return;
		}

		this.#closeActiveRequest({ abort: true });

		const request: BtwRequest = {
			component: new BtwPanelComponent({ question: trimmedQuestion, tui: this.ctx.ui }),
			abortController: new AbortController(),
			question: trimmedQuestion,
		};
		this.ctx.btwContainer.clear();
		this.ctx.btwContainer.addChild(request.component);
		this.ctx.ui.requestRender();
		this.#activeRequest = request;
		void this.#runRequest(request);
	}

	async #runRequest(request: BtwRequest): Promise<void> {
		try {
			let replyText = "";
			const session = this.ctx.session;
			const onTextDelta = (delta: string) => {
				if (this.#isActiveRequest(request)) {
					request.component.appendText(delta);
				}
			};
			if (typeof (session as unknown as Record<string, unknown>).runSideQuestion === "function") {
				const result = await session.runSideQuestion({
					question: request.question,
					onTextDelta,
					signal: request.abortController.signal,
				});
				replyText = result?.replyText ?? "";
			} else {
				const btwPrompt = `<btw>\n${request.question}\n</btw>`;
				const result = await session.runEphemeralTurn({
					promptText: btwPrompt,
					onTextDelta,
					signal: request.abortController.signal,
				});
				replyText = result?.replyText ?? "";
			}

			if (!this.#isActiveRequest(request)) {
				return;
			}
			if (replyText) {
				request.component.setAnswer(replyText);
				this.#lastAnswer = replyText;
				this.#lastQuestion = request.question;
			}
			request.component.markComplete();
		} catch (error) {
			if (!this.#isActiveRequest(request)) {
				return;
			}
			if (request.abortController.signal.aborted) {
				request.component.markAborted();
				return;
			}
			request.component.markError(error instanceof Error ? error.message : String(error));
		}
	}

	#closeActiveRequest(options: { abort: boolean }): void {
		const request = this.#activeRequest;
		if (!request) return;
		this.#activeRequest = undefined;
		if (options.abort) {
			request.abortController.abort();
		}
		request.component.close();
		this.ctx.btwContainer.clear();
		this.ctx.ui.requestRender();
	}

	#isActiveRequest(request: BtwRequest): boolean {
		return this.#activeRequest === request;
	}
}
