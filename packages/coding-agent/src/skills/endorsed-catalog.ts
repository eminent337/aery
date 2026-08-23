/**
 * Endorsed skills catalog.
 *
 * Curated list of recommended skills that users may want to install, ported
 * from the jcode upstream catalog (crates/jcode-base/src/skill.rs,
 * `ENDORSED_SKILLS`). Used by the `/skill` command family to show which
 * recommended skills the user has already installed and which they are
 * missing. This is the single source of truth for endorsed skills.
 *
 * Each entry carries an optional `install` hint (e.g. an `npx skills` command
 * or a marketplace name). The `installed` determination is computed against
 * Aery's loaded skill registry at render time so edits are visible without a
 * restart.
 */
export interface EndorsedSkill {
	/** Skill name (matches the SKILL.md frontmatter `name` when installed). */
	name: string;
	/** Short description shown in the catalog. */
	description: string;
	/** Display category, used to group entries. */
	category: string;
	/** Where the skill comes from (bundled, marketplace, catalog repo). */
	source: string;
	/** Optional install command / instruction. `null` when bundled. */
	install: string | null;
}

/**
 * Curated list of skills endorsed by Aery. Categories mirror the jcode
 * upstream grouping: bundled skills, official Anthropic catalog, and
 * NVIDIA-verified GPU-accelerated computing skills.
 */
