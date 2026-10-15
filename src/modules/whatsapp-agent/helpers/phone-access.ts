import { ENV } from '../../../config/env';
import { WhatsAppLine } from '../lines';

/**
 * Normaliza un número a dígitos (E.164 sin '+'), tal como WhatsApp lo entrega
 * en `messages[].from` y en `message_echoes[].to`. Tolera '+', espacios,
 * guiones y paréntesis para que las variables de entorno puedan escribirse
 * en el formato que resulte más cómodo.
 */
export function normalizePhone(raw: string | null | undefined): string {
	return (raw ?? '').replace(/\D/g, '');
}

/** Parsea una lista de números separados por comas, normalizando y deduplicando. */
export function parsePhoneList(raw: string | null | undefined): string[] {
	const normalized = (raw ?? '')
		.split(',')
		.map(normalizePhone)
		.filter(phone => phone.length > 0);

	return [...new Set(normalized)];
}

export type AiAccessDecision =
	| { allowed: true }
	| { allowed: false; reason: 'denylist' | 'allowlist' };

/**
 * Decide si la IA puede responder a un número en una línea concreta.
 *
 * La denylist es permanente e independiente del modo de pruebas: incluye el
 * propio número del negocio y los números de tienda, que reciben copia de las
 * cotizaciones y facturas en PDF. Sin ella, la réplica de un vendedor se
 * trataría como la de un cliente cualquiera.
 */
export function isAiAllowed(
	line: WhatsAppLine,
	customerPhone: string,
): AiAccessDecision {
	const phone = normalizePhone(customerPhone);

	const denylist = [
		line.businessPhone,
		normalizePhone(ENV.SHOP_NOTIFY_CO_PHONE),
		normalizePhone(ENV.SHOP_NOTIFY_EC_PHONE),
	].filter(entry => entry.length > 0);

	if (denylist.includes(phone)) {
		return { allowed: false, reason: 'denylist' };
	}

	if (!line.allowlistEnabled) {
		return { allowed: true };
	}

	return line.allowlist.includes(phone)
		? { allowed: true }
		: { allowed: false, reason: 'allowlist' };
}
