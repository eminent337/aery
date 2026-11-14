import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SwarmMember } from "../types";

export class MemberRegistry {
	private readonly filePath: string;
	private members = new Map<string, SwarmMember>();

	constructor(storageDir: string) {
		if (!existsSync(storageDir)) {
			mkdirSync(storageDir, { recursive: true });
		}
		this.filePath = join(storageDir, "members.json");
		this.load();
	}

	private load(): void {
		if (!existsSync(this.filePath)) return;
		try {
			const raw = readFileSync(this.filePath, "utf-8");
			const parsed = JSON.parse(raw) as SwarmMember[];
			for (const m of parsed) {
				this.members.set(m.name, m);
			}
		} catch {
			this.members.clear();
		}
	}

	private persist(): void {
		const list = Array.from(this.members.values());
		writeFileSync(this.filePath, JSON.stringify(list, null, 2), "utf-8");
	}

	public addMember(member: SwarmMember): void {
		this.members.set(member.name, member);
		this.persist();
	}

	public getMember(name: string): SwarmMember | undefined {
		return this.members.get(name);
	}

	public updateMember(name: string, partial: Partial<SwarmMember>): SwarmMember | undefined {
		const existing = this.members.get(name);
		if (!existing) return undefined;
		const updated: SwarmMember = {
			...existing,
			...partial,
			updatedAt: new Date().toISOString(),
		};
		this.members.set(name, updated);
		this.persist();
		return updated;
	}

	public removeMember(name: string): boolean {
		const res = this.members.delete(name);
		if (res) this.persist();
		return res;
	}

	public listMembers(): SwarmMember[] {
		return Array.from(this.members.values());
	}
}
