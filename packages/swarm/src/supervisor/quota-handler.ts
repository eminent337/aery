export class QuotaHandler {
	public isQuotaError(error: unknown): boolean {
		if (!error) return false;
		const msg = error instanceof Error ? error.message : String(error);
		return (
			msg.includes("429") ||
			msg.toLowerCase().includes("rate limit") ||
			msg.toLowerCase().includes("quota exceeded") ||
			msg.toLowerCase().includes("resource exhausted")
		);
	}

	public generateAdvisory(memberName: string, currentModel?: string): string {
		const modelStr = currentModel ? `'${currentModel}'` : "current model";
		return (
			`@coordinator [QUOTA_PAUSED] Worker '${memberName}' hit quota on ${modelStr}. ` +
			`Hot-swap model using swarm{action: 'model', name: '${memberName}', model: '<new-model>'} to resume.`
		);
	}
}