export const ENDORSED_SKILLS: readonly EndorsedSkill[] = [
	{
		name: "optimization",
		description:
			"Improve performance, latency, throughput, memory usage, or general efficiency by defining metrics, measuring, attributing bottlenecks, and prioritizing macro-optimizations.",
		category: "Aery",
		source: "bundled in Aery repo (/skills/optimization)",
		install: null,
	},
	{
		name: "todo-planning-skill",
		description:
			"Create thorough, well-structured todo lists for long tasks, including reflection, static analysis, verification, and next-step updates.",
		category: "Aery",
		source: "bundled with Aery / Claude Code skills",
		install: null,
	},
	{
		name: "firefox-browser",
		description:
			"Control the user's Firefox browser with their logins and cookies intact to browse, fill forms, click, screenshot, and read authenticated pages.",
		category: "Aery",
		source: "bundled with Aery / Claude Code skills",
		install: null,
	},
	// Anthropic official skills (github.com/anthropics/skills, Apache-2.0).
	{
		name: "frontend-design",
		description:
			"Create distinctive, production-grade frontend interfaces with high design quality (web components, pages, apps). Generates creative, polished code that avoids generic AI aesthetics.",
		category: "Anthropic Design",
		source: "anthropics/skills (official Anthropic catalog)",
		install: "npx skills add anthropics/skills --skill frontend-design --yes",
	},
	// NVIDIA CUDA-X / GPU accelerated-computing skills from the official
	// NVIDIA-verified catalog (github.com/NVIDIA/skills).
	{
		name: "cuopt-developer",
		description:
			"Modify, build, test, debug, and contribute to NVIDIA cuOpt (C++/CUDA, Python, server, CI) — solver internals, PRs, DCO, and code conventions.",
		category: "NVIDIA CUDA-X",
		source: "NVIDIA/skills (official NVIDIA-verified catalog)",
		install: "npx skills add nvidia/skills --skill cuopt-developer --yes",
	},
	{
		name: "cuopt-install",
		description: "Install NVIDIA cuOpt for Python, C, or server via pip, conda, or Docker, and verify the install.",
		category: "NVIDIA CUDA-X",
		source: "NVIDIA/skills (official NVIDIA-verified catalog)",
		install: "npx skills add nvidia/skills --skill cuopt-install --yes",
	},
	{
		name: "cuopt-numerical-optimization-api-c",
		description: "Solve LP, MILP, and QP (beta) with the cuOpt C API for embedding optimization in C/C++.",
		category: "NVIDIA CUDA-X",
		source: "NVIDIA/skills (official NVIDIA-verified catalog)",
		install: "npx skills add nvidia/skills --skill cuopt-numerical-optimization-api-c --yes",
	},
	{
		name: "cuopt-numerical-optimization-api-cli",
		description: "Solve LP, MILP, and QP (beta) with cuOpt from MPS files via the cuopt_cli command line.",
		category: "NVIDIA CUDA-X",
		source: "NVIDIA/skills (official NVIDIA-verified catalog)",
		install: "npx skills add nvidia/skills --skill cuopt-numerical-optimization-api-cli --yes",
	},
	{
		name: "cuopt-numerical-optimization-api-python",
		description:
			"Solve LP, MILP, and QP (beta) with the cuOpt Python API — linear/quadratic objectives, integer variables, scheduling, portfolio, and least squares.",
		category: "NVIDIA CUDA-X",
		source: "NVIDIA/skills (official NVIDIA-verified catalog)",
		install: "npx skills add nvidia/skills --skill cuopt-numerical-optimization-api-python --yes",
	},
	{
		name: "cuopt-numerical-optimization-formulation",
		description:
			"LP, MILP, and QP concepts and formulation patterns (parameters, constraints, decisions, objective). Concepts only; no API.",
		category: "NVIDIA CUDA-X",
		source: "NVIDIA/skills (official NVIDIA-verified catalog)",
		install: "npx skills add nvidia/skills --skill cuopt-numerical-optimization-formulation --yes",
	},
	{
		name: "cuopt-routing-api-python",
		description: "Solve vehicle routing (VRP, TSP, PDP) with the cuOpt Python API.",
		category: "NVIDIA CUDA-X",
		source: "NVIDIA/skills (official NVIDIA-verified catalog)",
		install: "npx skills add nvidia/skills --skill cuopt-routing-api-python --yes",
	},
	{
		name: "cuopt-routing-formulation",
		description:
			"Vehicle routing (VRP, TSP, PDP) problem types and data requirements. Domain concepts; no API or interface.",
		category: "NVIDIA CUDA-X",
		source: "NVIDIA/skills (official NVIDIA-verified catalog)",
		install: "npx skills add nvidia/skills --skill cuopt-routing-formulation --yes",
	},
	{
		name: "cuopt-server-api-python",
		description: "Run the cuOpt REST server — start it, call endpoints, and use Python/curl client examples.",
		category: "NVIDIA CUDA-X",
		source: "NVIDIA/skills (official NVIDIA-verified catalog)",
		install: "npx skills add nvidia/skills --skill cuopt-server-api-python --yes",
	},
	{
		name: "cuopt-server-common",
		description:
			"Understand what the cuOpt REST server does and how requests flow. Concepts only; no deploy or client code.",
		category: "NVIDIA CUDA-X",
		source: "NVIDIA/skills (official NVIDIA-verified catalog)",
		install: "npx skills add nvidia/skills --skill cuopt-server-common --yes",
	},
	{
		name: "cuopt-user-rules",
		description: "Base rules for end users calling NVIDIA cuOpt (routing/LP/MILP/QP/install/server).",
		category: "NVIDIA CUDA-X",
		source: "NVIDIA/skills (official NVIDIA-verified catalog)",
		install: "npx skills add nvidia/skills --skill cuopt-user-rules --yes",
	},
	{
		name: "cupynumeric-install",
		description:
			"Install and verify NVIDIA cuPyNumeric (NumPy/SciPy on multi-node multi-GPU) for Python — requirements, commands, and verification.",
		category: "NVIDIA CUDA-X",
		source: "NVIDIA/skills (official NVIDIA-verified catalog)",
		install: "npx skills add nvidia/skills --skill cupynumeric-install --yes",
	},
	{
		name: "cupynumeric-migration-readiness",
		description:
			"Assess NumPy code before porting to cuPyNumeric — which patterns scale on GPU, what must be refactored, and a READY/REFACTOR/NOT-RECOMMENDED verdict.",
		category: "NVIDIA CUDA-X",
		source: "NVIDIA/skills (official NVIDIA-verified catalog)",
		install: "npx skills add nvidia/skills --skill cupynumeric-migration-readiness --yes",
	},
	{
		name: "cupynumeric-hdf5",
		description:
			"Read and write large cuPyNumeric arrays to HDF5 with Legate's parallel, distributed HDF5 I/O (legate.io.hdf5), including GPUDirect Storage.",
		category: "NVIDIA CUDA-X",
		source: "NVIDIA/skills (official NVIDIA-verified catalog)",
		install: "npx skills add nvidia/skills --skill cupynumeric-hdf5 --yes",
	},
	{
		name: "cupynumeric-parallel-data-load",
		description:
			"Load sharded on-disk datasets (.npy, Parquet/Arrow, raw binary, sharded HDF5) into a distributed cuPyNumeric ndarray via manual partition + leaf task launch.",
		category: "NVIDIA CUDA-X",
		source: "NVIDIA/skills (official NVIDIA-verified catalog)",
		install: "npx skills add nvidia/skills --skill cupynumeric-parallel-data-load --yes",
	},
	{
		name: "accelerated-computing-cudf",
		description:
			"Official NVIDIA guidance for cuDF GPU DataFrames, pandas acceleration, dask-cuDF, ETL, joins, groupby, CSV/Parquet I/O, and multi-GPU DataFrame workloads.",
		category: "NVIDIA CUDA-X",
		source: "NVIDIA/skills (official NVIDIA-verified catalog)",
		install: "npx skills add nvidia/skills --skill accelerated-computing-cudf --yes",
	},
	{
		name: "cudaq-guide",
		description:
			"NVIDIA CUDA-Q (CUDA Quantum) onboarding guide for installation, test programs, GPU simulation, QPU hardware, and quantum applications.",
		category: "NVIDIA CUDA-X",
		source: "NVIDIA/skills (official NVIDIA-verified catalog)",
		install: "npx skills add nvidia/skills --skill cudaq-guide --yes",
	},
	{
		name: "tilegym-adding-cutile-kernel",
		description:
			"Add a new cuTile GPU kernel operator to NVIDIA TileGym — dispatch registration, cuTile backend implementation, exports, tests, and benchmarks.",
		category: "NVIDIA CUDA-X",
		source: "NVIDIA/skills (official NVIDIA-verified catalog)",
		install: "npx skills add nvidia/skills --skill tilegym-adding-cutile-kernel --yes",
	},
];

