f = "packages/coding-agent/src/eval/py/executor.ts"
content = open(f).read()
content = content.replace('''function normalizeExplicitInterpreter(cwd: string, interpreter: string | undefined): string {
	if (interpreter === undefined) return "";
	const resolved = resolvePythonRuntime(interpreter, cwd, {}).pythonPath;
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}''', '''function normalizeExplicitInterpreter(cwd: string, interpreter: string | undefined): string {
	if (interpreter === undefined) return "";
	try {
		return fs.realpathSync.native(interpreter);
	} catch {
		return interpreter;
	}
}''')
open(f, "w").write(content)
