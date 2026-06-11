import re

with open("packages/coding-agent/src/tools/irc.ts", "r") as f:
    text = f.read()

# remove formatErrorDetail import
text = re.sub(r"formatErrorDetail,\s*", "", text)

# replace formatErrorDetail usage
text = re.sub(r"formatErrorDetail\((.*?)\)", r"String(\1)", text)

# fix SymbolKey
text = text.replace('theme.styledSymbol("tool.irc", "accent")', 'theme.styledSymbol("tool.task", "accent")')

# remove iconOverride
text = re.sub(r"iconOverride:\s*ircGlyph\(theme\),\s*", "", text)

with open("packages/coding-agent/src/tools/irc.ts", "w") as f:
    f.write(text)

print("done")
