import { ENV } from '../../config/env';
import { normalizePhone, parsePhoneList } from './helpers/phone-access';

export type LineIsoCode = 'CO' | 'EC';

/**
 * Una línea de WhatsApp = una operación. El `phoneNumberId` que Meta envía en
 * `value.metadata.phone_number_id` es lo que determina a qué país/tienda
 * pertenece el mensaje: NUNCA el prefijo telefónico del cliente, porque un
 * cliente puede escribir a cualquiera de las líneas.
 */
export interface WhatsAppLine {
	isoCode: LineIsoCode;
	/** Identificador de la línea en Meta. Clave de resolución y de aislamiento. */
	phoneNumberId: string;
	/** Número del negocio, normalizado a dígitos. Usado en la denylist. */
	businessPhone: string;
	/** Slug de la tienda en BD desde la que se resuelven stock, precios y moneda. */
	shopSlug: string;
	/** Modo de pruebas: si está activo, solo responde a los números de `allowlist`. */
	allowlistEnabled: boolean;
	allowlist: string[];
	/**
	 * Números internos a los que la IA nunca responde, sea cual sea el modo:
	 * el de cualquier línea registrada y los de tienda que reciben las copias
	 * en PDF. Se calcula una vez conocidas todas las líneas, porque una línea
	 * escribiendo a otra no es un cliente.
	 */
	denylist: string[];
}

const buildLine = (
	isoCode: LineIsoCode,
	phoneNumberId: string,
	businessPhone: string,
	shopSlug: string,
	allowlistEnabled: string,
	allowlist: string,
): Omit<WhatsAppLine, 'denylist'> => ({
	isoCode,
	phoneNumberId: phoneNumberId.trim(),
	businessPhone: normalizePhone(businessPhone),
	shopSlug: shopSlug.trim(),
	// Por defecto activa: una lista vacía o mal configurada debe silenciar la IA,
	// no soltarla sobre todos los clientes.
	allowlistEnabled: allowlistEnabled !== 'false',
	allowlist: parsePhoneList(allowlist),
});

const CONFIGURED_LINES: Omit<WhatsAppLine, 'denylist'>[] = [
	buildLine(
		'CO',
		ENV.WHATSAPP_LINE_CO_PHONE_NUMBER_ID,
		ENV.WHATSAPP_LINE_CO_BUSINESS_PHONE,
		ENV.WHATSAPP_LINE_CO_SHOP_SLUG,
		ENV.WHATSAPP_LINE_CO_AI_ALLOWLIST_ENABLED,
		ENV.WHATSAPP_LINE_CO_AI_ALLOWLIST,
	),
	buildLine(
		'EC',
		ENV.WHATSAPP_LINE_EC_PHONE_NUMBER_ID,
		ENV.WHATSAPP_LINE_EC_BUSINESS_PHONE,
		ENV.WHATSAPP_LINE_EC_SHOP_SLUG,
		ENV.WHATSAPP_LINE_EC_AI_ALLOWLIST_ENABLED,
		ENV.WHATSAPP_LINE_EC_AI_ALLOWLIST,
	),
];

/**
 * Solo las líneas con `phoneNumberId` y `shopSlug` configurados quedan
 * registradas. Una línea sin configurar simplemente no existe: Ecuador queda
 * inerte hasta que se le asigne su número, sin ramas condicionales.
 */
const registered: Omit<WhatsAppLine, 'denylist'>[] = [];

for (const line of CONFIGURED_LINES) {
	if (line.phoneNumberId.length === 0 || line.shopSlug.length === 0) continue;

	// Dos líneas con el mismo phone_number_id es siempre un error de
	// configuración: el Map se quedaría con la última y toda una operación
	// atendería con el catálogo, el stock y la moneda del otro país.
	const clash = registered.find(
		other => other.phoneNumberId === line.phoneNumberId,
	);
	if (clash) {
		throw new Error(
			`[WhatsApp Agent] Lines ${clash.isoCode} and ${line.isoCode} share phone_number_id ` +
				`${line.phoneNumberId}. Each line needs its own number.`,
		);
	}

	registered.push(line);
}

// Los números internos son los mismos para todas las líneas: el de cualquier
// línea registrada (una línea escribiendo a otra no es un cliente) y los de
// tienda que reciben las copias en PDF.
const INTERNAL_PHONES = [
	...new Set(
		[
			...registered.map(line => line.businessPhone),
			normalizePhone(ENV.SHOP_NOTIFY_CO_PHONE),
			normalizePhone(ENV.SHOP_NOTIFY_EC_PHONE),
		].filter(phone => phone.length > 0),
	),
];

const LINES_BY_PHONE_NUMBER_ID = new Map<string, WhatsAppLine>(
	registered.map(line => [
		line.phoneNumberId,
		{ ...line, denylist: INTERNAL_PHONES },
	]),
);

export const getLineByPhoneNumberId = (
	phoneNumberId: string | null | undefined,
): WhatsAppLine | null =>
	phoneNumberId ? LINES_BY_PHONE_NUMBER_ID.get(phoneNumberId) ?? null : null;

export const getRegisteredLines = (): WhatsAppLine[] => [
	...LINES_BY_PHONE_NUMBER_ID.values(),
];

/**
 * Traza la configuración resuelta al arrancar. Un `shopSlug` equivocado
 * desviaría toda una línea a la tienda incorrecta en silencio, así que conviene
 * que quede visible en el log de arranque.
 */
export const logRegisteredLines = () => {
	if (LINES_BY_PHONE_NUMBER_ID.size === 0) {
		console.warn(
			'[WhatsApp Agent] No WhatsApp lines configured: the agent will ignore every webhook.',
		);
		return;
	}

	for (const line of LINES_BY_PHONE_NUMBER_ID.values()) {
		console.log(
			`[WhatsApp Agent] Line ${line.isoCode} registered: phoneNumberId=${line.phoneNumberId}, ` +
				`businessPhone=${line.businessPhone}, shop=${line.shopSlug}, ` +
				`allowlist=${line.allowlistEnabled ? `${line.allowlist.length} number(s)` : 'disabled'}, ` +
				`denylist=${line.denylist.join(', ')}`,
		);
	}
};
