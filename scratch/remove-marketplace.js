const fs = require("fs");
const path = require("path");

const filePath = path.resolve("packages/coding-agent/src/slash-commands/builtin-registry.ts");
const content = fs.readFileSync(filePath, "utf-8");

const startStr = '	{\n		name: "marketplace",';
const startIndex = content.indexOf(startStr);

if (startIndex === -1) {
	console.error("Could not find marketplace command");
	process.exit(1);
}

// Find matching closing brace
let openBraces = 0;
let endIndex = -1;
for (let i = startIndex; i < content.length; i++) {
	if (content[i] === "{") openBraces++;
	if (content[i] === "}") {
		openBraces--;
		if (openBraces === 0) {
			endIndex = i;
			break;
		}
	}
}

if (endIndex === -1) {
	console.error("Could not find end of marketplace command");
	process.exit(1);
}

// Ensure we include the trailing comma and newline
if (content[endIndex + 1] === ",") {
	endIndex++;
}
if (content[endIndex + 1] === "\n") {
	endIndex++;
}

const newContent = content.slice(0, startIndex) + content.slice(endIndex + 1);
fs.writeFileSync(filePath, newContent, "utf-8");
console.log("Successfully removed marketplace command");
