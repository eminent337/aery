import type { ExtensionFactory } from "@aryee337/aery";
import { Container, Text } from "@aryee337/aery-tui";

const extension: ExtensionFactory = aery => {
	aery.setLabel("Thinking note");
	aery.registerAssistantThinkingRenderer((context, theme) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("dim", `thinking chars: ${context.text.length}`), 1, 0));
		return container;
	});
};

export default extension;
