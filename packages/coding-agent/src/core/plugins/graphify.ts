/**
 * Graphify auto-integration for Aery.
 *
 * On session start:
 *   - If graphify-out/graph.json exists, reads GRAPH_REPORT.md and injects
 *     god nodes + community summary into every LLM context call.
 *   - Registers query_graph, god_nodes, and shortest_path as agent tools
 *     backed by the MCP server (or direct Python calls if MCP not available).
 *
 * On file write:
 *   - Triggers incremental graph update (AST-only for code, full for docs).
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "../extensions/types.js";

const GRAPH_JSON = "graphify-out/graph.json";
const GRAPH_REPORT = "graphify-out/GRAPH_REPORT.md";
const GRAPHIFY_PYTHON = "graphify-out/.graphify_python";
const DEBOUNCE_MS = 3000;

function graphExists(cwd: string): boolean {
	return existsSync(join(cwd, GRAPH_JSON));
}

function getPython(cwd: string): string | null {
	const p = join(cwd, GRAPHIFY_PYTHON);
	if (!existsSync(p)) return null;
	return readFileSync(p, "utf-8").trim();
}

/** Extract the God Nodes and Surprising Connections sections from GRAPH_REPORT.md */
function extractGraphSummary(cwd: string): string | null {
	const reportPath = join(cwd, GRAPH_REPORT);
	if (!existsSync(reportPath)) return null;
	const content = readFileSync(reportPath, "utf-8");

	const sections: string[] = [];
	for (const heading of ["God Nodes", "Surprising Connections"]) {
		const start = content.indexOf(`## ${heading}`);
		if (start === -1) continue;
		const end = content.indexOf("\n## ", start + 1);
		sections.push(end === -1 ? content.slice(start) : content.slice(start, end));
	}
	if (sections.length === 0) return null;
	return `<graphify_context>\n${sections.join("\n\n").trim()}\n</graphify_context>`;
}

function runPython(python: string, code: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn(python, ["-c", code], { timeout: 30_000 });
		let out = "";
		let err = "";
		proc.stdout.on("data", (d: Buffer) => {
			out += d.toString();
		});
		proc.stderr.on("data", (d: Buffer) => {
			err += d.toString();
		});
		proc.on("close", (code: number) => {
			if (code === 0) resolve(out.trim());
			else reject(new Error(err.trim() || `exit ${code}`));
		});
	});
}

