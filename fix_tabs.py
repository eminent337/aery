import re

with open("packages/coding-agent/src/config/settings-schema.ts", "r") as f:
    text = f.read()

# Fix SETTING_TABS array
text = text.replace('\t"editing",\n', '\t"files",\n\t"shell",\n')

# Fix TAB_METADATA
text = text.replace('\tediting: { label: "Editing", icon: "tab.editing" },', '\tfiles: { label: "Files", icon: "tab.editing" },\n\tshell: { label: "Shell", icon: "tab.tools" },')

with open("packages/coding-agent/src/config/settings-schema.ts", "w") as f:
    f.write(text)

