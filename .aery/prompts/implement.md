---
name: implement
description: Implement a feature or fix in Aery. Runs scout → worker → reviewer chain.
---

Use a chain of agents to implement the following task in the Aery codebase:

Task: {task}

Chain:
1. agent: aery-core
   task: Scout the relevant code for: {task}. Find the files, types, and functions involved. Return a structured summary of what you found.

2. agent: aery-core
   task: Implement the following based on the scout findings: {task}

   Scout findings: {previous}

   After implementing, run `npm run check` and fix all errors.

3. agent: aery-review
   task: Review the implementation of: {task}

   Changes made: {previous}

   Check for rule violations and report blocking issues only.
