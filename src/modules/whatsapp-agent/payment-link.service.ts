import axios from 'axios';
import { ENV } from '../../config/env';

const PAYPHONE_API_URL = 'https://pay.payphonetodoesposible.com/api/Links';

/**
 * Servicio para generar links de pago.
 *
 * Colombia → Bold (link estático por ENV)
 * Ecuador  → PayPhone (link dinámico vía API)
 */
export class PaymentLinkService {
	/**
	 * Genera un link de pago Bold para Colombia usando la API de Bold.
	 * @param amount - Monto total en COP (ej: 10000)
	 * @param currency - Moneda, normalmente "COP"
	 * @param reference - Referencia única de la transacción
	 * @returns URL del link de pago generado por Bold
	 */
	async getBoldLink(
		amount: number,
		currency: string,
		reference: string,
	): Promise<string> {
		if (!amount || amount <= 0) {
			throw new Error(
				`[PaymentLinkService] Invalid amount for Bold: ${amount}`,
			);
		}

		const BOLD_API_URL = 'https://integrations.api.bold.co/online/link/v1';

		const body = {
			amount_type: 'CLOSE',
			amount: {
				currency: currency || 'COP',
				total_amount: Math.round(amount),
				tip_amount: 0,
			},
			reference:
				reference?.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) || undefined,
			description: 'Pago Manuarte',
		};

		interface BoldLinkResponse {
			payload?: {
				payment_link: string;
				url: string;
			};
			errors?: unknown[];
		}
		try {
			const response = await axios.post<BoldLinkResponse>(BOLD_API_URL, body, {
				headers: {
					Authorization: `x-api-key ${ENV.BOLD_API_KEY}`,
					'Content-Type': 'application/json',
				},
				timeout: 10_000,
			});
			const data = response.data;
			if (data?.payload?.url) return data.payload.url;
			throw new Error('[PaymentLinkService] Respuesta inesperada de Bold');
		} catch (error) {
			if (axios.isAxiosError(error) && error.response) {
				console.error(
					'[PaymentLinkService] Bold API error:',
					JSON.stringify(error.response.data, null, 2),
				);
			}
			throw error;
		}
	}

	/**
	 * Genera un link de pago PayPhone para Ecuador llamando a la API dinámica.
	 * @param amount - Monto total en USD (ej: 25.50)
	 * @param currency - Moneda, siempre "USD" para Ecuador
	 * @param clientTransactionId - ID único de la transacción (UUID)
	 * @returns URL del link de pago generado por PayPhone
	 */
	async getPayPhoneLink(
		amount: number,
		currency: string,
		clientTransactionId: string,
	): Promise<string> {
		if (!amount || amount <= 0) {
			throw new Error(
				`[PaymentLinkService] Invalid amount for PayPhone: ${amount}`,
			);
		}

		// Los montos en PayPhone van en centavos (enteros)
		const amountInCents = Math.round(amount * 100);

		const body = {
			amount: amountInCents,
			amountWithoutTax: amountInCents, // Sin impuesto incluido
			currency,
			reference: `Pedido Manuarte`,
			clientTransactionId,
			storeId: ENV.PAYPHONE_STORE_ID,
			oneTime: true,
			expireIn: 0,
			isAmountEditable: false,
		};

		try {
			const response = await axios.post<{ link: string } | string>(
				PAYPHONE_API_URL,
				body,
				{
					headers: {
						Authorization: `Bearer ${ENV.PAYPHONE_TOKEN}`,
						'Content-type': 'application/json',
					},
					timeout: 10_000,
				},
			);
			const data = response.data;
			if (typeof data === 'string') return data;
			return data.link;
		} catch (error) {
			if (axios.isAxiosError(error) && error.response) {
				console.error(
					'[PaymentLinkService] PayPhone API error:',
					JSON.stringify(error.response.data, null, 2),
				);
			}
			throw error;
		}
	}

	/**
	 * Selecciona el proveedor de pago según el país y devuelve el link.
	 *
	 * TEST: Si TEST_PAYPHONE_IN_CO='true' en ENV, se usa PayPhone aunque
	 *       el isoCode sea 'CO'. Esto permite probar desde Colombia.
	 *       ⚠️ Remover la condición de test en producción.
	 */
	async getLinkForCountry(
		isoCode: string,
		amount: number,
		currency: string,
		clientTransactionId: string,
	): Promise<string> {
		// ── INICIO BLOQUE DE TESTING ──────────────────────────────────────────
		// Activar con TEST_PAYPHONE_IN_CO=true en .env para probar PayPhone
		// desde Colombia. Eliminar este bloque en producción.
		if (ENV.TEST_PAYPHONE_IN_CO === 'true') {
			return this.getPayPhoneLink(amount, 'USD', clientTransactionId);
		}
		// ── FIN BLOQUE DE TESTING ─────────────────────────────────────────────

		if (isoCode === 'CO') {
			return this.getBoldLink(amount, currency, clientTransactionId);
		}
		return this.getPayPhoneLink(amount, currency, clientTransactionId);
	}

	/**
	 * Devuelve el nombre del proveedor de pago según el país.
	 */
	getProviderName(isoCode: string): string {
		// TEST: Si TEST_PAYPHONE_IN_CO=true, siempre muestra PayPhone
		if (ENV.TEST_PAYPHONE_IN_CO === 'true') return 'PayPhone';
		return isoCode === 'CO' ? 'Bold' : 'PayPhone';
	}

	/**
	 * Devuelve los datos de pago por Nequi para Colombia.
	 */
	getNequiInfo(): string {
		const phone = ENV.NEQUI_PHONE_NUMBER;
		const holder = ENV.NEQUI_ACCOUNT_HOLDER;
		if (!phone) return '[Datos Nequi pendientes de configurar]';
		return `Nequi: ${phone}\nTitular: ${holder}`;
	}
}
