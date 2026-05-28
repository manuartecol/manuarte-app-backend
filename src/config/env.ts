import dotenv from 'dotenv';

dotenv.config();

const env = process.env.NODE_ENV || 'development';
dotenv.config({ path: `.env.${env}` });

export const ENV = {
	PORT: process.env.PORT,
	DB_NAME: process.env.DB_NAME ?? '',
	DB_USER: process.env.DB_USER ?? '',
	DB_PASSWORD: process.env.DB_PASSWORD ?? '',
	DB_HOST: process.env.DB_HOST ?? '',
	DB_PORT: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 5432,
	ACCESS_TOKEN_SECRET: process.env.ACCESS_TOKEN_SECRET ?? '',
	REFRESH_TOKEN_SECRET: process.env.REFRESH_TOKEN_SECRET ?? '',
	CLIENT_URL: process.env.CLIENT_URL ?? '',
	WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID ?? '',
	WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN ?? '',
	WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN ?? '',
	WHATSAPP_AGENT_PHONE_NUMBER_ID:
		process.env.WHATSAPP_AGENT_PHONE_NUMBER_ID ?? '',
	OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
	WHATSAPP_BOT_USER_ID: process.env.WHATSAPP_BOT_USER_ID ?? '',
	REDIS_HOST: process.env.REDIS_HOST ?? '127.0.0.1',
	REDIS_PORT: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379,
	REDIS_PASSWORD: process.env.REDIS_PASSWORD,
	SHOP_CO_PHONE_NUMBER: process.env.SHOP_CO_PHONE_NUMBER ?? '',
	SHOP_EC_PHONE_NUMBER: process.env.SHOP_EC_PHONE_NUMBER ?? '',
	BOLD_PAYMENT_BASE_URL: process.env.BOLD_PAYMENT_BASE_URL ?? '',
	PAYPHONE_PAYMENT_BASE_URL: process.env.PAYPHONE_PAYMENT_BASE_URL ?? '',
	PAYPHONE_TOKEN: process.env.PAYPHONE_TOKEN ?? '',
	PAYPHONE_STORE_ID: process.env.PAYPHONE_STORE_ID ?? '',
	BOLD_API_KEY: process.env.BOLD_API_KEY ?? '',
	// TEST_PAYPHONE_IN_CO: Cuando está en 'true', fuerza el uso de PayPhone
	// aunque el país sea Colombia. Útil para probar desde Colombia.
	// ⚠️ Dejar en '' o eliminar en producción.
	TEST_PAYPHONE_IN_CO: process.env.TEST_PAYPHONE_IN_CO ?? '',
	// TEST_FORCE_COUNTRY_ISO: Si está definida ('EC' o 'CO'), fuerza ese país
	// para TODOS los mensajes entrantes, ignorando el prefijo del número.
	// Útil para probar el bot de Ecuador desde un número colombiano.
	// ⚠️ Dejar en '' o eliminar en producción.
	TEST_FORCE_COUNTRY_ISO: process.env.TEST_FORCE_COUNTRY_ISO ?? '',
	// Información de pago por QR (placeholder hasta tener imagen real)
	PAYMENT_QR_CO_INFO:
		process.env.PAYMENT_QR_CO_INFO ??
		'[QR de transferencia Colombia - pendiente de configurar]',
	PAYMENT_QR_EC_INFO:
		process.env.PAYMENT_QR_EC_INFO ??
		'[QR de transferencia Ecuador - pendiente de configurar]',
	// Datos de cuenta Nequi para Colombia
	NEQUI_PHONE_NUMBER: process.env.NEQUI_PHONE_NUMBER ?? '',
	NEQUI_ACCOUNT_HOLDER: process.env.NEQUI_ACCOUNT_NAME ?? 'Manuarte',
};
