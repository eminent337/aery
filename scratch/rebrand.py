import os
import re

files = ["scratch/audit.ts", "scratch/audit.test.ts", "scratch/audit-prompt.md"]
for fpath in files:
    with open(fpath, "r") as f:
        text = f.read()

    # Replacements
    text = re.sub(r'oh-my-pi', 'aery', text)
    text = re.sub(r'pi-ai', 'aery-ai', text)
    text = re.sub(r'pi-catalog', 'aery-catalog', text) # Wait, prompt said catalog was merged into ai
    text = re.sub(r'pi-utils', 'aery-utils', text)
    text = re.sub(r'@aryee337/aery-catalog', '@aryee337/aery-ai', text)

    with open(fpath, "w") as f:
        f.write(text)
