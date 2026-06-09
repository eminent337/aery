import type { PythonKernelExecutor } from "@aryee337/aery/eval/py/executor";
import type { KernelExecuteOptions, KernelExecuteResult } from "@aryee337/aery/eval/py/kernel";

export class FakeKernel implements PythonKernelExecutor {
	private result: KernelExecuteResult;
	private onExecute: (options?: KernelExecuteOptions) => Promise<void> | void;

	constructor(result: KernelExecuteResult, onExecute: (options?: KernelExecuteOptions) => Promise<void> | void) {
		this.result = result;
		this.onExecute = onExecute;
	}

	async execute(_code: string, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		await this.onExecute(options);
		return this.result;
	}
}