export default function (aery: ExtensionAPI) {
	let graphSummary: string | null = null;
	let cwd = process.cwd();
	let pendingUpdate: ReturnType<typeof setTimeout> | null = null;
	const lastWrittenFiles = new Set<string>();

	// ── Session start: load graph summary and register tools ──────────────────
	aery.on("session_start", async (_event, _ctx) => {
		cwd = process.cwd();
		if (!graphExists(cwd)) return;

		graphSummary = extractGraphSummary(cwd);

		const python = getPython(cwd);
		if (!python) return;

		// Register graph query tool
		aery.registerTool({
			name: "query_graph",
			label: "Query Knowledge Graph",
			description:
				"Query the project knowledge graph using BFS traversal. Returns nodes and edges relevant to the question.",
			promptSnippet: "query_graph(question) — search the project knowledge graph",
			parameters: Type.Object({
				question: Type.String({ description: "The question or concept to search for in the graph" }),
				mode: Type.Optional(
					Type.Union([Type.Literal("bfs"), Type.Literal("dfs")], {
						description: "bfs (broad context) or dfs (trace a path). Default: bfs",
					}),
				),
			}),
			async execute(_id, params, _signal, _onUpdate, _ctx) {
				const mode = params.mode ?? "bfs";
				const code = `
import json, sys
from networkx.readwrite import json_graph
import networkx as nx
from pathlib import Path

data = json.loads(Path('${join(cwd, "graphify-out/graph.json").replace(/\\/g, "\\\\")}').read_text())
G = json_graph.node_link_graph(data, edges='links')
terms = [t.lower() for t in ${JSON.stringify(params.question)}.split() if len(t) > 3]
scored = sorted([(sum(1 for t in terms if t in G.nodes[n].get('label','').lower()), n) for n in G.nodes()], reverse=True)
start_nodes = [nid for _, nid in scored[:3] if _ > 0]
if not start_nodes:
    print('No matching nodes found.')
    sys.exit(0)
subgraph_nodes = set(start_nodes)
subgraph_edges = []
if '${mode}' == 'dfs':
    visited = set(); stack = [(n, 0) for n in reversed(start_nodes)]
    while stack:
        node, depth = stack.pop()
        if node in visited or depth > 6: continue
        visited.add(node); subgraph_nodes.add(node)
        for nb in G.neighbors(node):
            if nb not in visited: stack.append((nb, depth+1)); subgraph_edges.append((node, nb))
else:
    frontier = set(start_nodes)
    for _ in range(3):
        nxt = set()
        for n in frontier:
            for nb in G.neighbors(n):
                if nb not in subgraph_nodes: nxt.add(nb); subgraph_edges.append((n, nb))
        subgraph_nodes.update(nxt); frontier = nxt
lines = [f'Graph traversal ({mode.upper()}): {len(subgraph_nodes)} nodes']
for nid in sorted(subgraph_nodes, key=lambda n: sum(1 for t in terms if t in G.nodes[n].get('label','').lower()), reverse=True):
    d = G.nodes[nid]
    lines.append(f'  NODE {d.get("label",nid)} [file={d.get("source_file","")} loc={d.get("source_location","")}]')
for u,v in subgraph_edges:
    if u in subgraph_nodes and v in subgraph_nodes:
        d = G.edges[u,v]
        lines.append(f'  EDGE {G.nodes[u].get("label",u)} --{d.get("relation","")} [{d.get("confidence","")}]--> {G.nodes[v].get("label",v)}')
print('\\n'.join(lines[:200]))
`;
				try {
					const result = await runPython(python, code);
					return { content: [{ type: "text", text: result }], details: { type: "success", output: result } };
				} catch (e) {
					return { content: [{ type: "text", text: String(e) }], details: { type: "error", output: String(e) } };
				}
			},
		});

		// Register god_nodes tool
		aery.registerTool({
			name: "god_nodes",
			label: "Graph God Nodes",
			description:
				"Returns the highest-degree nodes in the knowledge graph — the concepts everything else connects through.",
			promptSnippet: "god_nodes() — get the most connected concepts in the codebase",
			parameters: Type.Object({
				limit: Type.Optional(Type.Number({ description: "Max nodes to return. Default: 10" })),
			}),
			async execute(_id, params, _signal, _onUpdate, _ctx) {
				const code = `
import json
from networkx.readwrite import json_graph
from pathlib import Path
data = json.loads(Path('${join(cwd, "graphify-out/graph.json").replace(/\\/g, "\\\\")}').read_text())
import networkx as nx
G = json_graph.node_link_graph(data, edges='links')
limit = ${params.limit ?? 10}
gods = sorted(G.nodes(), key=lambda n: G.degree(n), reverse=True)[:limit]
for n in gods:
    d = G.nodes[n]
    print(f'{d.get("label",n)} (degree={G.degree(n)}, file={d.get("source_file","")})')
`;
				try {
					const result = await runPython(python, code);
					return { content: [{ type: "text", text: result }], details: { type: "success", output: result } };
				} catch (e) {
					return { content: [{ type: "text", text: String(e) }], details: { type: "error", output: String(e) } };
				}
			},
		});

		// Register shortest_path tool
		aery.registerTool({
			name: "graph_path",
			label: "Graph Shortest Path",
			description: "Find the shortest path between two concepts in the knowledge graph.",
			promptSnippet: "graph_path(from, to) — trace how two concepts connect",
			parameters: Type.Object({
				from: Type.String({ description: "Source concept name" }),
				to: Type.String({ description: "Target concept name" }),
			}),
			async execute(_id, params, _signal, _onUpdate, _ctx) {
				const code = `
import json, sys
import networkx as nx
from networkx.readwrite import json_graph
from pathlib import Path
data = json.loads(Path('${join(cwd, "graphify-out/graph.json").replace(/\\/g, "\\\\")}').read_text())
G = json_graph.node_link_graph(data, edges='links')
def find_node(term):
    term = term.lower()
    scored = sorted([(sum(1 for w in term.split() if w in G.nodes[n].get('label','').lower()), n) for n in G.nodes()], reverse=True)
    return scored[0][1] if scored and scored[0][0] > 0 else None
src = find_node(${JSON.stringify(params.from)})
tgt = find_node(${JSON.stringify(params.to)})
if not src or not tgt:
    print('Could not find nodes for: ' + ${JSON.stringify(params.from)} + ' or ' + ${JSON.stringify(params.to)})
    sys.exit(0)
try:
    path = nx.shortest_path(G, src, tgt)
    print(f'Shortest path ({len(path)-1} hops):')
    for i, nid in enumerate(path):
        label = G.nodes[nid].get('label', nid)
        if i < len(path)-1:
            edge = G.edges[nid, path[i+1]]
            print(f'  {label} --{edge.get("relation","")} [{edge.get("confidence","")}]-->')
        else:
            print(f'  {label}')
except nx.NetworkXNoPath:
    print(f'No path found between the two concepts.')
`;
				try {
					const result = await runPython(python, code);
					return { content: [{ type: "text", text: result }], details: { type: "success", output: result } };
				} catch (e) {
					return { content: [{ type: "text", text: String(e) }], details: { type: "error", output: String(e) } };
				}
			},
		});
	});

	// ── Context injection: prepend graph summary to every LLM call ────────────
	aery.on("before_agent_start", (_event, _ctx) => {
		if (!graphSummary) return undefined;
		return {
			systemPrompt: `[Graphify Context]\n${graphSummary}\n[End Graphify Context]\nPlease use the knowledge graph context when answering questions about this codebase.`,
		};
	});

	// ── File write watcher: trigger incremental graph update ─────────────────
	const CODE_EXTS = new Set([
		".ts",
		".js",
		".mjs",
		".py",
		".go",
		".rs",
		".java",
		".cpp",
		".c",
		".rb",
		".swift",
		".kt",
		".cs",
	]);

	aery.on("tool_result", (event, _ctx) => {
		// Watch for file write/edit tool results
		const toolName = (event as any).toolName as string | undefined;
		if (!toolName || !["write", "edit", "str_replace_editor", "create_file"].includes(toolName)) return;

		const path = (event as any).input?.path as string | undefined;
		if (!path || !graphExists(cwd)) return;

		lastWrittenFiles.add(path);

		// Debounce: wait for a wave of writes to settle
		if (pendingUpdate) clearTimeout(pendingUpdate);
		pendingUpdate = setTimeout(async () => {
			pendingUpdate = null;
			const python = getPython(cwd);
			if (!python) return;

			const files = Array.from(lastWrittenFiles);
			lastWrittenFiles.clear();

			const allCode = files.every((f) => CODE_EXTS.has(f.slice(f.lastIndexOf("."))));

			try {
				if (allCode) {
					// AST-only update, no LLM needed
					await runPython(
						python,
						`
import json
from graphify.extract import collect_files, extract
from graphify.build import build_from_json
from graphify.cluster import cluster, score_all
from graphify.analyze import god_nodes, surprising_connections, suggest_questions
from graphify.report import generate
from graphify.export import to_json
from networkx.readwrite import json_graph
import networkx as nx
from pathlib import Path

files = [Path(f) for f in ${JSON.stringify(files)} if Path(f).exists()]
if not files:
    raise SystemExit(0)

result = extract(files)
G_new = build_from_json(result)

existing = json.loads(Path('${join(cwd, "graphify-out/graph.json").replace(/\\/g, "\\\\")}').read_text())
G = json_graph.node_link_graph(existing, edges='links')
G.update(G_new)

communities = cluster(G)
cohesion = score_all(G, communities)
gods = god_nodes(G)
surprises = surprising_connections(G, communities)
labels = {cid: 'Community ' + str(cid) for cid in communities}
questions = suggest_questions(G, communities, labels)
detection = {'total_files': G.number_of_nodes(), 'total_words': 0, 'files': {}}
tokens = {'input': 0, 'output': 0}
report = generate(G, communities, cohesion, labels, gods, surprises, detection, tokens, '.', suggested_questions=questions)
Path('${join(cwd, "graphify-out/GRAPH_REPORT.md").replace(/\\/g, "\\\\")}').write_text(report)
to_json(G, communities, '${join(cwd, "graphify-out/graph.json").replace(/\\/g, "\\\\")}')
print(f'Graph updated: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges')
`,
					);
				} else {
					// Write a flag for the user to run --update (semantic re-extraction needs LLM)
					writeFileSync(join(cwd, "graphify-out/.needs_update"), files.join("\n"));
				}

				// Refresh the in-memory summary
				graphSummary = extractGraphSummary(cwd);
			} catch {
				// Silent — graph update is best-effort
			}
		}, DEBOUNCE_MS);
	});
}
