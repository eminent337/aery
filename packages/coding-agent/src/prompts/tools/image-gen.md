Generates or edits images.

<instructions>
- You MUST provide a single detailed `subject` prompt for image generation or editing.
- When using multiple `input`, you SHOULD describe each image's role directly in `subject`, e.g. `Image 1` for composition reference, `Image 2` for lighting reference, `Image 3` for background.
- For text: you SHOULD add "sharp, legible, correctly spelled" for important text; keep text short
- Before generating, ALWAYS call the `ask` tool to let the user choose which image model/provider to use. Present the available image models (see the tool description's "Available image models" list) as the `ask` options, marking the default as recommended. Wait for the user's selection, then call this tool with the chosen model. If the `ask` tool is unavailable (headless/non-interactive) or the user cancels, proceed with the default model.
</instructions>
