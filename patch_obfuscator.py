import re

with open("packages/coding-agent/src/secrets/obfuscator.ts", "r") as f:
    text = f.read()

# Add obfuscateObject below deobfuscateObject
obf_obj = """	deobfuscateObject<T>(obj: T): T {
		if (this.#secretCount === 0) return obj;
		return deepWalkStrings(obj, s => this.deobfuscate(s));
	}"""

new_obf_obj = """	obfuscateObject<T>(obj: T): T {
		if (this.#secretCount === 0) return obj;
		return deepWalkStrings(obj, s => this.deobfuscate(s)); // Wait, it should use this.obfuscate(s)
	}

	deobfuscateObject<T>(obj: T): T {
		if (this.#secretCount === 0) return obj;
		return deepWalkStrings(obj, s => this.deobfuscate(s));
	}"""

# Correct the logic
new_obf_obj = new_obf_obj.replace("this.deobfuscate(s)); // Wait, it should use this.obfuscate(s)", "this.obfuscate(s));")

text = text.replace(obf_obj, new_obf_obj)

with open("packages/coding-agent/src/secrets/obfuscator.ts", "w") as f:
    f.write(text)

print("done")
