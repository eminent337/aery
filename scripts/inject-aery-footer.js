const fs = require('fs');

const target = 'packages/coding-agent/src/modes/interactive/components/footer.ts';
if (!fs.existsSync(target)) {
  console.error("footer.ts not found!");
  process.exit(1);
}

let content = fs.readFileSync(target, 'utf-8');

// Replace model display with context-sensitive keybindings
if (!content.includes('context-sensitive keybindings')) {
  // Replace the right-side model display section
  content = content.replace(
    /let rightSideWithoutProvider = modelName;[\s\S]*?rightSide = rightSideWithoutProvider;\n\t\t\}/,
    `// Context-sensitive keybindings based on current state
\t\tlet rightSide: string;
\t\tif (this.session.isCompacting) {
\t\t\trightSide = "compacting...";
\t\t} else if (this.session.isStreaming) {
\t\t\trightSide = "Esc: interrupt";
\t\t} else {
\t\t\tconst thinkingLevel = state.thinkingLevel || "off";
\t\t\trightSide = thinkingLevel === "off" ? "Shift+Tab: thinking" : \`Shift+Tab: \${thinkingLevel}\`;
\t\t}`
  );

  // Add "aery" branding to statsParts
  content = content.replace(
    'const statsParts = [];',
    'const statsParts = [theme.fg("accent", "aery")];'
  );
}

fs.writeFileSync(target, content);
console.log("Injected aery footer (context-sensitive keybindings) to footer.ts");
