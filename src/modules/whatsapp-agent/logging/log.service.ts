import {
	WhatsAppMessageLogModel,
	MessageSource,
} from './message-log.model';
import { WhatsAppQueryLogModel } from './query-log.model';
import { WhatsAppErrorLogModel } from './error-log.model';

export class WhatsAppLogService {
	/**
	 * Devuelve true si el número ya envió al menos un mensaje al bot (según la tabla de logs).
	 * Se usa para distinguir clientes que nunca han hablado con el bot de los que sí.
	 */
	async hasInteractedBefore(
		phoneNumber: string,
		botPhoneNumberId: string,
	): Promise<boolean> {
		// Acotado a la línea: un cliente con historial en Colombia sigue siendo
		// una primera interacción cuando escribe por primera vez a Ecuador.
		const count = await WhatsAppMessageLogModel.count({
			where: { phoneNumber, botPhoneNumberId, direction: 'inbound' },
		});
		return count > 0;
	}

	async logMessage(data: {
		phoneNumber: string;
		botPhoneNumberId: string;
		direction: 'inbound' | 'outbound';
		text: string;
		intent: string | null;
		countryPrefix: string | null;
		source?: MessageSource | null;
		messageId?: string | null;
	}) {
		await WhatsAppMessageLogModel.create({
			phoneNumber: data.phoneNumber,
			botPhoneNumberId: data.botPhoneNumberId,
			direction: data.direction,
			text: data.text,
			intent: data.intent,
			countryPrefix: data.countryPrefix,
			// Por defecto, lo entrante es del cliente y lo saliente lo generó la
			// IA. El único caso que se desvía es el echo de un mensaje escrito por
			// una persona, que pasa 'human' explícitamente.
			source:
				data.source ?? (data.direction === 'inbound' ? 'customer' : 'ai'),
			messageId: data.messageId ?? null,
		});
		console.log(
			`[WhatsAppLogService] Message log saved — direction: ${data.direction}, phone: ${data.phoneNumber}`,
		);
	}

	async logQuery(data: {
		phoneNumber: string;
		botPhoneNumberId: string;
		rawText: string;
		searchTerms: string[];
		productFound: boolean;
		suggestionsShown: boolean;
		replyText: string;
		countryPrefix: string | null;
	}) {
		await WhatsAppQueryLogModel.create({
			phoneNumber: data.phoneNumber,
			botPhoneNumberId: data.botPhoneNumberId,
			rawText: data.rawText,
			searchTerms: data.searchTerms,
			productFound: data.productFound,
			suggestionsShown: data.suggestionsShown,
			replyText: data.replyText,
			countryPrefix: data.countryPrefix,
		});
		console.log(
			`[WhatsAppLogService] Query log saved for ${data.phoneNumber} — found: ${data.productFound}, suggestions: ${data.suggestionsShown}`,
		);
	}

	async logError(data: {
		context: string;
		error: unknown;
		phoneNumber?: string;
		botPhoneNumberId?: string;
		rawText?: string;
	}) {
		const err =
			data.error instanceof Error ? data.error : new Error(String(data.error));
		await WhatsAppErrorLogModel.create({
			context: data.context,
			errorMessage: err.message,
			errorStack: err.stack ?? null,
			phoneNumber: data.phoneNumber ?? null,
			botPhoneNumberId: data.botPhoneNumberId ?? null,
			rawText: data.rawText ?? null,
		});
		console.error(
			`[WhatsAppLogService] Error log saved — context: ${data.context}`,
			err.message,
		);
	}
}
