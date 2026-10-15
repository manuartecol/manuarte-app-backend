import dotenv from 'dotenv';

dotenv.config();

const env = process.env.NODE_ENV || 'development';
dotenv.config({ path: `.env.${env}` });

/**
 * Un valor ausente, no numérico o <= 0 cae al valor por defecto. Sin esta
 * validación, un `WHATSAPP_AI_PAUSE_TTL_SECONDS` mal escrito produciría NaN y
 * `redis.set(..., 'EX', NaN)` fallaría: la IA no se pausaría nunca tras una
 * intervención humana, que es el peor fallo posible de este módulo.
 */
const toInt = (value: string | undefined, fallback: number): number => {
	const parsed = parseInt(value ?? '', 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		if (value) {
			console.warn(
				`[ENV] Invalid numeric value "${value}", falling back to ${fallback}.`,
			);
		}
		return fallback;
	}
	return parsed;
};

/**
 * Único punto de lectura de `process.env`. Los valores por defecto viven aquí
 * y en ningún otro sitio, de modo que el resto del código nunca tenga que
 * preguntarse qué pasa si una variable falta.
 *
 * El orden de las secciones es el mismo que el de `.env.example`.
 */
export const ENV = {
	// ── Servidor ─────────────────────────────────────────────────────────────
	PORT: toInt(process.env.PORT, 5000),
	/** Origen permitido por CORS. Antes se llamaba CLIENT_URL. */
	FRONTEND_URL: process.env.FRONTEND_URL ?? '',

	// ── PostgreSQL ───────────────────────────────────────────────────────────
	DB_NAME: process.env.DB_NAME ?? '',
	DB_USER: process.env.DB_USER ?? '',
	DB_PASSWORD: process.env.DB_PASSWORD ?? '',
	DB_HOST: process.env.DB_HOST ?? '',
	DB_PORT: toInt(process.env.DB_PORT, 5432),

	// ── Redis ────────────────────────────────────────────────────────────────
	REDIS_HOST: process.env.REDIS_HOST || '127.0.0.1',
	REDIS_PORT: toInt(process.env.REDIS_PORT, 6379),
	REDIS_PASSWORD: process.env.REDIS_PASSWORD || undefined,

	// ── Autenticación ────────────────────────────────────────────────────────
	ACCESS_TOKEN_SECRET: process.env.ACCESS_TOKEN_SECRET ?? '',
	REFRESH_TOKEN_SECRET: process.env.REFRESH_TOKEN_SECRET ?? '',

	// ── OpenAI ───────────────────────────────────────────────────────────────
	OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',

	// ── WhatsApp Cloud API: credenciales comunes a todos los números ─────────
	WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN ?? '',
	WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN ?? '',

	// ── Envío de documentos PDF desde el panel ───────────────────────────────
	// Número dedicado a cotizaciones y facturas, por plantilla. No es una línea
	// del agente y no interviene en la lógica de Coexistence.
	WHATSAPP_DOCS_PHONE_NUMBER_ID:
		process.env.WHATSAPP_DOCS_PHONE_NUMBER_ID ?? '',

	// ── Agente Gema: líneas ──────────────────────────────────────────────────
	// Cada línea es una operación independiente. El phone_number_id que llega
	// en el webhook determina el país y la tienda: no se usa el prefijo
	// telefónico del cliente. Una línea sin phoneNumberId no se registra.
	WHATSAPP_LINE_CO_PHONE_NUMBER_ID:
		process.env.WHATSAPP_LINE_CO_PHONE_NUMBER_ID ?? '',
	WHATSAPP_LINE_CO_BUSINESS_PHONE:
		process.env.WHATSAPP_LINE_CO_BUSINESS_PHONE ?? '',
	WHATSAPP_LINE_CO_SHOP_SLUG:
		process.env.WHATSAPP_LINE_CO_SHOP_SLUG || 'manuarte-barranquilla',
	WHATSAPP_LINE_CO_AI_ALLOWLIST: process.env.WHATSAPP_LINE_CO_AI_ALLOWLIST ?? '',
	WHATSAPP_LINE_CO_AI_ALLOWLIST_ENABLED:
		process.env.WHATSAPP_LINE_CO_AI_ALLOWLIST_ENABLED || 'true',
	WHATSAPP_LINE_EC_PHONE_NUMBER_ID:
		process.env.WHATSAPP_LINE_EC_PHONE_NUMBER_ID ?? '',
	WHATSAPP_LINE_EC_BUSINESS_PHONE:
		process.env.WHATSAPP_LINE_EC_BUSINESS_PHONE ?? '',
	WHATSAPP_LINE_EC_SHOP_SLUG:
		process.env.WHATSAPP_LINE_EC_SHOP_SLUG || 'manuarte-quito',
	WHATSAPP_LINE_EC_AI_ALLOWLIST: process.env.WHATSAPP_LINE_EC_AI_ALLOWLIST ?? '',
	WHATSAPP_LINE_EC_AI_ALLOWLIST_ENABLED:
		process.env.WHATSAPP_LINE_EC_AI_ALLOWLIST_ENABLED || 'true',

	// ── Agente Gema: comportamiento ──────────────────────────────────────────
	// Duración de la pausa de IA tras una intervención humana. Se renueva con
	// cada mensaje del personal; al expirar, la IA vuelve a atender.
	WHATSAPP_AI_PAUSE_TTL_SECONDS: toInt(
		process.env.WHATSAPP_AI_PAUSE_TTL_SECONDS,
		60 * 60 * 24,
	),
	/**
	 * Usuario de ESTA aplicación con el que el agente firma lo que crea
	 * (`requestedBy` de cotizaciones y facturas). No es un identificador de
	 * WhatsApp: es un UUID de la tabla de usuarios.
	 */
	AGENT_SYSTEM_USER_ID: process.env.AGENT_SYSTEM_USER_ID ?? '',

	// ── Notificaciones a la tienda ───────────────────────────────────────────
	// Número que recibe copia de las cotizaciones y facturas en PDF. También
	// forma parte de la denylist del agente: la IA nunca le responde.
	SHOP_NOTIFY_CO_PHONE: process.env.SHOP_NOTIFY_CO_PHONE ?? '',
	SHOP_NOTIFY_EC_PHONE: process.env.SHOP_NOTIFY_EC_PHONE ?? '',

	// ── Pagos ────────────────────────────────────────────────────────────────
	BOLD_API_KEY: process.env.BOLD_API_KEY ?? '',
	PAYPHONE_TOKEN: process.env.PAYPHONE_TOKEN ?? '',
	PAYPHONE_STORE_ID: process.env.PAYPHONE_STORE_ID ?? '',
	NEQUI_PHONE_NUMBER: process.env.NEQUI_PHONE_NUMBER ?? '',
	NEQUI_ACCOUNT_HOLDER: process.env.NEQUI_ACCOUNT_HOLDER || 'Manuarte',
	/**
	 * Datos de pago de Ecuador. Provisional: hoy es texto de transferencia y
	 * pasará a ser un QR, como el de Colombia (`PAYMENT_QR_CO_IMAGE` en
	 * flows.service.ts, servido desde src/assets).
	 */
	PAYMENT_QR_EC_INFO:
		process.env.PAYMENT_QR_EC_INFO ||
		'[QR de transferencia Ecuador - pendiente de configurar]',

	// ── Overrides de prueba ──────────────────────────────────────────────────
	// Con 'true' fuerza PayPhone aunque el país sea Colombia. Dejar vacío en
	// producción.
	TEST_PAYPHONE_IN_CO: process.env.TEST_PAYPHONE_IN_CO ?? '',
};
