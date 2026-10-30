import { afterEach, describe, expect, it, vi } from "bun:test";
import { CommandController } from "@aryee337/aery/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@aryee337/aery/modes/types";
import * as native from "@aryee337/aery-engine";

function createController(options: {
	assistantText?: string;
	hasAssistantMessage?: boolean;
	handoffText?: string;
	lastBtwAnswer?: string;
}) {
	const showStatus = vi.fn();
	const showError = vi.fn();
	const ctx = {
		session: {
			getLastAssistantText: () => options.assistantText,
			hasCopyCandidateAssistantMessage: () => options.hasAssistantMessage ?? options.assistantText !== undefined,
			getLastVisibleHandoffText: () => options.handoffText,
		},
		getLastBtwAnswer: () => options.lastBtwAnswer,
		showStatus,
		showError,
	} as unknown as InteractiveModeContext;

	return { controller: new CommandController(ctx), showStatus, showError };
}

describe("/copy command", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("falls back to the fresh handoff context when no assistant message exists", () => {
		const copySpy = vi.spyOn(native, "copyToClipboard").mockImplementation(() => undefined);
		const { controller, showStatus, showError } = createController({
			handoffText: "<handoff-context>\n## Goal\nContinue\n</handoff-context>",
		});

		controller.handleCopyCommand();

		expect(copySpy).toHaveBeenCalledWith("<handoff-context>\n## Goal\nContinue\n</handoff-context>");
		expect(showStatus).toHaveBeenCalledWith("Copied handoff context to clipboard");
		expect(showError).not.toHaveBeenCalled();
	});

	it("does not fall back to stale handoff context after a textless assistant response", () => {
		const copySpy = vi.spyOn(native, "copyToClipboard").mockImplementation(() => undefined);
		const { controller, showStatus, showError } = createController({
			hasAssistantMessage: true,
			handoffText: "<handoff-context>\n## Goal\nContinue\n</handoff-context>",
		});

		controller.handleCopyCommand();

		expect(copySpy).not.toHaveBeenCalled();
		expect(showStatus).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledWith("No agent messages to copy yet.");
	});

	it("copies /btw answer to clipboard when available", () => {
		const copySpy = vi.spyOn(native, "copyToClipboard").mockImplementation(() => undefined);
		const { controller, showStatus, showError } = createController({
			lastBtwAnswer: "This is the /btw answer.",
		});

		controller.handleCopyCommand("btw");

		expect(copySpy).toHaveBeenCalledWith("This is the /btw answer.");
		expect(showStatus).toHaveBeenCalledWith("Copied /btw response to clipboard");
		expect(showError).not.toHaveBeenCalled();
	});

	it("shows error when /copy btw is invoked without a /btw answer", () => {
		const copySpy = vi.spyOn(native, "copyToClipboard").mockImplementation(() => undefined);
		const { controller, showStatus, showError } = createController({
			lastBtwAnswer: undefined,
		});

		controller.handleCopyCommand("btw");

		expect(copySpy).not.toHaveBeenCalled();
		expect(showStatus).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledWith("No /btw response to copy.");
	});
});
