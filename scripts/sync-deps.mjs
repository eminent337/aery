import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const packagesDir = join(process.cwd(), 'packages');
const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
	.filter(dirent => dirent.isDirectory())
	.map(dirent => dirent.name);

const versionMap = {};
const packages = {};

for (const dir of packageDirs) {
	const pkgPath = join(packagesDir, dir, 'package.json');
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
		packages[dir] = { path: pkgPath, data: pkg };
		versionMap[pkg.name] = pkg.version;
	} catch (e) {
	}
}

for (const [dir, pkg] of Object.entries(packages)) {
	let updated = false;
	for (const depType of ['dependencies', 'devDependencies']) {
		if (pkg.data[depType]) {
			for (const [depName, currentVersion] of Object.entries(pkg.data[depType])) {
				if (versionMap[depName]) {
					const newVersion = `^${versionMap[depName]}`;
					if (currentVersion !== newVersion) {
						pkg.data[depType][depName] = newVersion;
						updated = true;
					}
				}
			}
		}
	}
	if (updated) {
		writeFileSync(pkg.path, JSON.stringify(pkg.data, null, '\t') + '\n');
	}
}
