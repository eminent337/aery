/**
 * sync-deps.mjs
 *
 * Syncs inter-workspace package dependencies to use "*" as the version specifier.
 *
 * Why "*" instead of "^x.y.z"?
 * NPM v10's Arborist has a known crash (TypeError: Cannot read properties of null
 * reading 'package') when a workspace package declares a dependency on another
 * workspace package using a semver range like "^0.74.0" that doesn't match the
 * locally available version. This happens every time upstream-clean is merged
 * because it resets coding-agent's package.json to the upstream version.
 *
 * Using "*" makes Arborist pick the local workspace version without any version
 * comparison, completely avoiding the bug.
 */
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const packagesDir = join(process.cwd(), 'packages');
const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
	.filter(dirent => dirent.isDirectory())
	.map(dirent => dirent.name);

// Build a set of all workspace package names
const workspacePackageNames = new Set();
const packages = {};

for (const dir of packageDirs) {
	const pkgPath = join(packagesDir, dir, 'package.json');
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
		packages[dir] = { path: pkgPath, data: pkg };
		workspacePackageNames.add(pkg.name);
	} catch (e) {
	}
}

let totalUpdates = 0;
for (const [dir, pkg] of Object.entries(packages)) {
	let updated = false;
	for (const depType of ['dependencies', 'devDependencies']) {
		if (pkg.data[depType]) {
			for (const [depName, currentVersion] of Object.entries(pkg.data[depType])) {
				if (workspacePackageNames.has(depName) && currentVersion !== '*') {
					pkg.data[depType][depName] = '*';
					updated = true;
					totalUpdates++;
				}
			}
		}
	}
	if (updated) {
		writeFileSync(pkg.path, JSON.stringify(pkg.data, null, '\t') + '\n');
	}
}

if (totalUpdates > 0) {
	console.log(`sync-deps: updated ${totalUpdates} workspace dependency version(s) to "*"`);
} else {
	console.log('sync-deps: all workspace dependencies already normalized');
}
