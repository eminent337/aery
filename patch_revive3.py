import re

with open("packages/coding-agent/src/task/executor.ts", "r") as f:
    text = f.read()

bad_try = """		};

		try {"""

good_try = """		};

		let reviveSession: (() => Promise<AgentSession>) | null = null;
		try {"""

text = text.replace(bad_try, good_try)

bad_decl = """			let reviveSession: (() => Promise<AgentSession>) | null = null;
			if (sessionFile !== null && worktree === undefined) {"""

good_decl = """			if (sessionFile !== null && worktree === undefined) {"""

text = text.replace(bad_decl, good_decl)

with open("packages/coding-agent/src/task/executor.ts", "w") as f:
    f.write(text)

print("done")
