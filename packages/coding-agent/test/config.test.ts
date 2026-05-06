import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import { afterEach, describe, expect, test } from "vitest";
import {
	detectInstallMethod,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	getUpdateInstruction,
} from "../src/config.js";

const originalPath = process.env.PATH;
const originalAeryPackageDir = process.env.AERY_PACKAGE_DIR;
let tempDir: string | undefined;

afterEach(() => {
	if (originalPath === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = originalPath;
	}
	if (originalAeryPackageDir === undefined) {
		delete process.env.AERY_PACKAGE_DIR;
	} else {
		process.env.AERY_PACKAGE_DIR = originalAeryPackageDir;
	}
	if (tempDir) {
		chmodSync(tempDir, 0o700);
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function setInstallPath(value: string): void {
	// AERY_PACKAGE_DIR is used by getInstallPath() when set
	process.env.AERY_PACKAGE_DIR = value;
}

function createNpmPrefixInstall(template = "aery-prefix-"): { prefix: string; packageDir: string } {
	const prefix = mkdtempSync(join(tmpdir(), template));
	const root = join(prefix, "lib", "node_modules");
	const scopeDir = join(root, "@eminent337");
	const packageDir = join(scopeDir, "aery");
	mkdirSync(packageDir, { recursive: true });
	tempDir = prefix;
	process.env.AERY_PACKAGE_DIR = packageDir;
	return { prefix, packageDir };
}

function createBunGlobalInstall(): { packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "aery-bun-"));
	const prefix = join(temp, ".bun");
	const bunBin = join(prefix, "bin");
	const root = join(prefix, "install", "global", "node_modules");
	const scopeDir = join(root, "@eminent337");
	const packageDir = join(scopeDir, "aery");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(bunBin, { recursive: true });
	writeFileSync(join(bunBin, process.platform === "win32" ? "bun.cmd" : "bun"), createFakeBunScript(bunBin));
	chmodSync(join(bunBin, process.platform === "win32" ? "bun.cmd" : "bun"), 0o755);
	tempDir = temp;
	process.env.PATH = `${bunBin}${delimiter}${originalPath ?? ""}`;
	process.env.AERY_PACKAGE_DIR = packageDir;
	return { packageDir };
}

function createFakeBunScript(bunBin: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="pm" if "%2"=="bin" if "%3"=="-g" echo ${bunBin}\r\n`;
	}
	const escapedBunBin = bunBin.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "pm" ] && [ "$2" = "bin" ] && [ "$3" = "-g" ]; then\n\tprintf '%s\\n' '${escapedBunBin}'\n\texit 0\nfi\nexit 1\n`;
}

describe("detectInstallMethod", () => {
	test("detects pnpm from Windows .pnpm install paths", () => {
		setInstallPath(
			"C:\\Users\\Admin\\Documents\\pnpm-repository\\global\\5\\.pnpm\\@eminent337+aery@0.1.83\\node_modules\\@eminent337\\aery\\dist\\cli.js",
		);

		expect(detectInstallMethod()).toBe("pnpm");
		expect(getUpdateInstruction("@eminent337/aery")).toBe("Run: aery update");
	});

	test("does not self-update unknown wrapper installs", () => {
		setInstallPath("/usr/local/bin/node");

		expect(detectInstallMethod()).toBe("unknown");
		expect(getSelfUpdateCommand("@eminent337/aery")).toBeUndefined();
		expect(getUpdateInstruction("@eminent337/aery")).toBe(
			"Update @eminent337/aery using the package manager, wrapper, or source checkout that provides this installation.",
		);
	});

	test("self-updates npm installs from custom prefixes", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@eminent337/aery");

		expect(detectInstallMethod()).toBe("npm");
		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "@eminent337/aery"],
			display: `npm --prefix ${prefix} install -g @eminent337/aery`,
		});
	});

	test("self-update respects configured npmCommand", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@eminent337/aery", ["npm", "--prefix", prefix]);

		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "@eminent337/aery"],
			display: `npm --prefix ${prefix} install -g @eminent337/aery`,
		});
	});

	test("self-update treats empty npmCommand as unset", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@eminent337/aery", []);

		expect(command?.args).toEqual(["--prefix", prefix, "install", "-g", "@eminent337/aery"]);
	});

	test("quotes npm self-update display paths", () => {
		const { prefix } = createNpmPrefixInstall("aery prefix ");

		const command = getSelfUpdateCommand("@eminent337/aery");

		expect(command?.display).toBe(`npm --prefix "${prefix}" install -g @eminent337/aery`);
	});

	test("does not infer Windows npm custom prefixes from package paths", () => {
		const packageDir = "C:\\Users\\Admin\\npm prefix\\node_modules\\@eminent337\\aery";
		process.env.AERY_PACKAGE_DIR = packageDir;
		setInstallPath(`${packageDir}\\dist\\cli.js`);

		expect(detectInstallMethod()).toBe("npm");
		expect(getUpdateInstruction("@eminent337/aery")).toBe("Run: aery update");
	});

	test("self-updates bun global installs from bun pm bin", () => {
		createBunGlobalInstall();

		const command = getSelfUpdateCommand("@eminent337/aery");

		expect(detectInstallMethod()).toBe("bun");
		expect(command).toEqual({
			command: "bun",
			args: ["install", "-g", "@eminent337/aery"],
			display: "bun install -g @eminent337/aery",
		});
	});

	test("does not self-update when npm install path is not writable", () => {
		const { packageDir } = createNpmPrefixInstall();
		chmodSync(packageDir, 0o500);

		expect(getSelfUpdateCommand("@eminent337/aery")).toBeUndefined();
		expect(getSelfUpdateUnavailableInstruction("@eminent337/aery")).toContain("the install path is not writable");
	});
});