/** Categories present in {@link ENDORSED_SKILLS}, in display order. */
export const ENDORSED_SKILL_CATEGORIES: readonly string[] = ["Aery", "Anthropic Design", "NVIDIA CUDA-X"];

/**
 * Render the endorsed catalog, grouped by category and marking each entry as
 * installed / not-installed against the given set of installed skill names.
 *
 * Mirrors jcode's `append_endorsed_skills` formatting contract (grouped,
 * status-annotated plain text) so the output is stable and greppable.
 */
export function renderEndorsedSkills(installed: ReadonlySet<string>): string {
	const lines: string[] = [];
	for (const category of ENDORSED_SKILL_CATEGORIES) {
		const entries = ENDORSED_SKILLS.filter(skill => skill.category === category);
		if (entries.length === 0) continue;
		if (lines.length > 0) lines.push("");
		lines.push(`# ${category}`);
		for (const skill of entries) {
			const status = installed.has(skill.name) ? "[installed]" : "[missing]";
			lines.push(`- ${status} ${skill.name} — ${skill.description}`);
			if (skill.install) {
				lines.push(`    install: ${skill.install}`);
			}
		}
	}
	return lines.join("\n");
}

/** Compare installed skill names against {@link ENDORSED_SKILLS} by name. */
export function installedEndorsedSkillNames(installed: ReadonlySet<string>): ReadonlySet<string> {
	const names = new Set<string>();
	for (const skill of ENDORSED_SKILLS) {
		if (installed.has(skill.name)) {
			names.add(skill.name);
		}
	}
	return names;
}
