import { GrpcServer } from "./server";

export async function runGrpcServer(options: { host?: string; port?: number } = {}): Promise<void> {
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 50051;
	const server = new GrpcServer(host, port);
	await server.start();

	const shutdown = async () => {
		console.log("Shutting down gRPC Server...");
		await server.stop();
		process.exit(0);
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}
