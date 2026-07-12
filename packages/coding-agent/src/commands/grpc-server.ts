import { Command, Flags } from "@aryee337/aery-utils/cli";

export default class GrpcServerCommand extends Command {
	static description = "Start the headless gRPC server interface for Aery";

	static flags = {
		port: Flags.integer({ char: "p", description: "Port to run gRPC server on", default: 50051 }),
		host: Flags.string({ char: "h", description: "Host to bind gRPC server to", default: "127.0.0.1" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(GrpcServerCommand);
		const { runGrpcServer } = await import("@aryee337/aery-grpc-server");
		await runGrpcServer({
			host: flags.host,
			port: flags.port,
		});
	}
}
