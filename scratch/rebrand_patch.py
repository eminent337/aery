import os
import re
import sys

def rebrand(fpath):
    with open(fpath, "r") as f:
        text = f.read()

    text = re.sub(r'oh-my-pi', 'aery', text)
    text = re.sub(r'pi-coding-agent', 'aery-coding-agent', text)
    text = re.sub(r'kimchi', 'aery', text)
    text = re.sub(r'pi-', 'aery-', text)
    text = re.sub(r'-pi', '-aery', text)
    text = re.sub(r'/pi/', '/aery/', text)
    text = re.sub(r'piConfig', 'aeryConfig', text)
    text = re.sub(r'pi_session', 'aery_session', text)
    # Be careful with other pi occurrences like "api" -> "aaery" if not bounded.
    # The above regexes look safe since they include hyphens or slashes.

    with open(fpath, "w") as f:
        f.write(text)

for patch in ["scratch/9d99ae1af.patch", "scratch/fcb8663de.patch", "scratch/1654c759c.patch", "scratch/a64ff00cb.patch"]:
    rebrand(patch)
