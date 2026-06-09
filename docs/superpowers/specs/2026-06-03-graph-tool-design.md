# Dependency Graph Builder Tool Design

## Overview
A new tool for the agent to build a visual memory graph of a codebase. The VS Code extension will read this output to render a visual dependency graph.

## Architecture & Implementation
- **Location**: `packages/coding-agent/src/tools/graph.ts`
- **Interface**: Implements `@aryee337/aery-core`'s `AgentTool`.
- **Zod Schema**:
  - `entryPoint` (string): Absolute path to the file to start tracing from.
  - `maxDepth` (number, optional): Maximum recursion depth. Default to 10.
- **Parsing Strategy**:
  - Use regex to extract ES module imports (`import .* from ['"](.*)['"]`) and CommonJS requires (`require\(['"](.*)['"]\)`).
  - Exclude `node_modules` and core node modules (like `fs`, `path`).
  - Resolve relative paths against the current file's directory.
- **Output**:
  - Return a JSON object containing:
    - `nodes`: Array of `{ id: string, file: string }`
    - `edges`: Array of `{ source: string, target: string }`

## Error Handling
- Invalid or unresolvable paths will be logged and skipped rather than failing the entire traversal.
- A `visited` set will prevent infinite loops in cyclical dependencies.

## Testing
- Ensure standard `import` and `require` statements are parsed.
- Ensure tool correctly formats the `AgentToolResult`.
