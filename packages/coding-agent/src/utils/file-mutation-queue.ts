/**
 * Sequential file mutation queue to prevent concurrent read/write races on the same file path.
 */
const fileMutationQueues = new Map<string, Promise<unknown>>();

export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const previous = fileMutationQueues.get(filePath) ?? Promise.resolve();
	let resolveCurrent!: () => void;
	const current = new Promise<void>(res => {
		resolveCurrent = res;
	});
	fileMutationQueues.set(filePath, current);
	try {
		await previous;
		return await fn();
	} finally {
		resolveCurrent();
		if (fileMutationQueues.get(filePath) === current) {
			fileMutationQueues.delete(filePath);
		}
	}
}
