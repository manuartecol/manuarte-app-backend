import { redis } from '../../../config/redis';
import { ENV } from '../../../config/env';
import { normalizePhone } from '../helpers/phone-access';

/** Ventana de deduplicación de wamid. Cubre de sobra los reintentos de Meta. */
const SEEN_TTL_SECONDS = 15 * 60;

/**
 * Cuánto recordamos los wamid que el propio agente envió, para reconocer su
 * eco si Meta llegara a emitirlo. Los echoes llegan en segundos; una hora es
 * margen amplio.
 */
const SELF_SEND_TTL_SECONDS = 60 * 60;

/**
 * Por qué está pausada la conversación. `human_reply` es un mensaje del
 * personal; `customer_request` es el cliente pidiendo hablar con una persona,
 * donde todavía no ha escrito nadie del equipo. Sin esta distinción el registro
 * afirmaría que hubo un mensaje humano que nunca existió.
 */
export type PauseReason = 'human_reply' | 'customer_request';

export interface PauseRecord {
	/** Momento en que empezó esta pausa. */
	pausedAt: number;
	/** Última señal que reinició el TTL (mensaje del personal o petición). */
	lastHumanAt: number;
	reason: PauseReason;
}

/**
 * Estado de convivencia IA / atención humana, en Redis y segmentado por línea.
 *
 * La pausa vive en su propia clave, no en la sesión: la sesión se reescribe
 * entera en cada turno (pisaría escrituras externas) y su TTL de 2 h solo se
 * renueva cuando hay procesamiento, que es justo lo que no ocurre en pausa.
 *
 * No existe `resume()` a propósito: la reactivación es la expiración del TTL.
 */
export class AiStateService {
	private pauseKey = (phoneNumberId: string, customerPhone: string): string =>
		`wa:ai-pause:${phoneNumberId}:${normalizePhone(customerPhone)}`;

	/**
	 * Marca un wamid como visto. Devuelve false si ya se había procesado, para
	 * que el llamador lo descarte. Un reintento de Meta no debe producir una
	 * segunda respuesta.
	 */
	markSeen = async (messageId: string | null | undefined): Promise<boolean> => {
		// Sin id no podemos deduplicar: es más seguro procesar que descartar.
		if (!messageId) return true;

		const result = await redis.set(
			`wa:seen:${messageId}`,
			'1',
			'EX',
			SEEN_TTL_SECONDS,
			'NX',
		);
		return result === 'OK';
	};

	/**
	 * Devuelve un wamid al estado "no visto". Se usa cuando el manejo falla
	 * después de haberlo marcado: Meta reintentará el webhook y, sin esto, el
	 * reintento se descartaría por duplicado y el evento se perdería para
	 * siempre. En el caso de un echo eso significaría que la IA no se pausa
	 * pese a que una persona intervino.
	 */
	releaseSeen = async (messageId: string | null | undefined): Promise<void> => {
		if (!messageId) return;
		await redis.del(`wa:seen:${messageId}`);
	};

	/**
	 * Registra un mensaje enviado por el agente. Meta no marca los echoes con
	 * ningún flag de origen, así que este registro es la única forma fiable de
	 * que el agente no interprete su propio mensaje como intervención humana.
	 */
	registerSelfSend = async (
		messageId: string | null | undefined,
	): Promise<void> => {
		if (!messageId) return;
		await redis.set(`wa:self-send:${messageId}`, '1', 'EX', SELF_SEND_TTL_SECONDS);
	};

	isSelfSend = async (messageId: string | null | undefined): Promise<boolean> => {
		if (!messageId) return false;
		return (await redis.exists(`wa:self-send:${messageId}`)) === 1;
	};

	/** Crea o renueva la pausa. Cada señal nueva reinicia el TTL. */
	pause = async (
		phoneNumberId: string,
		customerPhone: string,
		reason: PauseReason = 'human_reply',
	): Promise<void> => {
		const key = this.pauseKey(phoneNumberId, customerPhone);
		const now = Date.now();
		const existing = await redis.get(key);
		const pausedAt = existing
			? ((JSON.parse(existing) as PauseRecord).pausedAt ?? now)
			: now;

		const record: PauseRecord = { pausedAt, lastHumanAt: now, reason };
		await redis.set(
			key,
			JSON.stringify(record),
			'EX',
			ENV.WHATSAPP_AI_PAUSE_TTL_SECONDS,
		);
	};

	/**
	 * Levanta la pausa. La reactivación normal es la expiración del TTL: esto
	 * existe solo para el comando de prueba, que permite al equipo devolver la
	 * conversación a la IA sin esperar.
	 */
	clearPause = async (
		phoneNumberId: string,
		customerPhone: string,
	): Promise<boolean> =>
		(await redis.del(this.pauseKey(phoneNumberId, customerPhone))) === 1;

	isPaused = async (
		phoneNumberId: string,
		customerPhone: string,
	): Promise<boolean> =>
		(await redis.exists(this.pauseKey(phoneNumberId, customerPhone))) === 1;
}
