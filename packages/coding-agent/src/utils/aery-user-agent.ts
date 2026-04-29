export function getAeryUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `aery/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
