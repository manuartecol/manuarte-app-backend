import { redis } from '../../config/redis';
import { SESSION_TTL_SECONDS } from './constants';
import { UserSession } from './types';
import { normalizePhone } from './helpers/phone-access';

/**
 * La sesión se segmenta por línea: el mismo cliente escribiendo a la línea de
 * Colombia y a la de Ecuador son dos conversaciones distintas, con carrito,
 * flujo y contexto operativo independientes. Sin el `phoneNumberId` en la
 * clave, el estado de una operación se filtraría a la otra.
 */
export const sessionKey = (
	phoneNumberId: string,
	customerPhone: string,
): string => `session:${phoneNumberId}:${normalizePhone(customerPhone)}`;

export const getSession = async (
	phoneNumberId: string,
	customerPhone: string,
): Promise<UserSession> => {
	const raw = await redis.get(sessionKey(phoneNumberId, customerPhone));
	return raw ? (JSON.parse(raw) as UserSession) : {};
};

export const saveSession = async (
	phoneNumberId: string,
	customerPhone: string,
	session: UserSession,
): Promise<void> => {
	await redis.set(
		sessionKey(phoneNumberId, customerPhone),
		JSON.stringify(session),
		'EX',
		SESSION_TTL_SECONDS,
	);
};
