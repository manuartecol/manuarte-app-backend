import path from 'path';
import { Worker } from 'worker_threads';
import { DocData } from './components/PDFDoc';
import { QuoteService } from '../quote/service';
import { BillingService } from '../billing/service';

/**
 * Un PDF tarda unos 1,4 s contando el arranque del hilo, y el más grande medido
 * (171 productos) 1,9 s. Pasado este tiempo se da por colgado. No conviene
 * subirlo: es lo que espera el vendedor frente al spinner, o el cliente de Gema
 * su respuesta, antes de enterarse de que falló.
 */
const RENDER_TIMEOUT_MS = 10_000;

/**
 * Techo del heap de JavaScript del hilo. El render más pesado medido sube unos
 * 280 MB. Solo cuenta el heap, no los buffers de fuentes e imágenes, así que la
 * protección de verdad contra un bucle es el tiempo máximo; esto corta antes el
 * caso de un bucle que asigna objetos sin parar (el incidente llegó a 2,3 GB).
 */
const RENDER_MAX_MEMORY_MB = 1024;

/**
 * Renders a la vez. Cada hilo puede llegar al techo de memoria de arriba, y sin
 * tope varios PDF colgados, o el panel y Gema generando al mismo tiempo, podían
 * volver a llenar el contenedor. Los que pasan de aquí esperan turno, y esa
 * espera no cuenta para el tiempo máximo del render.
 */
const MAX_CONCURRENT_RENDERS = 2;

/**
 * Lo que ve el vendedor. Sin "intenta de nuevo": si una plantilla se cuelga con
 * un documento, se cuelga siempre con ese documento, y cada reintento solo
 * vuelve a ocupar un hilo durante todo el tiempo máximo.
 */
const RENDER_ERROR_MESSAGE =
	'No se pudo generar el documento. Avisa a soporte para que lo revise';

/**
 * Cupos libres y cola de espera. Van a nivel de módulo y no en la instancia
 * porque hay más de un `DocsService` (el de las rutas del panel y el de Gema),
 * y el tope tiene que ser uno para todo el proceso.
 */
let activeRenders = 0;
const waitingRenders: Array<() => void> = [];

const acquireRenderSlot = (): Promise<void> => {
	if (activeRenders < MAX_CONCURRENT_RENDERS) {
		activeRenders++;
		return Promise.resolve();
	}
	return new Promise(resolve => waitingRenders.push(resolve));
};

// El cupo pasa directamente al siguiente en la cola, sin liberarse en medio
const releaseRenderSlot = () => {
	const next = waitingRenders.shift();
	if (next) next();
	else activeRenders--;
};

/**
 * En desarrollo este archivo es `.ts` y el hilo no hereda el cargador de
 * TypeScript de `ts-node-dev`, así que se lo pasa explícitamente. Compilado
 * (`dist/`) es `.js` y no necesita nada.
 */
const WORKER_FILE = path.join(__dirname, `pdf.worker${path.extname(__filename)}`);
const WORKER_EXEC_ARGV = WORKER_FILE.endsWith('.ts')
	? ['--require', 'ts-node/register/transpile-only']
	: [];

export class DocsService {
	constructor(
		private quoteService: QuoteService,
		private billingService: BillingService,
	) {}

	generateQuote = async (serialNumber: string): Promise<Buffer> => {
		const result = await this.quoteService.getOne(serialNumber);

		if (result.status !== 200) {
			throw new Error(`No se pudo obtener la cotización ${serialNumber}`);
		}

		return this.render(true, result.quote as DocData, serialNumber);
	};

	generateBilling = async (serialNumber: string): Promise<Buffer> => {
		const result = await this.billingService.getOne(serialNumber);

		if (result.status !== 200) {
			throw new Error(`No se pudo obtener la factura ${serialNumber}`);
		}

		return this.render(false, result.billing as DocData, serialNumber);
	};

	/**
	 * Espera un cupo y genera el PDF. El cupo se devuelve pase lo que pase,
	 * incluso si el hilo ni siquiera llega a arrancar.
	 */
	private render = async (
		isQuote: boolean,
		data: DocData,
		serialNumber: string,
	): Promise<Buffer> => {
		await acquireRenderSlot();
		try {
			return await this.renderInWorker(isQuote, data, serialNumber);
		} finally {
			releaseRenderSlot();
		}
	};

	/**
	 * Genera el PDF en un hilo aparte (`pdf.worker.ts`). Si el render se cuelga
	 * o falla, falla solo esta petición en vez de dejar al servidor sin
	 * responder hasta un reinicio manual.
	 */
	private renderInWorker = (
		isQuote: boolean,
		data: DocData,
		serialNumber: string,
	): Promise<Buffer> => {
		return new Promise((resolve, reject) => {
			const worker = new Worker(WORKER_FILE, {
				// Ida y vuelta por JSON: `getOne` puede traer instancias de Sequelize,
				// que no se pueden clonar para pasarlas a otro hilo
				workerData: { isQuote, data: JSON.parse(JSON.stringify(data)) },
				execArgv: WORKER_EXEC_ARGV,
				resourceLimits: { maxOldGenerationSizeMb: RENDER_MAX_MEMORY_MB },
			});

			let settled = false;
			const finish = (error: Error | null, buffer?: Buffer) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				worker.terminate();
				if (error) reject(error);
				else resolve(buffer as Buffer);
			};

			const timer = setTimeout(() => {
				console.error(
					`[Docs] PDF render for ${serialNumber} timed out after ${RENDER_TIMEOUT_MS} ms`,
				);
				finish(new Error(RENDER_ERROR_MESSAGE));
			}, RENDER_TIMEOUT_MS);

			// Del hilo llega un Uint8Array, no un Buffer
			worker.once('message', (bytes: Uint8Array) =>
				finish(
					null,
					Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
				),
			);

			// Incluye el error de memoria agotada (`ERR_WORKER_OUT_OF_MEMORY`)
			worker.once('error', error => {
				console.error(`[Docs] PDF render for ${serialNumber} failed:`, error);
				finish(new Error(RENDER_ERROR_MESSAGE));
			});

			// Si el hilo termina sin haber mandado el PDF, se rechaza en el acto. Sin
			// esto la petición esperaba el tiempo máximo entero y el log decía
			// "timed out", que es un diagnóstico falso. Tras un éxito, `finish` ya
			// se ejecutó y esto no hace nada
			worker.once('exit', code => {
				if (settled) return;
				console.error(
					`[Docs] PDF render for ${serialNumber} exited with code ${code} without producing a PDF`,
				);
				finish(new Error(RENDER_ERROR_MESSAGE));
			});
		});
	};
}
