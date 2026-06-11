import re

with open("packages/coding-agent/src/tools/bash.ts", "r") as f:
    text = f.read()

text = text.replace('this.async #buildCompletedResult(', 'await this.#buildCompletedResult(')
# The definition line is `	async async #buildCompletedResult(` ?
text = text.replace('async async #buildCompletedResult(', 'async #buildCompletedResult(')

with open("packages/coding-agent/src/tools/bash.ts", "w") as f:
    f.write(text)
