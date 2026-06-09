import { $ } from "bun";
import { join } from "node:path";

/**
 * Aery Upstream Radar (The "R&D Lab" Feeder)
 * 
 * Instead of merging AERY's code, Aery uses this script to "feed" on AERY's 
 * updates. It fetches upstream changes and lists them out as "R&D concepts" 
 * so Aery developers can decide what to build natively.
 */

async function main() {
  console.log("📡 Aery Upstream Radar: Scanning for new AERY features...");
  
  // 1. Fetch the latest from upstream
  try {
    await $`git fetch upstream main`.quiet();
  } catch (err) {
    console.error("⚠️ Failed to fetch upstream. Make sure 'upstream' remote is configured.");
    console.log("Run: git remote add upstream https://github.com/cline/aery.git");
    process.exit(1);
  }

  // 2. See how far behind we are
  const countRaw = await $`git rev-list --count HEAD..upstream/main`.text();
  const count = parseInt(countRaw.trim(), 10);

  if (count === 0) {
    console.log("✨ Aery is fully up-to-date. No new R&D concepts found.");
    return;
  }

  console.log(`\n🔍 Found ${count} new updates in the upstream R&D lab!\n`);

  // 3. Get the commits
  const commitsRaw = await $`git log --oneline HEAD..upstream/main`.text();
  const commits = commitsRaw.trim().split('\n');

  console.log("💡 NEW R&D CONCEPTS TO EVALUATE FOR AERY:");
  console.log("========================================");
  
  for (const commit of commits) {
    const [hash, ...msgParts] = commit.split(' ');
    const msg = msgParts.join(' ');
    
    // Filter out boring commits (chores, version bumps)
    if (msg.toLowerCase().includes('chore') || msg.toLowerCase().includes('bump') || msg.toLowerCase().includes('merge')) {
      continue;
    }

    console.log(`- [${hash}] ${msg}`);
  }

  console.log("\n🛠️  INSTRUCTIONS:");
  console.log("1. Do NOT blindly merge these.");
  console.log("2. Pick a concept from above that looks useful.");
  console.log("3. Ask Aery to build a better, native version of it tailored to the Aery TUI and architecture.");
  console.log("4. (Optional) Run ./scripts/aery-sync-aery.sh <hash> if it's a simple bugfix.");
}

main().catch(console.error);
