export function isCmuxAvailable(): boolean {
	// Detect cmux capabilities automatically for multi-stream protocols
	return !!(process.env.CMUX_SOCKET || process.env.CMUX_VERSION || process.env.TERM_PROGRAM === "cmux");
}
