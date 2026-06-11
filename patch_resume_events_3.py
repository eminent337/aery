import re

with open("packages/coding-agent/src/task/executor.ts", "r") as f:
    text = f.read()

bad_checkAbort = """	const requestAbort = (reason: string) => {
		abortReason = reason;
		sessionAbortController.abort();
	};

	if (options.eventBus) {"""

good_checkAbort = """	const requestAbort = (reason: string) => {
		abortReason = reason;
		sessionAbortController.abort();
	};

	const awaitAbortable = async <T>(promise: Promise<T>): Promise<T> => {
		checkAbort();
		const { promise: abortPromise, reject } = Promise.withResolvers<never>();
		const onAbort = () => {
			try {
				checkAbort();
			} catch (err) {
				reject(err);
			}
		};
		abortSignal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([promise, abortPromise]);
		} finally {
			abortSignal.removeEventListener("abort", onAbort);
		}
	};

	if (options.eventBus) {"""

text = text.replace(bad_checkAbort, good_checkAbort)

with open("packages/coding-agent/src/task/executor.ts", "w") as f:
    f.write(text)

print("done")
