import { expect, test } from "bun:test";
import type { ExecOptions, ExecResult } from "../../exec/exec";
import { ExploreTool, extractSearchTerms, parseRgCountOutput, rankFilesByRelevance } from "../explore";

function makeExec(
	results: Record<string, string>,
): (command: string, args: string[], cwd: string, options?: ExecOptions) => Promise<ExecResult> {
	return async (command, args, cwd) => {
		const argStr = args.join(" ");
		for (const [pattern, stdout] of Object.entries(results)) {
			if (argStr.includes(pattern)) {
				return { stdout, stderr: "", code: 0, killed: false };
			}
		}
		return { stdout: "", stderr: "", code: 1, killed: false };
	};
}

test("extractSearchTerms splits identifiers and drops stop words", () => {
	const query = "Find the missing getAuthToken logic and session_manager tests";
	const terms = extractSearchTerms(query);
	// stop words "find", "the", "and", "logic", "tests" (wait logic is stop, tests is not)
	// getAuthToken -> get auth token
	// session_manager -> session manager
	expect(terms).toContain("auth");
	expect(terms).toContain("token");
	expect(terms).toContain("session");
	expect(terms).toContain("manager");
	expect(terms).toContain("tests");
	expect(terms).not.toContain("the");
	expect(terms).not.toContain("find");
	expect(terms).not.toContain("logic");
	expect(terms.length).toBe(7);
});

test("parseRgCountOutput parses valid rg output", () => {
	const output = "src/auth.ts:12\ntests/auth.test.ts:4\ninvalid-line\nsrc/utils.ts:0\n";
	const counts = parseRgCountOutput(output);
	expect(counts).toHaveLength(3);
	expect(counts[0]).toMatchObject({ path: "src/auth.ts", count: 12 });
	expect(counts[1]).toMatchObject({ path: "tests/auth.test.ts", count: 4 });
});

test("rankFilesByRelevance ranks by total matches + term bonus", () => {
	const hits = new Map([
		["src/a.ts", { matches: 5, terms: new Set(["auth"]) }], // score: 5 + 3*1 = 8
		["src/b.ts", { matches: 2, terms: new Set(["auth", "token", "test"]) }], // score: 2 + 3*3 = 11
		["src/c.ts", { matches: 5, terms: new Set(["auth"]) }], // score: 5 + 3*1 = 8 (tie breaker by path length: same length, preserves order)
	]);
	const ranked = rankFilesByRelevance(hits, 2);
	expect(ranked).toHaveLength(2);
	expect(ranked[0]?.path).toBe("src/b.ts"); // highest score
	expect(ranked[1]?.path).toBe("src/a.ts");
});

test("explore tool extracts terms and aggregates ripgrep results", async () => {
	const exec = makeExec({
		"-l -i --no-messages auth": "src/auth.ts\nsrc/session.ts\n",
		"-l -i --no-messages token": "src/auth.ts\n",
		"-c -i --no-messages auth": "src/auth.ts:5\nsrc/session.ts:2\n",
		"-c -i --no-messages token": "src/auth.ts:3\n",
	});

	const tool = new ExploreTool(exec);
	const result = await tool.execute("call-1", { query: "auth token", max_files: 8 });

	expect(result.details?.terms).toContain("auth");
	expect(result.details?.terms).toContain("token");
	expect(result.details?.files).toHaveLength(2);

	const authFile = result.details?.files.find(f => f.path === "src/auth.ts");
	expect(authFile?.matches).toBe(8); // 5 (auth) + 3 (token)
	expect(authFile?.terms).toHaveLength(2);

	const sessionFile = result.details?.files.find(f => f.path === "src/session.ts");
	expect(sessionFile?.matches).toBe(2);
});

test("explore tool returns empty state when no files match", async () => {
	const exec = makeExec({});
	const tool = new ExploreTool(exec);
	const result = await tool.execute("call-1", { query: "missingterm", max_files: 8 });
	expect(result.details?.files).toHaveLength(0);
	expect(result.content[0]?.type).toBe("text");
});
