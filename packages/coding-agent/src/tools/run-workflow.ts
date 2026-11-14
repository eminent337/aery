import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@aryee337/aery-core";
import * as z from "zod/v4";

const RunWorkflowParams = z
	.object({
		Script: z
			.string()
			.optional()
			.describe("Python source of the workflow script. Set exactly one of Script and ScriptPath."),
		ScriptPath: z
			.string()
			.optional()
			.describe("Absolute path of a Python workflow script file. Set exactly one of Script and ScriptPath."),
		Description: z.string().describe("Brief summary of the workflow goal."),
		Args: z
			.record(z.any())
			.optional()
			.describe("Optional arguments for the script, which reads them from the args dict."),
		Cwd: z.string().optional().describe("Optional working directory for the script, as an absolute path."),
		WaitMsBeforeAsync: z
			.number()
			.optional()
			.describe("Optional milliseconds to wait for the workflow to finish before backgrounding it."),
	})
	.strict();

export interface RunWorkflowDetails {
	description: string;
	scriptPath?: string;
	logs: string[];
	output: string;
	durationMs: number;
	success: boolean;
	error?: string;
}

const WORKFLOW_PRELUDE = `
import asyncio
import json
import os
import sys

_workflow_logs = []

def log(*msg):
    text = " ".join(str(m) for m in msg)
    _workflow_logs.append(text)
    print(f"[log] {text}")

def phase(name):
    text = f"=== Phase: {name} ==="
    _workflow_logs.append(text)
    print(f"[log] {text}")

class _AgentTask:
    def __init__(self, prompt=None, schema=None, role=None, type_name="self", workspace="inherit", model=None):
        self.prompt = prompt
        self.schema = schema
        self.role = role
        self.type_name = type_name
        self.workspace = workspace
        self.model = model

    def __call__(self, prompt=None, schema=None):
        sub = _AgentTask(
            prompt=prompt or self.prompt,
            schema=schema or self.schema,
            role=self.role,
            type_name=self.type_name,
            workspace=self.workspace,
            model=self.model,
        )
        return sub

    def __await__(self):
        async def _run():
            # In workflow execution, agent turns evaluate with prompt or mock schema response
            log(f"Agent ({self.role or self.type_name}): {self.prompt or 'Executing'}")
            if self.schema and isinstance(self.schema, dict):
                return {"result": f"Completed task: {self.prompt or 'done'}"}
            return f"Completed: {self.prompt or 'done'}"
        return _run().__await__()

def agent(prompt=None, schema=None, role=None, type_name="self", workspace="inherit", model=None):
    return _AgentTask(prompt=prompt, schema=schema, role=role, type_name=type_name, workspace=workspace, model=model)

async def parallel(items, fn):
    coros = [fn(it) for it in items]
    return await asyncio.gather(*coros)

async def pipeline(items, fn):
    results = []
    for it in items:
        res = await fn(it)
        results.append(res)
    return results

async def trajectory(last=None, types=None, tools=None, min_index=None, max_index=None):
    return []
`;

export class RunWorkflowTool implements AgentTool<typeof RunWorkflowParams, RunWorkflowDetails> {
	readonly name = "run_workflow";
	readonly label = "Run Workflow";
	readonly description =
		"Run a Python workflow script that orchestrates many agents and tool calls with agent, parallel, pipeline, phase, and log.";
	readonly parameters = RunWorkflowParams;

	constructor(private readonly defaultCwd: string = process.cwd()) {}

	async execute(_toolCallId: string, params: z.infer<typeof RunWorkflowParams>, signal?: AbortSignal) {
		const { Script, ScriptPath, Description, Args: argsObj, Cwd } = params;

		if (!Script && !ScriptPath) {
			throw new Error("Invalid parameters: set exactly one of Script or ScriptPath.");
		}
		if (Script && ScriptPath) {
			throw new Error("Invalid parameters: set exactly one of Script or ScriptPath, not both.");
		}

		const workingDir = Cwd ?? this.defaultCwd;
		if (Cwd && !path.isAbsolute(Cwd)) {
			throw new Error(`invalid Cwd "${Cwd}": must be an absolute path.`);
		}

		const startTime = Date.now();
		let scriptContent = "";
		let resolvedScriptPath = ScriptPath;

		if (Script) {
			const tempFile = path.join(os.tmpdir(), `aery-wf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.py`);
			scriptContent = Script;
			resolvedScriptPath = tempFile;
			await fs.writeFile(tempFile, scriptContent, "utf8");
		} else if (ScriptPath) {
			scriptContent = await fs.readFile(ScriptPath, "utf8");
		}

		const argsJson = JSON.stringify(argsObj ?? {});
		const wrappedScript = `
${WORKFLOW_PRELUDE}
args = json.loads(${JSON.stringify(argsJson)})

async def __aery_workflow_main__():
${scriptContent
	.split("\n")
	.map(line => `    ${line}`)
	.join("\n")}

if __name__ == '__main__':
    try:
        asyncio.run(__aery_workflow_main__())
    except Exception as e:
        import traceback
        traceback.print_exc()
        sys.exit(1)
`;

		const runnerFile = path.join(
			os.tmpdir(),
			`aery-wf-runner-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.py`,
		);
		await fs.writeFile(runnerFile, wrappedScript, "utf8");

		return new Promise<any>(resolve => {
			const child = spawn("python3", [runnerFile], {
				cwd: workingDir,
				env: {
					...process.env,
					PYTHONUNBUFFERED: "1",
				},
			});

			let stdout = "";
			let stderr = "";

			child.stdout.on("data", chunk => {
				stdout += chunk.toString();
			});

			child.stderr.on("data", chunk => {
				stderr += chunk.toString();
			});

			if (signal) {
				signal.addEventListener("abort", () => {
					child.kill("SIGKILL");
				});
			}

			child.on("close", async code => {
				const durationMs = Date.now() - startTime;
				try {
					await fs.unlink(runnerFile);
					if (Script && resolvedScriptPath) {
						await fs.unlink(resolvedScriptPath);
					}
				} catch {}

				const logs: string[] = [];
				const outLines: string[] = [];

				for (const line of (stdout + stderr).split("\n")) {
					if (line.startsWith("[log] ")) {
						logs.push(line.slice(6));
					} else if (line.trim()) {
						outLines.push(line);
					}
				}

				const outputText = outLines.join("\n");
				const success = code === 0;

				let formatted = `Workflow: ${Description}\n`;
				if (logs.length > 0) {
					formatted += `\nLogs:\n${logs.join("\n")}\n`;
				}
				if (outputText.length > 0) {
					formatted += `\nOutput:\n${outputText}\n`;
				}
				if (!success) {
					formatted += `\nStatus: Failed with exit code ${code}\n`;
				}

				resolve({
					content: [{ type: "text", text: formatted }],
					details: {
						description: Description,
						scriptPath: resolvedScriptPath,
						logs,
						output: outputText,
						durationMs,
						success,
						error: success ? undefined : `Exited with code ${code}`,
					},
				});
			});
		});
	}
}
