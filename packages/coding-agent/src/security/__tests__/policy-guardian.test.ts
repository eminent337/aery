import { describe, expect, it } from "bun:test";
import { PolicyGuardian } from "../policy-guardian";

describe("PolicyGuardian (ported from agy)", () => {
	const guardian = new PolicyGuardian();

	it("blocks git add and commit targeting .env files", () => {
		const check1 = guardian.validate("git add .env");
		expect(check1.allowed).toBe(false);
		expect(check1.ruleName).toBe("vet_credential_leak");
		expect(check1.reason).toContain(".env files is prohibited");

		const check2 = guardian.validate("git commit -m 'feat' .env.local");
		expect(check2.allowed).toBe(false);

		// Safe git actions should pass
		const checkSafe = guardian.validate("git add src/index.ts && git commit -m 'update'");
		expect(checkSafe.allowed).toBe(true);
	});

	it("blocks recursive system deletion commands", () => {
		const checkRoot = guardian.validate("rm -rf /");
		expect(checkRoot.allowed).toBe(false);
		expect(checkRoot.ruleName).toBe("vet_system_destruction");

		const checkEtc = guardian.validate("rm -r /etc/config");
		expect(checkEtc.allowed).toBe(false);

		// Project subdirectory deletion should pass
		const checkProject = guardian.validate("rm -rf dist/ tmp/");
		expect(checkProject.allowed).toBe(true);
	});

	it("blocks force-pushing to protected branches", () => {
		const checkForce = guardian.validate("git push origin main --force");
		expect(checkForce.allowed).toBe(false);
		expect(checkForce.ruleName).toBe("vet_irreversible_push");

		const checkShortForce = guardian.validate("git push -f origin master");
		expect(checkShortForce.allowed).toBe(false);

		// Pushing to feature branches normally should pass
		const checkFeature = guardian.validate("git push origin feature/my-feature");
		expect(checkFeature.allowed).toBe(true);
	});

	it("blocks live cluster workload mutation without dry-run", () => {
		const checkDelete = guardian.validate("kubectl delete deployment my-service");
		expect(checkDelete.allowed).toBe(false);
		expect(checkDelete.ruleName).toBe("vet_cluster_mutation");

		// Dry-run should pass
		const checkDry = guardian.validate("kubectl delete deployment my-service --dry-run=client");
		expect(checkDry.allowed).toBe(true);

		// Read-only kubectl commands should pass
		const checkGet = guardian.validate("kubectl get pods -A");
		expect(checkGet.allowed).toBe(true);
	});

	it("blocks blanket process kill commands", () => {
		const checkKillall = guardian.validate("killall -9 node");
		expect(checkKillall.allowed).toBe(false);
		expect(checkKillall.ruleName).toBe("vet_broad_kill");

		// Targeted PID kill should pass
		const checkPid = guardian.validate("kill 1234");
		expect(checkPid.allowed).toBe(true);
	});
});
