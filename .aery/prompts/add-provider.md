---
name: add-provider
description: Add a new LLM provider to packages/ai following the 7-step checklist.
---

Use a chain to add a new LLM provider to Aery:

Provider: {task}

Chain:
1. agent: aery-ai
   task: Scout the existing provider implementations to understand the patterns. Look at packages/ai/src/providers/anthropic.ts and packages/ai/src/providers/openai-completions.ts as references. Return a summary of the patterns to follow for adding: {task}

2. agent: aery-ai
   task: Implement the new provider following the 7-step checklist.

   Provider to add: {task}
   Reference patterns: {previous}

   Complete all 7 steps: types.ts, provider file, exports/registration, generate-models.ts, tests, coding-agent updates, docs.
   Run `npm run check` after each step.

3. agent: aery-review
   task: Review the new provider implementation for: {task}

   Changes: {previous}

   Verify all 7 steps are complete. Check for missing test coverage.
