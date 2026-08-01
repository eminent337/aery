const fs = require('fs');
let content = fs.readFileSync('packages/coding-agent/src/slash-commands/builtin-registry.ts', 'utf8');

const commandsToRemove = ['todo', 'jobs', 'tokens', 'context', 'agents', 'memory'];

for (const cmd of commandsToRemove) {
    const regex = new RegExp(`\\{\\s*name:\\s*"${cmd}",[\\s\\S]*?\\n\\t\\},`, 'g');
    content = content.replace(regex, '');
}

fs.writeFileSync('packages/coding-agent/src/slash-commands/builtin-registry.ts', content);
