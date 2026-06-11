#!/bin/bash
cat packages/coding-agent/src/exec/bash-executor.ts | sed -e 's|import { executeShell, type MinimizerOptions, Shell, type ShellRunResult } from "@aryee337/aery-natives";|import { executeShell, type MinimizerOptions, Shell, type ShellRunResult } from "@aryee337/aery-natives";\nimport { isExecutable, type ShellConfig } from "@aryee337/aery-utils/procmgr";|' > /tmp/tmp.ts
mv /tmp/tmp.ts packages/coding-agent/src/exec/bash-executor.ts
