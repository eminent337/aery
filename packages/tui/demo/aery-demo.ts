// Run: bun run packages/tui/demo/aery-demo.ts   (Ctrl+C to exit)
import { ProcessTerminal } from "../src/terminal.js";
import { TUI } from "../src/tui.js";
import { AeryScreen } from "../src/aery-screen.js";

const terminal = new ProcessTerminal();
const tui = new TUI(terminal);
const screen = new AeryScreen(tui);

screen.setBarSegments([
  { text: "AERY", accent: true },
  { text: "gpt-4o" },
  { text: "~/project" },
  { text: "$0.000" },
]);

screen.appendMessage({ role: "user", content: "Can you read package.json?" });
screen.appendMessage({ role: "assistant", content: "Sure, reading it now..." });

const card = screen.showToolCard("t1", { tool: "read_file", status: "running" });

setTimeout(() => {
  card.setStatus("done", "0.3s");
  card.setContent(["/home/user/project/package.json", '{ "name": "aery", ... }']);
  screen.streamChunk("\n\nDone! It is named **aery**.");
  screen.setBarSegments([
    { text: "AERY", accent: true },
    { text: "gpt-4o" },
    { text: "~/project" },
    { text: "$0.002" },
  ]);
  tui.requestRender();
}, 1500);

screen.onSubmit((text) => {
  screen.appendMessage({ role: "user", content: text });
  screen.appendMessage({ role: "assistant", content: "Got: " + text });
});

await tui.start();
