import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@aryee337/aery-core";
import * as ts from "typescript";
import * as z from "zod/v4";

const graphSchema = z.object({
	entryPoint: z.string().describe("Absolute path to start the dependency graph from"),
	maxDepth: z.number().optional().default(10).describe("Maximum recursion depth"),
});

export interface GraphToolDetails {
	nodes: { id: string; file: string }[];
	edges: { source: string; target: string }[];
}
export class GraphTool implements AgentTool<typeof graphSchema, GraphToolDetails> {
	readonly loadMode = "discoverable";
	readonly name = "graph";
	readonly approval = "read" as const;
	readonly label = "Graph Tool";
	readonly description = "Builds a dependency graph by recursively parsing imports from an entry file.";
	readonly summary = "Builds a dependency graph by recursively parsing imports from an entry file.";
	readonly parameters = graphSchema;

	async execute(
		_toolCallId: string,
		params: z.infer<typeof graphSchema>,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<GraphToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GraphToolDetails>> {
		const nodes: { id: string; file: string }[] = [];
		const edges: { source: string; target: string }[] = [];
		const visited = new Set<string>();

		const sys = ts.sys;
		const compilerOptions: ts.CompilerOptions = {
			moduleResolution: ts.ModuleResolutionKind.NodeJs,
			allowJs: true,
			resolveJsonModule: true,
		};
		const host = ts.createCompilerHost(compilerOptions);

		const getModuleDependencies = (sourceFile: ts.SourceFile): string[] => {
			const deps: string[] = [];

			const visit = (node: ts.Node) => {
				// import { ... } from "..."
				if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
					deps.push(node.moduleSpecifier.text);
				}
				// export * from "..." or export { ... } from "..."
				else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
					deps.push(node.moduleSpecifier.text);
				}
				// require("...") or import("...")
				else if (
					ts.isCallExpression(node) &&
					(node.expression.getText() === "require" || node.expression.kind === ts.SyntaxKind.ImportKeyword)
				) {
					const arg = node.arguments[0];
					if (arg && ts.isStringLiteral(arg)) {
						deps.push(arg.text);
					}
				}

				ts.forEachChild(node, visit);
			};

			visit(sourceFile);
			return deps;
		};

		const traverse = (currentPath: string, depth: number) => {
			if (depth > (params.maxDepth ?? 10)) return;

			// Normalize path
			const normalizedPath = sys.useCaseSensitiveFileNames ? currentPath : currentPath.toLowerCase();
			if (visited.has(normalizedPath)) return;
			visited.add(normalizedPath);

			nodes.push({ id: currentPath, file: currentPath });

			let content = "";
			try {
				content = fs.readFileSync(currentPath, "utf-8");
			} catch (err) {
				return;
			}

			const sourceFile = ts.createSourceFile(currentPath, content, ts.ScriptTarget.Latest, true);
			const deps = getModuleDependencies(sourceFile);

			for (const dep of deps) {
				if (dep.startsWith("node:")) continue;
				// Attempt to resolve module using TS
				const resolution = ts.resolveModuleName(dep, currentPath, compilerOptions, host);

				if (resolution.resolvedModule) {
					// We only care about internal files, not external packages (e.g. node_modules)
					if (!resolution.resolvedModule.isExternalLibraryImport) {
						const resolvedDep = resolution.resolvedModule.resolvedFileName;
						edges.push({ source: currentPath, target: resolvedDep });
						traverse(resolvedDep, depth + 1);
					}
				} else if (dep.startsWith(".")) {
					// Fallback for unresolved relative imports
					const dir = path.dirname(currentPath);
					let resolvedDep = path.resolve(dir, dep);

					// Simple fallback extensions
					const exts = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.js"];
					let found = false;
					for (const ext of exts) {
						if (fs.existsSync(resolvedDep + ext) && fs.statSync(resolvedDep + ext).isFile()) {
							resolvedDep += ext;
							found = true;
							break;
						}
					}

					if (found) {
						edges.push({ source: currentPath, target: resolvedDep });
						traverse(resolvedDep, depth + 1);
					}
				}
			}
		};

		// Make sure entrypoint is absolute
		const absoluteEntryPoint = path.resolve(params.entryPoint);
		if (fs.existsSync(absoluteEntryPoint)) {
			traverse(absoluteEntryPoint, 0);
		}

		return {
			content: [{ type: "text", text: `Graph built with ${nodes.length} nodes and ${edges.length} edges.` }],
			details: { nodes, edges },
		};
	}
}
