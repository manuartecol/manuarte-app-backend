import { ENV } from './config/env';
import { connectToDatabase, startDBReconnectLoop } from './config/database';
import { connectToRedis } from './config/redis';
import app from './app';

const PORT = ENV.PORT;

// El proceso no tenía ningún manejador a nivel de proceso, así que morir no
// dejaba rastro: ts-node-dev termina con código 0 —y sin imprimir nada— cuando
// su hijo termina limpiamente, de modo que la terminal devuelve el prompt igual
// que con un Ctrl+C. Estos manejadores hacen que toda salida diga por qué.
let exitExplained = false;

const fatal = (message: string, detail: unknown): never => {
	exitExplained = true;
	console.error(`🚨 ${message}`, detail);
	process.exit(1);
};

const registerProcessDiagnostics = () => {
	process.on('uncaughtException', error =>
		fatal('Uncaught exception, shutting down:', error),
	);

	process.on('unhandledRejection', reason =>
		fatal('Unhandled promise rejection, shutting down:', reason),
	);

	// Nadie mantiene vivo el event loop: el servidor HTTP ya no escucha.
	process.on('beforeExit', () => {
		exitExplained = true;
		console.warn(
			'⚠️ Event loop drained: nothing is keeping the process alive, so it is about to exit. The HTTP server is no longer listening.',
		);
	});

	for (const signal of ['SIGINT', 'SIGTERM'] as const) {
		process.on(signal, () => {
			exitExplained = true;
			console.log(`👋 Received ${signal}, shutting down.`);
			process.exit(0);
		});
	}

	// Última red: si nada de lo anterior explicó la salida, al menos se ve.
	process.on('exit', code => {
		if (!exitExplained) {
			console.warn(`⚠️ Process exiting with code ${code} for no known reason.`);
		}
	});
};

async function main() {
	registerProcessDiagnostics();

	try {
		await connectToDatabase();
		startDBReconnectLoop();
		await connectToRedis();

		const server = app.listen(PORT, () => {
			console.log(`✅ Server listening on port ${PORT}`);
		});

		// app.listen emite 'error' de forma asíncrona (EADDRINUSE, EACCES), ya
		// fuera de este try/catch.
		server.on('error', error =>
			fatal(`HTTP server error on port ${PORT}:`, error),
		);
	} catch (error) {
		fatal('Fatal error in server startup:', error);
	}
}

main();
