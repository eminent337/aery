# Graph Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a dependency graph builder tool that recursively parses imports to build a node/edge map for a VS Code extension.

**Architecture:** A new `GraphTool` class implementing `AgentTool`, using `fs` and regular expressions to extract `import` and `require` paths, storing nodes and edges in a JSON object.

**Tech Stack:** TypeScript, Bun, `@aryee337/aery-core`

---

### Task 1: Graph Tool Tests

**Files:**
- Create: `/home/aryee/aery/ai_agent/aery/packages/coding-agent/src/tools/graph.test.ts`
- Create: `/home/aryee/aery/ai_agent/aery/packages/coding-agent/src/tools/fixtures/a.ts`
- Create: `/home/aryee/aery/ai_agent/aery/packages/coding-agent/src/tools/fixtures/b.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { expect, test } from "bun:test";
import { GraphTool } from "./graph";
import * as fs from "node:fs";
import * as path from "node:path";

test("GraphTool parses dependencies correctly", async () => {
    const fixtureDir = path.join(__dirname, "fixtures");
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, "a.ts"), "import { b } from './b';\nrequire('node:fs');");
    fs.writeFileSync(path.join(fixtureDir, "b.ts"), "export const b = 1;");

    const tool = new GraphTool();
    const result = await tool.execute("test-id", { entryPoint: path.join(fixtureDir, "a.ts") });
    
    expect(result.details?.nodes.length).toBeGreaterThan(0);
    expect(result.details?.edges.length).toBeGreaterThan(0);
    
    // Cleanup
    fs.rmSync(fixtureDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/aryee/aery/ai_agent/aery/packages/coding-agent && bun test src/tools/graph.test.ts`
Expected: FAIL with "Cannot find module './graph'"

### Task 2: Graph Tool Implementation

**Files:**
- Create: `/home/aryee/aery/ai_agent/aery/packages/coding-agent/src/tools/graph.ts`

- [ ] **Step 1: Write minimal implementation**

```typescript
import type { AgentTool, AgentToolResult, AgentToolContext, AgentToolUpdateCallback } from "@aryee337/aery-core";
import * as z from "zod/v4";
import * as fs from "node:fs";
import * as path from "node:path";

const graphSchema = z.object({
    entryPoint: z.string().describe("Absolute path to start the dependency graph from"),
    maxDepth: z.number().optional().default(10).describe("Maximum recursion depth")
});

export interface GraphToolDetails {
    nodes: { id: string, file: string }[];
    edges: { source: string, target: string }[];
}

export class GraphTool implements AgentTool<typeof graphSchema, GraphToolDetails> {
    readonly name = "graph";
    readonly approval = "read" as const;
    readonly label = "Graph Tool";
    readonly description = "Builds a dependency graph by recursively parsing imports from an entry file.";
    readonly parameters = graphSchema;

    async execute(
        _toolCallId: string,
        params: z.infer<typeof graphSchema>,
        _signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<GraphToolDetails>,
        _context?: AgentToolContext,
    ): Promise<AgentToolResult<GraphToolDetails>> {
        const nodes: { id: string, file: string }[] = [];
        const edges: { source: string, target: string }[] = [];
        const visited = new Set<string>();

        const traverse = (currentPath: string, depth: number) => {
            if (depth > (params.maxDepth ?? 10)) return;
            if (visited.has(currentPath)) return;
            visited.add(currentPath);

            nodes.push({ id: currentPath, file: currentPath });

            let content = "";
            try {
                content = fs.readFileSync(currentPath, "utf-8");
            } catch (err) {
                return;
            }

            // Simple regex for import ... from "..." and require("...")
            const importRegex = /(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+.*?from\s+['"]([^'"]+)['"]/g;
            let match;
            while ((match = importRegex.exec(content)) !== null) {
                const dep = match[1] || match[2];
                if (!dep || dep.startsWith("node:") || !dep.startsWith(".")) continue; // Skip built-ins and node_modules for simplicity
                
                const dir = path.dirname(currentPath);
                let resolvedDep = path.resolve(dir, dep);
                // Try appending .ts or .js if it doesn't exist
                if (!fs.existsSync(resolvedDep) && fs.existsSync(resolvedDep + ".ts")) resolvedDep += ".ts";
                if (!fs.existsSync(resolvedDep) && fs.existsSync(resolvedDep + ".js")) resolvedDep += ".js";

                edges.push({ source: currentPath, target: resolvedDep });
                traverse(resolvedDep, depth + 1);
            }
        };

        traverse(params.entryPoint, 0);

        return {
            content: [{ type: "text", text: `Graph built with ${nodes.length} nodes and ${edges.length} edges.` }],
            details: { nodes, edges }
        };
    }
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd /home/aryee/aery/ai_agent/aery/packages/coding-agent && bun test src/tools/graph.test.ts`
Expected: PASS

### Task 3: Export Tool

**Files:**
- Modify: `/home/aryee/aery/ai_agent/aery/packages/coding-agent/src/tools/index.ts`

- [ ] **Step 1: Write the failing test**

There isn't a direct test for tool exporting, we'll verify via build. Skip to implementation.

- [ ] **Step 2: Modify `index.ts`**

Add `export * from "./graph";` and import `GraphTool`.

Run: `sed -i '1i import { GraphTool } from "./graph";' /home/aryee/aery/ai_agent/aery/packages/coding-agent/src/tools/index.ts`
Run: `echo 'export * from "./graph";' >> /home/aryee/aery/ai_agent/aery/packages/coding-agent/src/tools/index.ts`

Wait, let's use the replacement tool or write explicitly how to update it.

```typescript
// Add at the top or alphabetical:
import { GraphTool } from "./graph";

// Add to exports:
export * from "./graph";
```

### Task 4: Verify Build

**Files:**
- None

- [ ] **Step 1: Run build**

Run: `cd /home/aryee/aery/ai_agent/aery/packages/coding-agent && npm run build`
Expected: Passes without errors.
