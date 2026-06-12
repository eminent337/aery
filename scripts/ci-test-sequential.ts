import { $ } from "bun";
import * as path from "node:path";
import * as fs from "node:fs/promises";

async function main() {
    const packagesDir = path.join(process.cwd(), "packages");
    const packages = await fs.readdir(packagesDir);
    let failed = false;
    
    for (const pkg of packages) {
        const pkgPath = path.join(packagesDir, pkg);
        const stat = await fs.stat(pkgPath);
        if (!stat.isDirectory()) continue;
        
        const packageJsonPath = path.join(pkgPath, "package.json");
        try {
            const packageJsonStr = await fs.readFile(packageJsonPath, "utf-8");
            const packageJson = JSON.parse(packageJsonStr);
            if (packageJson.scripts && packageJson.scripts.test) {
                console.log(`\n\n=== Running tests for ${pkg} ===\n`);
                // Explicitly use 'bun test' to run the test runner, which is what we want.
                // We do NOT use 'bun run test' because that could recursively call 'test:ts' if misconfigured.
                const res = await $`bun test`.cwd(pkgPath).nothrow();
                if (res.exitCode !== 0) {
                    console.error(`\nTests failed in ${pkg}\n`);
                    failed = true;
                }
            }
        } catch (e) {
            // ignore if no package.json
        }
    }
    
    if (failed) {
        process.exit(1);
    }
}
main();
