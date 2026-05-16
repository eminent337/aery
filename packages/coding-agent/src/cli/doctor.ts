import chalk from "chalk";
import { join } from "path";
import { APP_NAME, getAgentDir, VERSION } from "../config.js";
import { type AuthStatus, AuthStorage } from "../core/auth-storage.js";
import { ModelRegistry } from "../core/model-registry.js";
import { type CoreExtensionDiagnostic, diagnoseCoreExtensions } from "../migrations.js";
import { getLatestAeryVersion, isNewerPackageVersion } from "../utils/version-check.js";

function isTruthyEnvFlag(value: string | undefined): boolean {
	return value === "1" || value === "true" || value === "yes";
}

export interface DoctorProviderStatus {
	provider: string;
	status: AuthStatus;
}

export interface DoctorReport {
	version: {
		local: string;
		latest?: string;
		updateAvailable?: boolean;
		error?: string;
	};
	providers: DoctorProviderStatus[];
	coreExtensions: CoreExtensionDiagnostic;
}

export interface DoctorReportOptions {
	version?: string;
	authStorage?: AuthStorage;
	modelRegistry?: ModelRegistry;
	latestVersion?: (currentVersion: string) => Promise<string | undefined>;
	coreExtensions?: CoreExtensionDiagnostic;
	agentDir?: string;
}

const DEFAULT_PROVIDER_CHECKS = [
	"anthropic",
	"openai",
	"google",
	"openrouter",
	"cloudflare-workers-ai",
	"deepseek",
	"mistral",
	"groq",
	"xai",
	"bedrock",
];

export function getCoreExtensionDiagnostic(agentDir: string = getAgentDir()): CoreExtensionDiagnostic {
	const repoPath = join(agentDir, "git", "github.com", "eminent337", "aery-extensions");
	const settingsPath = join(agentDir, "settings.json");
	return diagnoseCoreExtensions(repoPath, settingsPath);
}

export function formatCurrentCoreExtensionsReport(agentDir: string = getAgentDir()): string {
	return formatCoreExtensionsReport(getCoreExtensionDiagnostic(agentDir));
}

export async function collectDoctorReport(options: DoctorReportOptions = {}): Promise<DoctorReport> {
	const version = options.version ?? VERSION;
	const authStorage = options.authStorage ?? AuthStorage.create();
	const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage);
	const latestVersion =
		options.latestVersion ??
		(isTruthyEnvFlag(process.env.AERY_OFFLINE) || isTruthyEnvFlag(process.env.AERY_SKIP_VERSION_CHECK)
			? async () => undefined
			: getLatestAeryVersion);
	const providerIds = [...new Set([...DEFAULT_PROVIDER_CHECKS, ...authStorage.list()])].sort();

	let latest: string | undefined;
	let versionError: string | undefined;
	try {
		latest = await latestVersion(version);
	} catch (error) {
		versionError = error instanceof Error ? error.message : String(error);
	}

	return {
		version: {
			local: version,
			latest,
			updateAvailable: latest ? isNewerPackageVersion(latest, version) : false,
			error: versionError,
		},
		providers: providerIds.map((provider) => ({
			provider,
			status: modelRegistry.getProviderAuthStatus(provider),
		})),
		coreExtensions: options.coreExtensions ?? getCoreExtensionDiagnostic(options.agentDir),
	};
}

function formatStatus(status: AuthStatus): string {
	if (status.configured) {
		const source = status.source ? ` via ${status.source}` : "";
		const label = status.label ? ` (${status.label})` : "";
		return `configured${source}${label}`;
	}
	if (status.label) {
		return status.label;
	}
	if (status.source) {
		return `detected via ${status.source}`;
	}
	return "not configured";
}

export function formatDoctorReport(report: DoctorReport): string {
	const lines: string[] = [];
	lines.push(chalk.bold(`${APP_NAME.charAt(0).toUpperCase()}${APP_NAME.slice(1)} Doctor`));
	lines.push("");
	lines.push(chalk.bold("Version"));
	lines.push(`  local: ${report.version.local}`);
	if (report.version.latest) {
		const suffix = report.version.updateAvailable ? " (update available)" : " (latest)";
		lines.push(`  latest: ${report.version.latest}${suffix}`);
	} else if (report.version.error) {
		lines.push(`  latest: unavailable (${report.version.error})`);
	} else {
		lines.push("  latest: unavailable");
	}

	lines.push("");
	lines.push(chalk.bold("Providers"));
	for (const provider of report.providers) {
		lines.push(`  ${provider.provider}: ${formatStatus(provider.status)}`);
	}

	lines.push("");
	lines.push(formatCoreExtensionsReport(report.coreExtensions));

	return lines.join("\n");
}

export function formatCoreExtensionsReport(extensions: CoreExtensionDiagnostic): string {
	const lines: string[] = [];
	lines.push(chalk.bold("Core Extensions"));
	if (!extensions.repoExists) {
		lines.push("  core extensions: not installed");
		lines.push("  repair: run aery update --extensions");
	} else if (extensions.missingFiles.length > 0 || extensions.missingSettingsEntries.length > 0) {
		lines.push("  core extensions: attention needed");
		lines.push(`  missing files: ${extensions.missingFiles.length}`);
		lines.push(`  missing settings entries: ${extensions.missingSettingsEntries.length}`);
		lines.push("  repair: run aery update --extensions");
	} else {
		lines.push("  core extensions: ok");
	}
	return lines.join("\n");
}

export async function runDoctorCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "doctor") {
		return false;
	}

	const json = args.includes("--json");
	const report = await collectDoctorReport();
	if (json) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log(formatDoctorReport(report));
	}
	return true;
}
