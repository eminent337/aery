/**
 * Performance Benchmark: Tool Execution & Core Engine Latencies.
 *
 * Measures:
 * 1. File read throughput (Bun.file vs node:fs vs native)
 * 2. Shell execution latency (executeBash vs native PTY vs direct spawn)
 * 3. Exact string replace vs hashline diffing
 * 4. Token counting throughput (Rust NAPI countTokens vs JS)
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { countTokens, executeShell, grep } from "@aryee337/aery-engine";
import { executeBash } from "../exec/bash-executor";

async function runBenchmarks() {
	console.log("=== Aery vs Native Performance Benchmark ===");

	// 1. File Read Benchmark
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aery-perf-"));
	const testFilePath = path.join(tempDir, "large_file.txt");
	const lineCount = 50_000;
	const sampleContent = Array.from({ length: lineCount }, (_, i) => `line ${i}: const data = { id: ${i}, value: "test-${i}" };`).join("\n");
	await fs.writeFile(testFilePath, sampleContent, "utf-8");
	const fileSizeMb = (sampleContent.length / (1024 * 1024)).toFixed(2);
	console.log(`\n[Benchmark 1] File Read Throughput (${fileSizeMb} MB, ${lineCount} lines)`);

	// A: Bun.file(path).text()
	const startBun = performance.now();
	const contentBun = await Bun.file(testFilePath).text();
	const durationBun = performance.now() - startBun;
	console.log(`- Bun.file().text(): ${durationBun.toFixed(2)} ms (${contentBun.length} chars)`);

	// B: fs.promises.readFile()
	const startFs = performance.now();
	const contentFs = await fs.readFile(testFilePath, "utf-8");
	const durationFs = performance.now() - startFs;
	console.log(`- fs.promises.readFile(): ${durationFs.toFixed(2)} ms (${contentFs.length} chars)`);

	// 2. Shell Execution Latency
	console.log("\n[Benchmark 2] Shell Execution Latency ('echo test')");

	// Warmup run
	await executeBash("echo warmup", { skipPolicyGuardian: true });

	// A: executeBash (warmed up)
	const bashLatencies: number[] = [];
	for (let i = 0; i < 5; i++) {
		const startBash = performance.now();
		await executeBash("echo test", { skipPolicyGuardian: true });
		bashLatencies.push(performance.now() - startBash);
	}
	const avgBash = (bashLatencies.reduce((a, b) => a + b, 0) / bashLatencies.length).toFixed(2);
	console.log(`- executeBash (warmed session, 5 runs): avg ${avgBash} ms (individual: ${bashLatencies.map(n => n.toFixed(1) + "ms").join(", ")})`);

	// B: direct Bun.spawn
	const spawnLatencies: number[] = [];
	for (let i = 0; i < 5; i++) {
		const startSpawn = performance.now();
		const proc = Bun.spawn(["echo", "test"], { stdout: "pipe" });
		await new Response(proc.stdout).text();
		spawnLatencies.push(performance.now() - startSpawn);
	}
	const avgSpawn = (spawnLatencies.reduce((a, b) => a + b, 0) / spawnLatencies.length).toFixed(2);
	console.log(`- direct Bun.spawn (5 runs): avg ${avgSpawn} ms (individual: ${spawnLatencies.map(n => n.toFixed(1) + "ms").join(", ")})`);

	// 3. Search / Grep Throughput
	console.log("\n[Benchmark 3] Search / Grep Throughput (50k lines)");
	const startGrep = performance.now();
	const grepRes = await grep({
		pattern: "line 49999",
		path: tempDir,
	});
	const durationGrep = performance.now() - startGrep;
	console.log(`- Native Rust grep (NAPI): ${durationGrep.toFixed(2)} ms (matches: ${grepRes.matches.length})`);

	// 4. Token Counting Throughput
	console.log("\n[Benchmark 4] Token Counting Throughput (50k lines)");
	const startTokens = performance.now();
	const tokens = countTokens(sampleContent);
	const durationTokens = performance.now() - startTokens;
	console.log(`- Native Rust countTokens: ${durationTokens.toFixed(2)} ms (${tokens} tokens, ${(tokens / durationTokens * 1000).toFixed(0)} tokens/sec)`);

	// 5. String Replace vs Hashline
	console.log("\n[Benchmark 5] Exact String Replace vs Hashline");
	const startReplace = performance.now();
	const target = 'line 25000: const data = { id: 25000, value: "test-25000" };';
	const replacement = 'line 25000: const data = { id: 25000, value: "MODIFIED" };';
	const replaced = sampleContent.replace(target, replacement);
	const durationReplace = performance.now() - startReplace;
	console.log(`- Exact String Replace (agy style): ${durationReplace.toFixed(2)} ms (success: ${replaced.includes("MODIFIED")})`);

	// Cleanup
	await fs.rm(tempDir, { recursive: true, force: true });
	console.log("\n=== Benchmark Complete ===");
}

runBenchmarks().catch(console.error);
