import axios, { AxiosError } from 'axios';
import { ENV } from '../../config/env';
import { WhatsAppLogService } from './logging/log.service';
import { CountryService } from './agent-services/country.service';
import { MediaHandlerService } from './agent-services/media-handler.service';
import { OpenAIService, NLUIntent } from './openai.service';
import { PaymentLinkService } from './payment-link.service';
import { ProductSearchService } from './agent-services/product-search.service';
import { FlowsService } from './agent-services/flows.service';
import { isWithinOfficeHours, normalizeText } from './utils';
import { QuoteService } from '../quote/service';
import { QuoteModel } from '../quote/model';

import { WhatsAppService } from '../whatsapp/service';
import { CustomerService } from '../customer/service';
import { CustomerModel } from '../customer/model';
import { CityService } from '../city/service';
import { CityModel } from '../city/model';

import { DocsService } from '../docs/service';
import { BillingService } from '../billing/service';
import { BillingModel } from '../billing/model';
import {
	WHATSAPP_API_TIMEOUT_MS,
	BUFFER_WAIT_MS,
	REPLY_DELAY_MS,
	CONVERSATION_HISTORY_MAX_TURNS,
	CONVERSATION_HISTORY_MESSAGE_MAX_CHARS,
} from './constants';
import {
	BufferEntry,
	CartChange,
	CoexistenceWebhookPayload,
	ConversationTurn,
	UserSession,
	WebhookChange,
	WebhookMessage,
	WebhookValue,
} from './types';
import {
	isExplicitHumanRequest,
	stripCallingCode,
} from './helpers/intent-detection';
import { getSession, saveSession } from './session.store';
import { AiStateService } from './agent-services/ai-state.service';
import { isAiAllowed, normalizePhone } from './helpers/phone-access';
import { getLineByPhoneNumberId, logRegisteredLines, WhatsAppLine } from './lines';

import {
	IntentHandlerService,
	IntentContext,
} from './agent-services/intent-handler.service';
import { RagDocService } from '../rag-docs/service';
import { RagDocModel } from '../rag-docs/model';

export class WhatsAppAgentService {
	// Buffer y cola se clavean por <phoneNumberId>:<teléfono>, igual que la
	// sesión y la pausa en Redis. Sin el prefijo de línea, el mismo cliente
	// escribiendo a dos líneas compartiría buffer: sus mensajes se mezclarían
	// en un solo turno y se procesarían con el país de la primera línea.
	private messageBuffer = new Map<string, BufferEntry>();
	private processingQueue = new Map<string, Promise<void>>();

	/**
	 * Comando de pruebas que el equipo escribe en el chat para devolver la
	 * conversación a la IA sin esperar al TTL. Solo se reconoce en un echo —es
	 * decir, escrito por el personal—, nunca en un mensaje del cliente: si no,
	 * un cliente podría reactivar la IA mientras una persona lo atiende.
	 *
	 * Requiere WHATSAPP_AGENT_TEST_COMMANDS=true, que viene apagada. En
	 * Coexistence no hay canal privado, así que el cliente ve el comando en su
	 * conversación: es aceptable mientras ambos lados son personas probando, y
	 * no debe estar activo con clientes reales.
	 */
	private readonly RESUME_COMMAND = '#gema-on';

	/**
	 * Acepta `#gema-on`, `#gema on` y `#gemaon`, en cualquier capitalización.
	 * La tolerancia es deliberada: con una comparación exacta, una errata del
	 * personal no reactivaría la IA sino que la *pausaría* —el comando pasaría
	 * por mensaje normal— y quien lo escribió creería haber hecho lo contrario
	 * de lo que hizo. Nadie escribe esto por accidente.
	 */
	private isResumeCommand = (text: string | null | undefined): boolean =>
		/^#gema[\s-]?on$/i.test((text ?? '').trim());

	private conversationKey = (
		botPhoneNumberId: string,
		phoneNumber: string,
	): string => `${botPhoneNumberId}:${phoneNumber}`;

	/**
	 * Aviso honesto cuando el traspaso ocurre con la tienda cerrada. Sin esto la
	 * IA promete "enseguida le atienden" un domingo por la noche y el cliente se
	 * queda en silencio hasta que alguien abra.
	 */
	private offHoursHandoffNote = (): string =>
		isWithinOfficeHours()
			? ''
			: `\n\n⏰ Nuestro equipo está fuera de horario ahora mismo (L–V 8–18h, Sáb 8–14h), pero verán su mensaje y le responderán a la brevedad.`;

	/**
	 * Al devolver la conversación a la IA, su hilo de diálogo ya no vale: el
	 * historial solo tiene lo que ocurrió ANTES de la intervención, porque los
	 * mensajes del personal llegan por el canal de echo y nunca entran en el
	 * contexto. Si no se limpia, la IA retoma como si el cliente siguiera donde
	 * lo dejó y puede repetir o contradecir lo que la persona acaba de resolver.
	 * Se conserva la identidad (nombre, ciudad, país); se descarta el diálogo.
	 *
	 * Por el camino normal esto ocurre solo: la sesión dura 2 h y la pausa más,
	 * así que al expirar ya no hay hilo. El comando reactiva al instante, así
	 * que hay que hacerlo explícito para que ambos caminos se comporten igual.
	 */
	private resetDialogueState = async (
		botPhoneNumberId: string,
		phoneNumber: string,
	): Promise<void> => {
		const session = await getSession(botPhoneNumberId, phoneNumber);
		if (Object.keys(session).length === 0) return;

		session.conversationHistory = [];
		session.lastBotMessage = undefined;
		session.lastProductList = undefined;
		session.remainingProductList = undefined;
		session.awaitingMoreProducts = undefined;
		session.lastSearchQuery = undefined;
		session.selectedProduct = undefined;
		session.selectedVariantName = undefined;
		session.pendingPresentationChoice = null;
		session.pendingStockConfirmQty = undefined;
		await saveSession(botPhoneNumberId, phoneNumber, session);
	};

	/**
	 * Una conversación en pausa no puede conservar flujos a medias: al expirar
	 * el TTL la IA no debe retomar un formulario que una persona ya resolvió por
	 * su cuenta. El contexto (nombre, ciudad, historial) sí se conserva.
	 */
	private clearInFlightFlows = async (
		botPhoneNumberId: string,
		phoneNumber: string,
	): Promise<void> => {
		const session = await getSession(botPhoneNumberId, phoneNumber);
		if (!session.pendingPurchaseFlow && !session.pendingQuoteFlow) return;

		session.pendingPurchaseFlow = null;
		session.pendingQuoteFlow = null;
		await saveSession(botPhoneNumberId, phoneNumber, session);
		console.log(
			`[WhatsApp Agent] Cleared in-flight flows for ${phoneNumber}: the conversation moved to a human.`,
		);
	};
	private logService = new WhatsAppLogService();
	private openai = new OpenAIService();
	private paymentLinkService = new PaymentLinkService();
	private quoteService = new QuoteService(QuoteModel);
	private billingService = new BillingService(BillingModel);
	private docsService = new DocsService(this.quoteService, this.billingService);
	private whatsAppService = new WhatsAppService();
	private customerService = new CustomerService(CustomerModel);
	private cityService = new CityService(CityModel);
	private countryService = new CountryService(this.logService);
	private aiStateService = new AiStateService();
	private productSearchService = new ProductSearchService(this.logService);
	private flowsService = new FlowsService(
		this.openai,
		this.customerService,
		this.cityService,
		this.quoteService,
		this.docsService,
		this.whatsAppService,
		this.paymentLinkService,
		this.productSearchService,
		this.aiStateService,
	);
	private mediaHandlerService!: MediaHandlerService;
	private intentHandlerService!: IntentHandlerService;
	private ragDocService = new RagDocService(RagDocModel, this.openai);

	constructor() {
		logRegisteredLines();
		if (ENV.WHATSAPP_AGENT_TEST_COMMANDS) {
			console.warn(
				`[WhatsApp Agent] ⚠️  Test commands enabled: "${this.RESUME_COMMAND}" written by the staff resumes the AI. ` +
					'Customers can read it in their own chat — do not leave this on in production.',
			);
		}
		this.mediaHandlerService = new MediaHandlerService(
			this.countryService,
			this.quoteService,
			this.whatsAppService,
			this.sendReply,
			this.billingService,
			this.aiStateService,
		);
		this.intentHandlerService = new IntentHandlerService(
			this.openai,
			this.productSearchService,
			this.quoteService,
			this.paymentLinkService,
			this.customerService,
			this.logService,
			this.ragDocService,
			this.flowsService,
		);
	}

	verifyWebhook = (mode: string, token: string, challenge: string) => {
		console.log('[WhatsApp Webhook] Verification attempt', {
			mode,
			tokenProvided: token,
			expectedToken: ENV.WHATSAPP_VERIFY_TOKEN,
			challenge,
			timestamp: new Date().toISOString(),
		});

		if (mode !== 'subscribe') {
			console.log('[WhatsApp Webhook] Invalid mode:', mode);
			return { status: 403, message: 'Modo inválido' };
		}

		if (token !== ENV.WHATSAPP_VERIFY_TOKEN) {
			console.log(
				'[WhatsApp Webhook] Invalid token. Expected:',
				ENV.WHATSAPP_VERIFY_TOKEN,
				'Got:',
				token,
			);
			return { status: 403, message: 'Token de verificación inválido' };
		}

		console.log(
			'[WhatsApp Webhook] Validation successful, returning challenge',
		);
		return { status: 200, challenge };
	};

	receiveMessage = async (body: unknown) => {
		const payload = body as CoexistenceWebhookPayload;

		// Los eventos `history` y `smb_app_state_sync` usan otro sobre
		// (event/data, sin `entry`). No los usamos: se descartan aquí.
		if (!payload?.entry) {
			console.warn('[WhatsApp Agent] Payload without entry, ignoring.');
			return { status: 200, message: 'Sin datos para procesar.' };
		}

		try {
			// Un mismo POST puede traer varias entries, varios changes y varios
			// mensajes o echoes. Leer solo el índice [0] perdería mensajes.
			for (const entry of payload.entry) {
				for (const change of entry?.changes ?? []) {
					await this.handleWebhookChange(change);
				}
			}
		} catch (error) {
			console.error('[WhatsApp Agent] Error processing message:', error);
			this.logService
				.logError({ context: 'receiveMessage', error })
				.catch(e =>
					console.error('[WhatsApp Agent] Failed to save error log:', e),
				);
			return { status: 500, message: 'Error interno del servidor.' };
		}
		return { status: 200, message: 'Mensaje recibido.' };
	};

	/**
	 * Demultiplexor: el campo `field` del change decide el tipo de evento. Con
	 * Coexistence conviven en el mismo webhook los mensajes del cliente
	 * (`messages`) y los que el personal escribe desde WhatsApp Business App o
	 * WhatsApp Web (`smb_message_echoes`).
	 */
	private handleWebhookChange = async (
		change: WebhookChange,
	): Promise<void> => {
		const value = change?.value;
		const phoneNumberId = value?.metadata?.phone_number_id ?? null;

		// La línea identifica la operación (país, tienda, inventario, moneda) y
		// aísla el estado. Un phone_number_id no registrado se ignora: falla
		// cerrado en vez de atender con una configuración indeterminada.
		const line = getLineByPhoneNumberId(phoneNumberId);
		if (!line) {
			console.log(
				`[WhatsApp Agent] Unregistered phone_number_id (${phoneNumberId ?? 'none'}), ignoring event.`,
			);
			return;
		}

		switch (change.field) {
			case 'messages':
				await this.handleMessagesChange(line, value);
				return;
			case 'smb_message_echoes':
				await this.handleEchoesChange(line, value);
				return;
			default:
				console.log(
					`[WhatsApp Agent] Unhandled webhook field "${change.field ?? 'undefined'}", ignoring.`,
				);
		}
	};

	/**
	 * Ejecuta el manejo de un evento liberando su marcador de deduplicación si
	 * falla. `markSeen` se consume al principio para que un reintento de Meta no
	 * duplique la respuesta, pero si el trabajo posterior revienta (Redis caído,
	 * por ejemplo) devolvemos 500 y Meta reintenta: sin liberar el marcador, ese
	 * reintento se descartaría por duplicado y el evento se perdería. Para un
	 * echo eso significa que la IA seguiría respondiendo pese a que una persona
	 * ya había intervenido.
	 */
	private withSeenRollback = async (
		messageId: string | null,
		run: () => Promise<void>,
	): Promise<void> => {
		try {
			await run();
		} catch (error) {
			await this.aiStateService
				.releaseSeen(messageId)
				.catch(e =>
					console.error('[WhatsApp Agent] Failed to release seen marker:', e),
				);
			throw error;
		}
	};

	/** Mensajes entrantes de clientes. */
	private handleMessagesChange = async (
		line: WhatsAppLine,
		value: WebhookValue | undefined,
	): Promise<void> => {
		if (value?.statuses?.length) {
			console.log('[WhatsApp Agent] Status update event, ignoring.');
			return;
		}

		for (const message of value?.messages ?? []) {
			await this.withSeenRollback(message?.id ?? null, () =>
				this.handleInboundMessage(line, message),
			);
		}
	};

	private handleInboundMessage = async (
		line: WhatsAppLine,
		message: WebhookMessage,
	): Promise<void> => {
		const botPhoneNumberId = line.phoneNumberId;
		// Se normaliza una sola vez en la entrada para que buffer, cola, sesión,
		// pausa y logs usen exactamente la misma clave de conversación.
		const phoneNumber = normalizePhone(message?.from) || null;
		const timestamp = message?.timestamp ?? null;
		const messageId = message?.id ?? null;
		const text = message?.text?.body ?? null;
		const imageId = message?.image?.id ?? null;
		const documentId = message?.document?.id ?? null;

		if (!phoneNumber) {
			console.warn('[WhatsApp Agent] Inbound message without sender, ignoring.');
			return;
		}

		if (timestamp) {
			const ageMs = Date.now() - Number(timestamp) * 1000;
			const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutos
			if (ageMs > MAX_AGE_MS) {
				console.warn(
					`[WhatsApp Agent] Stale message (${Math.round(ageMs / 1000)}s old), ignoring.`,
				);
				return;
			}
		}

		// Idempotencia: Meta reintenta el POST si tardamos en responder. Sin esto,
		// el mismo mensaje se contestaría dos veces.
		if (!(await this.aiStateService.markSeen(messageId))) {
			console.log(
				`[WhatsApp Agent] Duplicate message ${messageId}, already processed.`,
			);
			return;
		}

		console.log('[WhatsApp Agent] Incoming message:', {
			text,
			botPhoneNumberId,
			phoneNumber,
			timestamp,
			messageId,
		});

		const mediaId = imageId ?? documentId ?? null;
		const mediaType = imageId
			? ('image' as const)
			: documentId
				? ('document' as const)
				: null;

		if (!text && !mediaId) {
			console.warn('[WhatsApp Agent] Event without text or media, ignoring.');
			return;
		}

		const access = isAiAllowed(line, phoneNumber);
		if (!access.allowed) {
			console.log(
				`[WhatsApp Agent] AI not enabled for ${phoneNumber} (${access.reason}), leaving it to human attention.`,
			);
			this.logInbound(
				line,
				phoneNumber,
				text ?? `[${mediaType ?? 'media'}]`,
				`skipped:${access.reason}`,
				messageId,
			);
			return;
		}

		// Una persona está atendiendo esta conversación. El mensaje se registra
		// como historial pero NO se encola: al expirar la pausa no debe
		// procesarse retrospectivamente, solo un mensaje nuevo posterior
		// reactiva la IA.
		if (await this.aiStateService.isPaused(botPhoneNumberId, phoneNumber)) {
			console.log(
				`[WhatsApp Agent] Conversation with ${phoneNumber} is handled by a human, skipping AI.`,
			);
			this.logInbound(
				line,
				phoneNumber,
				text ?? `[${mediaType ?? 'media'}]`,
				'skipped:paused',
				messageId,
			);
			return;
		}

		if (mediaId && mediaType) {
			this.handleIncomingImage(
				phoneNumber,
				botPhoneNumberId,
				mediaId,
				mediaType,
			).catch(err =>
				console.error('[WhatsApp Agent] Error handling incoming media:', err),
			);
		} else if (text) {
			this.bufferMessage(phoneNumber, botPhoneNumberId, text);
		}
	};

	/**
	 * Echoes: mensajes salientes del negocio escritos desde WhatsApp Business
	 * App o WhatsApp Web. Son la señal de intervención humana.
	 *
	 * Meta NO marca el origen en el payload, así que un envío del propio agente
	 * sería indistinguible de uno escrito a mano. De ahí la comprobación contra
	 * los wamid que registramos al enviar.
	 */
	private handleEchoesChange = async (
		line: WhatsAppLine,
		value: WebhookValue | undefined,
	): Promise<void> => {
		for (const echo of value?.message_echoes ?? []) {
			await this.withSeenRollback(echo?.id ?? null, () =>
				this.handleBusinessEcho(line, echo),
			);
		}
	};

	private handleBusinessEcho = async (
		line: WhatsAppLine,
		echo: WebhookMessage,
	): Promise<void> => {
		// Un `revoke` es la eliminación de un mensaje anterior, no actividad nueva.
		if (echo?.type === 'revoke') {
			console.log('[WhatsApp Agent] Echo of a revoked message, ignoring.');
			return;
		}

		const messageId = echo?.id ?? null;

		if (!(await this.aiStateService.markSeen(messageId))) {
			console.log(
				`[WhatsApp Agent] Duplicate echo ${messageId}, already processed.`,
			);
			return;
		}

		if (await this.aiStateService.isSelfSend(messageId)) {
			console.log(
				`[WhatsApp Agent] Echo ${messageId} is one of our own sends, ignoring.`,
			);
			return;
		}

		// En un echo, `from` es el número del negocio y `to` el del cliente.
		// Tomar `from` aquí resolvería todas las conversaciones a la misma clave.
		const customerPhone = normalizePhone(echo?.to) || null;
		if (!customerPhone) {
			console.warn('[WhatsApp Agent] Echo without recipient, ignoring.');
			return;
		}

		// Las notificaciones de pedido que el propio bot envía a las tiendas
		// también generan echo: no son una intervención sobre un cliente.
		const access = isAiAllowed(line, customerPhone);
		if (!access.allowed && access.reason === 'denylist') {
			console.log(
				`[WhatsApp Agent] Echo addressed to an internal number (${customerPhone}), ignoring.`,
			);
			return;
		}

		// El personal devuelve la conversación a la IA. Va antes de pausar: este
		// mensaje no es una intervención, es el final de una.
		if (
			ENV.WHATSAPP_AGENT_TEST_COMMANDS &&
			this.isResumeCommand(echo?.text?.body)
		) {
			const wasPaused = await this.aiStateService.clearPause(
				line.phoneNumberId,
				customerPhone,
			);
			if (wasPaused) {
				await this.resetDialogueState(line.phoneNumberId, customerPhone);
			}
			console.log(
				`[WhatsApp Agent] Test command "${this.RESUME_COMMAND}" from staff for ${customerPhone} on line ${line.isoCode}: ` +
					`${wasPaused ? 'AI resumed' : 'the conversation was not paused'}.`,
			);
			this.logService
				.logMessage({
					phoneNumber: customerPhone,
					botPhoneNumberId: line.phoneNumberId,
					direction: 'outbound',
					text: this.describeEchoContent(echo),
					intent: 'test_command:resume',
					countryPrefix: this.countryPrefixOf(customerPhone),
					source: 'human',
					messageId,
				})
				.catch(err =>
					console.error('[WhatsApp Agent] Error saving test command log:', err),
				);
			return;
		}

		console.log(
			`[WhatsApp Agent] Human agent replied to ${customerPhone} on line ${line.isoCode}; pausing AI.`,
		);

		await this.aiStateService.pause(
			line.phoneNumberId,
			customerPhone,
			'human_reply',
		);
		await this.clearInFlightFlows(line.phoneNumberId, customerPhone);

		// Si había mensajes del cliente esperando el debounce, se descartan: la
		// persona ya contestó y una respuesta de la IA sería duplicada.
		this.discardBufferedMessages(line.phoneNumberId, customerPhone);

		this.logService
			.logMessage({
				phoneNumber: customerPhone,
				botPhoneNumberId: line.phoneNumberId,
				direction: 'outbound',
				text: this.describeEchoContent(echo),
				intent: 'human_agent',
				countryPrefix: this.countryPrefixOf(customerPhone),
				source: 'human',
				messageId,
			})
			.catch(err =>
				console.error('[WhatsApp Agent] Error saving human agent log:', err),
			);
	};

	/** Texto legible de un echo, para el historial. */
	private describeEchoContent = (echo: WebhookMessage): string => {
		if (echo?.text?.body) return echo.text.body;
		if (echo?.type === 'edit') {
			return echo.edit?.message?.text?.body ?? '[mensaje editado]';
		}
		return `[${echo?.type ?? 'mensaje'}]`;
	};

	/**
	 * Prefijo telefónico del CLIENTE. Es un dato descriptivo para el log: no
	 * decide la operación, que viene dada por la línea.
	 */
	private countryPrefixOf = (phoneNumber: string): string | null =>
		phoneNumber.startsWith('593')
			? '+593'
			: phoneNumber.startsWith('57')
				? '+57'
				: null;

	private logInbound = (
		line: WhatsAppLine,
		phoneNumber: string,
		text: string,
		intent: string | null,
		messageId: string | null,
	): void => {
		this.logService
			.logMessage({
				phoneNumber,
				botPhoneNumberId: line.phoneNumberId,
				direction: 'inbound',
				text,
				intent,
				countryPrefix: this.countryPrefixOf(phoneNumber),
				source: 'customer',
				messageId,
			})
			.catch(err =>
				console.error('[WhatsApp Agent] Error saving inbound log:', err),
			);
	};

	/** Cancela el debounce pendiente de un cliente y descarta lo acumulado. */
	private discardBufferedMessages = (
		botPhoneNumberId: string,
		phoneNumber: string,
	): void => {
		const key = this.conversationKey(botPhoneNumberId, phoneNumber);
		const buffered = this.messageBuffer.get(key);
		if (!buffered) return;

		clearTimeout(buffered.timer);
		this.messageBuffer.delete(key);
		console.log(
			`[WhatsApp Agent] Discarded ${buffered.texts.length} buffered message(s) from ${phoneNumber}: a human took over.`,
		);
	};

	private bufferMessage = (
		phoneNumber: string,
		botPhoneNumberId: string,
		text: string,
	) => {
		const key = this.conversationKey(botPhoneNumberId, phoneNumber);
		const existing = this.messageBuffer.get(key);

		if (existing) {
			clearTimeout(existing.timer);
			existing.texts.push(text);
		} else {
			this.messageBuffer.set(key, {
				botPhoneNumberId,
				texts: [text],
				timer: setTimeout(() => {}, 0), // placeholder, se reemplaza abajo
			});
		}

		const entry = this.messageBuffer.get(key)!;
		entry.timer = setTimeout(() => {
			this.messageBuffer.delete(key);
			const combined = entry.texts.join('\n');
			console.log(
				`[WhatsApp Agent] Processing ${entry.texts.length} buffered message(s) from ${phoneNumber}: "${entry.texts.join(' | ')}"`,
			);
			this.processAndReply(phoneNumber, entry.botPhoneNumberId, combined).catch(
				err => {
					console.error('[WhatsApp Agent] Error in processAndReply:', err);
					this.logService
						.logError({
							context: 'processAndReply',
							error: err,
							phoneNumber,
							botPhoneNumberId: entry.botPhoneNumberId,
						})
						.catch(e =>
							console.error('[WhatsApp Agent] Failed to save error log:', e),
						);
				},
			);
		}, BUFFER_WAIT_MS);
	};

	private processAndReply = async (
		phoneNumber: string,
		botPhoneNumberId: string,
		text: string,
	) => {
		// Cola serial por usuario: garantiza que no se procesen dos mensajes del
		// mismo número en paralelo, evitando que un handler sobrescriba los
		// cambios de sesión (carrito) que hizo otro handler concurrente.
		const key = this.conversationKey(botPhoneNumberId, phoneNumber);
		const prev = this.processingQueue.get(key);
		let resolveCurrent!: () => void;
		const current = new Promise<void>(resolve => {
			resolveCurrent = resolve;
		});
		this.processingQueue.set(key, current);
		if (prev) await prev;

		try {
			await this.doProcessAndReply(phoneNumber, botPhoneNumberId, text);

			// Invariante al cerrar el turno, cualquiera que sea la salida: una
			// conversación en pausa no conserva flujos a medias. Cubre tanto el
			// traspaso como el caso en que un empleado tomó la conversación
			// mientras este turno se procesaba.
			if (await this.aiStateService.isPaused(botPhoneNumberId, phoneNumber)) {
				await this.clearInFlightFlows(botPhoneNumberId, phoneNumber);
			}
		} finally {
			resolveCurrent();
			// Limpiar la entrada solo si sigue siendo la nuestra (no hay otra en cola)
			if (this.processingQueue.get(key) === current) {
				this.processingQueue.delete(key);
			}
		}
	};

	private doProcessAndReply = async (
		phoneNumber: string,
		botPhoneNumberId: string,
		text: string,
	) => {
		const normalizedText = normalizeText(text);

		// Read session first so we can reuse cached countryInfo
		const session: UserSession = await getSession(botPhoneNumberId, phoneNumber);

		// Use cached country info from session if available — avoids a DB query on every message
		const line = getLineByPhoneNumberId(botPhoneNumberId);
		const countryInfo =
			session.lastCountryInfo ??
			(line ? await this.countryService.resolveForLine(line) : null);
		const countryPrefix = this.countryPrefixOf(phoneNumber);
		const now = Date.now();
		const RESUMPTION_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutos
		const hasActiveList = (session.lastProductList?.length ?? 0) > 0;
		const isFirstInteraction = !session.lastActivityAt;
		const isResumption =
			!isFirstInteraction &&
			now - session.lastActivityAt! > RESUMPTION_THRESHOLD_MS &&
			hasActiveList;

		// ── Lookup de primera interacción y nombre de cliente (solo en primera sesión) ──
		if (isFirstInteraction) {
			const isoCode = countryInfo?.isoCode ?? 'CO';
			const localPhone = stripCallingCode(phoneNumber);
			const [hadPrior, existingCustomer] = await Promise.all([
				this.logService.hasInteractedBefore(phoneNumber, botPhoneNumberId),
				this.customerService.findByPhone(localPhone, isoCode),
			]);
			session.isFirstEverInteraction = !hadPrior;
			if (existingCustomer?.fullName) {
				session.knownCustomerName = existingCustomer.fullName;
			}
			// Si no hay datos del cliente, el bot va a pedir nombre y ciudad en su respuesta
			if (!existingCustomer) {
				session.awaitingNameAndCity = true;
			}
			console.log(
				`[WhatsApp Agent] isFirstEverInteraction=${session.isFirstEverInteraction}, knownCustomerName=${session.knownCustomerName ?? 'none'}`,
			);
		}

		// ── Extracción de nombre y ciudad cuando el cliente los da informalmente ──
		let nameJustCollected = false;
		if (
			!isFirstInteraction &&
			session.awaitingNameAndCity &&
			!session.collectedCustomerName &&
			!session.pendingQuoteFlow &&
			!session.pendingPurchaseFlow
		) {
			try {
				const extracted = await this.openai.extractNameAndCity(text);
				if (extracted.name) {
					session.collectedCustomerName = extracted.name;
					session.awaitingNameAndCity = false;
					nameJustCollected = true;
					console.log(
						`[WhatsApp Agent] Collected customer name: "${extracted.name}"${extracted.city ? `, city: "${extracted.city}"` : ''}`,
					);
				}
				if (extracted.city) {
					session.collectedCity = extracted.city;
				}
			} catch (err) {
				console.warn('[WhatsApp Agent] Failed to extract name/city:', err);
			}
		}

		session.lastActivityAt = now;
		await saveSession(botPhoneNumberId, phoneNumber, session);

		// ── Petición explícita de hablar con una persona, por encima del flujo ──
		// Los interceptores de compra y cotización responden antes de que el NLU
		// llegue a clasificar, así que sin esta salida un cliente atascado en el
		// formulario pediría ayuda y el bot le seguiría pidiendo la cédula: justo
		// el momento en que más falta hace el traspaso.
		if (
			(session.pendingPurchaseFlow || session.pendingQuoteFlow) &&
			isExplicitHumanRequest(normalizedText)
		) {
			const handoffReply =
				'Con gusto le comunico con una persona del equipo. Dejo aquí la conversación para que le atiendan. 🙌' +
				this.offHoursHandoffNote();

			session.lastBotMessage = handoffReply;
			await saveSession(botPhoneNumberId, phoneNumber, session);
			await this.sendReply(phoneNumber, botPhoneNumberId, handoffReply);
			await this.aiStateService.pause(
				botPhoneNumberId,
				phoneNumber,
				'customer_request',
			);
			console.log(
				`[WhatsApp Agent] ${phoneNumber} asked for a human while in a flow; pausing AI.`,
			);
			this.logService
				.logMessage({
					phoneNumber,
					botPhoneNumberId,
					direction: 'outbound',
					text: handoffReply,
					intent: 'human_handoff',
					countryPrefix: this.countryPrefixOf(phoneNumber),
				})
				.catch(err =>
					console.error('[WhatsApp Agent] Error saving outbound log:', err),
				);
			return;
		}

		// ── Interceptor: flujo de compra activo ──
		if (session.pendingPurchaseFlow) {
			const purchaseReply = await this.flowsService.handlePurchaseFlowStep(
				phoneNumber,
				botPhoneNumberId,
				text,
				normalizedText,
				session,
				countryInfo,
			);
			if (purchaseReply !== null) {
				// Cadena vacía: handlePurchaseFlowStep ya envió todo en un solo
				// mensaje (ej. imagen del QR con caption) y no requiere texto adicional.
				if (purchaseReply) {
					session.lastBotMessage = purchaseReply;
				}
				await saveSession(botPhoneNumberId, phoneNumber, session);
				if (purchaseReply) {
					await new Promise(resolve => setTimeout(resolve, REPLY_DELAY_MS));
					await this.sendReply(phoneNumber, botPhoneNumberId, purchaseReply);
				}
				this.logService
					.logMessage({
						phoneNumber,
						botPhoneNumberId,
						direction: 'outbound',
						text: purchaseReply || session.lastBotMessage || '',
						intent: 'purchase_flow',
						countryPrefix: this.countryPrefixOf(phoneNumber),
					})
					.catch(err =>
						console.error('[WhatsApp Agent] Error saving outbound log:', err),
					);
				return;
			}
		}

		// ── Interceptor: flujo de cotización activo ──
		if (session.pendingQuoteFlow) {
			const quoteReply = await this.flowsService.handleQuoteFlowStep(
				phoneNumber,
				botPhoneNumberId,
				text,
				normalizedText,
				session,
				countryInfo,
			);
			if (quoteReply !== null) {
				session.lastBotMessage = quoteReply;
				await saveSession(botPhoneNumberId, phoneNumber, session);
				const countryPrefix = this.countryPrefixOf(phoneNumber);
				await new Promise(resolve => setTimeout(resolve, REPLY_DELAY_MS));
				await this.sendReply(phoneNumber, botPhoneNumberId, quoteReply);
				this.logService
					.logMessage({
						phoneNumber,
						botPhoneNumberId,
						direction: 'outbound',
						text: quoteReply,
						intent: 'quote_flow',
						countryPrefix,
					})
					.catch(err =>
						console.error('[WhatsApp Agent] Error saving outbound log:', err),
					);
				return;
			}
		}

		// ── Interceptor: elección de presentación pendiente (kilos sueltos vs bloque/caja) ──
		// Si el turno anterior le preguntó al cliente cómo prefiere llevar un peso
		// (ej. "10 kilos" → sueltos o en bloque), resolvemos su respuesta aquí antes del
		// NLU. Si el mensaje no expresa una preferencia clara, el método limpia el
		// pendiente y devuelve null → sigue el flujo normal.
		if (session.pendingPresentationChoice) {
			const presentationReply =
				await this.intentHandlerService.resolvePendingPresentationChoice(
					session,
					phoneNumber,
					botPhoneNumberId,
					text,
					normalizedText,
					countryInfo,
				);
			if (presentationReply !== null) {
				session.lastBotMessage = presentationReply;
				const presentationUserTurn: ConversationTurn = {
					role: 'user',
					text: text.slice(0, CONVERSATION_HISTORY_MESSAGE_MAX_CHARS),
					ts: now,
				};
				const presentationBotTurn: ConversationTurn = {
					role: 'bot',
					text: presentationReply.slice(
						0,
						CONVERSATION_HISTORY_MESSAGE_MAX_CHARS,
					),
					ts: Date.now(),
				};
				session.conversationHistory = [
					...(session.conversationHistory ?? []),
					presentationUserTurn,
					presentationBotTurn,
				].slice(-CONVERSATION_HISTORY_MAX_TURNS * 2);
				await saveSession(botPhoneNumberId, phoneNumber, session);
				await new Promise(resolve => setTimeout(resolve, REPLY_DELAY_MS));
				await this.sendReply(phoneNumber, botPhoneNumberId, presentationReply);
				this.logService
					.logMessage({
						phoneNumber,
						botPhoneNumberId,
						direction: 'outbound',
						text: presentationReply,
						intent: 'presentation_choice',
						countryPrefix,
					})
					.catch(err =>
						console.error('[WhatsApp Agent] Error saving outbound log:', err),
					);
				return;
			}
		}

		// ── NLU: clasificación de intención y extracción de slots ──
		// Única fuente de intención. Reemplaza el antiguo motor de reglas/regex: una
		// sola llamada al LLM produce el intent y todos los slots estructurados.
		let intent: string;
		let aiSearchQuery: string | undefined;
		let aiSelectionIndexes: number[] | undefined;
		let aiVariantHint: string | undefined;
		let aiQuantity: number | undefined;
		let aiQuantities: number[] | undefined;
		let aiProductList:
			| Array<{ productHint: string; quantity: number; variantHint?: string }>
			| undefined;
		let aiReasoning: string | undefined;
		let aiChanges: CartChange[] | undefined;
		let aiNeedsClarification: boolean | undefined;
		let aiRecommendFromList: boolean | undefined;
		let aiFaqTopic: string | undefined;
		let aiSecondaryIntent: NLUIntent | undefined;

		try {
			const activeProductsList = hasActiveList
				? (session.lastProductList ?? []).map((p, i) => {
						const variantNames = p.variants.map(v => v.name).filter(Boolean);
						const label =
							variantNames.length === 1
								? `${p.name} – ${variantNames[0]}`
								: variantNames.length > 1
									? `${p.name} (variantes: ${variantNames.join(', ')})`
									: p.name;
						return { index: i + 1, label };
					})
				: undefined;

			const nluResult = await this.openai.detectIntentWithAI(
				text,
				hasActiveList,
				activeProductsList,
				session.awaitingMoreProducts,
				session.selectedProduct,
				session.cart,
				session.lastBotMessage,
				session.conversationHistory,
			);

			const primaryIntent = nluResult.primary;
			aiSearchQuery = primaryIntent.searchQuery;
			aiSelectionIndexes = primaryIntent.selectionIndexes;
			aiVariantHint = primaryIntent.variantHint;
			aiQuantity = primaryIntent.quantity;
			aiQuantities = primaryIntent.quantities;
			aiProductList = primaryIntent.productList;
			aiNeedsClarification = primaryIntent.needsClarification;
			aiRecommendFromList = primaryIntent.recommendFromList;
			aiFaqTopic = primaryIntent.faqTopic;
			// NUEVO: Razonamiento y cambios basados en modelo (más flexible que slots)
			aiReasoning = primaryIntent.reasoning;
			aiChanges = primaryIntent.changes;
			aiSecondaryIntent = nluResult.secondary ?? undefined;

			// unknown + producto seleccionado → seguir la conversación del producto.
			// unknown + sin contexto → saludo genérico.
			intent =
				primaryIntent.intent === 'unknown'
					? session.selectedProduct
						? 'product_followup'
						: 'greeting'
					: primaryIntent.intent;

			// Lista activa de un solo producto + cantidad sin selección previa →
			// selección implícita del único producto (preserva comportamiento anterior).
			if (
				(intent === 'product_followup' || intent === 'greeting') &&
				!session.selectedProduct &&
				aiQuantity !== undefined &&
				hasActiveList &&
				(session.lastProductList?.length ?? 0) === 1
			) {
				intent = 'select_product';
				aiSelectionIndexes = [1];
			}

			// Búsqueda nueva → limpiar el producto seleccionado previo.
			if (intent === 'search_product') {
				session.selectedProduct = undefined;
			}

			console.log(
				`[WhatsApp Agent] AI intent: ${primaryIntent.intent}` +
					(nluResult.secondary
						? ` + secondary: ${nluResult.secondary.intent}`
						: '') +
					(aiSearchQuery ? `, searchQuery: "${aiSearchQuery}"` : '') +
					(aiSelectionIndexes ? `, selection: [${aiSelectionIndexes}]` : '') +
					(aiVariantHint ? `, variantHint: "${aiVariantHint}"` : '') +
					(aiQuantity !== undefined ? `, qty: ${aiQuantity}` : '') +
					(aiProductList
						? `, productList: ${JSON.stringify(aiProductList)}`
						: '') +
					(aiNeedsClarification ? ', needsClarification' : '') +
					(aiFaqTopic ? `, faqTopic: "${aiFaqTopic}"` : '') +
					(aiReasoning ? `, reasoning: "${aiReasoning}"` : '') +
					(aiChanges ? `, changes: ${JSON.stringify(aiChanges)}` : ''),
			);
		} catch (err) {
			// Red de seguridad mínima si falla la IA (no se reintroduce el motor de reglas).
			console.warn('[WhatsApp Agent] AI intent detection failed:', err);
			const loneInteger = normalizedText.match(/^\d+$/);
			if (hasActiveList && loneInteger) {
				intent = 'select_product';
				aiSelectionIndexes = [parseInt(loneInteger[0], 10)];
			} else if (session.selectedProduct) {
				intent = 'product_followup';
			} else {
				intent = 'greeting';
			}
		}

		// Resumption: si el cliente vuelve tras una pausa larga y no trae una solicitud
		// concreta nueva, retomar el contexto del producto anterior.
		if (
			isResumption &&
			(intent === 'greeting' || intent === 'product_followup')
		) {
			intent = 'resumption';
		}

		// Si el cliente acaba de dar su nombre/ciudad, tratarlo como name_collected —
		// SALVO que el mismo mensaje también traiga un pedido/consulta de producto (p. ej.
		// mensajes juntados por el buffer: "Carlos desde Soledad\nDame 4 aceites"). En ese
		// caso el nombre ya quedó guardado y dejamos que el intent del NLU procese el
		// producto (si no, se perdería el pedido y el bot confirmaría algo sin agregarlo).
		if (nameJustCollected) {
			// ¿El mensaje trae ADEMÁS un pedido/consulta con contenido real de producto?
			const hasProductContent =
				(intent === 'search_product' && !!aiSearchQuery) ||
				(intent === 'multi_product_add' &&
					((aiProductList?.length ?? 0) > 0 || (aiChanges?.length ?? 0) > 0)) ||
				(intent === 'edit_cart' && (aiChanges?.length ?? 0) > 0) ||
				(intent === 'select_product' &&
					(aiSelectionIndexes?.length ?? 0) > 0) ||
				intent === 'request_quote' ||
				intent === 'purchase_intent' ||
				intent === 'show_cart';
			if (!hasProductContent) {
				intent = 'name_collected';
			} else {
				console.log(
					`[WhatsApp Agent] Name collected but message also has product intent (${intent}); processing product, name saved.`,
				);
			}
		}

		console.log(
			`[WhatsApp Agent] Intent detected: ${intent} (resumption: ${isResumption})`,
		);

		this.logService
			.logMessage({
				phoneNumber,
				botPhoneNumberId,
				direction: 'inbound',
				text,
				intent,
				countryPrefix,
			})
			.catch(err => {
				console.error(
					'[WhatsApp Agent] Error saving inbound message log:',
					err,
				);
				this.logService
					.logError({
						context: 'logMessage:inbound',
						error: err,
						phoneNumber,
						botPhoneNumberId,
						rawText: text,
					})
					.catch(e =>
						console.error('[WhatsApp Agent] Failed to save error log:', e),
					);
			});

		const ctx: IntentContext = {
			session,
			phoneNumber,
			botPhoneNumberId,
			text,
			normalizedText,
			countryInfo,
			isFirstInteraction,
			hasActiveList,
			aiSearchQuery,
			aiSelectionIndexes,
			aiVariantHint,
			aiQuantity,
			aiQuantities,
			aiProductList,
			aiReasoning: aiReasoning,
			aiChanges: aiChanges,
			aiNeedsClarification,
			aiRecommendFromList,
			aiFaqTopic,
			secondaryIntent: aiSecondaryIntent,
			isFirstEverInteraction: session.isFirstEverInteraction,
			knownCustomerName:
				session.knownCustomerName ?? session.collectedCustomerName,
			// Cliente nuevo sin datos: el cierre de la respuesta debe pedir nombre y ciudad,
			// pero SOLO una vez (no en cada turno). Si el cliente no responde, se recogen
			// más adelante en el flujo de cotización/compra.
			awaitingNameAndCity:
				session.awaitingNameAndCity === true &&
				!session.askedNameAndCity &&
				!session.pendingQuoteFlow &&
				!session.pendingPurchaseFlow,
		};

		// En cuanto este turno incluya la solicitud de nombre y ciudad, marcamos que ya
		// se pidió para no repetirla en los siguientes mensajes.
		if (ctx.awaitingNameAndCity) {
			session.askedNameAndCity = true;
		}

		const handlerReply = await this.intentHandlerService.handle(intent, ctx);
		// Misma honestidad que en la salida desde un flujo: si la tienda está
		// cerrada, no prometemos atención inmediata.
		const replyText =
			intent === 'human_handoff' && handlerReply
				? handlerReply + this.offHoursHandoffNote()
				: handlerReply;

		// Marcar que el bot ya se presentó como Gema (solo si es el primer contacto real)
		if (
			session.isFirstEverInteraction &&
			session.knownCustomerName &&
			!session.hasIntroducedByName
		) {
			session.hasIntroducedByName = true;
		}

		// Una respuesta vacía ('') significa que el handler ya envió todo por su cuenta
		// (p. ej. el QR de pago como imagen con caption): no hay texto adicional que enviar.
		// En ese caso, session.lastBotMessage ya fue fijado por el handler.
		const handlerSentOwnMessage = replyText === '';

		// Guardar último mensaje del bot en la sesión para contexto en próximas respuestas
		if (!handlerSentOwnMessage) {
			session.lastBotMessage = replyText;
		}

		// Actualizar historial de conversación (máx CONVERSATION_HISTORY_MAX_TURNS entradas)
		const botTurnText = handlerSentOwnMessage
			? (session.lastBotMessage ?? '')
			: replyText;
		const userTurn: ConversationTurn = {
			role: 'user',
			text: text.slice(0, CONVERSATION_HISTORY_MESSAGE_MAX_CHARS),
			ts: now,
		};
		const botTurn: ConversationTurn = {
			role: 'bot',
			text: botTurnText.slice(0, CONVERSATION_HISTORY_MESSAGE_MAX_CHARS),
			ts: Date.now(),
		};
		session.conversationHistory = [
			...(session.conversationHistory ?? []),
			userTurn,
			botTurn,
		].slice(-CONVERSATION_HISTORY_MAX_TURNS * 2);

		await saveSession(botPhoneNumberId, phoneNumber, session);

		if (!handlerSentOwnMessage) {
			await new Promise(resolve => setTimeout(resolve, REPLY_DELAY_MS));
			await this.sendReply(phoneNumber, botPhoneNumberId, replyText);
		}

		// El cliente pidió hablar con una persona: la IA se aparta y deja la
		// conversación al equipo, igual que si el personal hubiera escrito.
		// Va DESPUÉS de enviar a propósito: `sendReply` suprime cualquier mensaje
		// si la conversación ya está en pausa, así que pausar antes silenciaría
		// la propia despedida y el cliente se quedaría sin respuesta.
		if (intent === 'human_handoff') {
			await this.aiStateService.pause(
				botPhoneNumberId,
				phoneNumber,
				'customer_request',
			);
			console.log(
				`[WhatsApp Agent] ${phoneNumber} asked for a human on line ${botPhoneNumberId}; pausing AI.`,
			);
		}

		this.logService
			.logMessage({
				phoneNumber,
				botPhoneNumberId,
				direction: 'outbound',
				text: handlerSentOwnMessage ? (session.lastBotMessage ?? '') : replyText,
				intent: null,
				countryPrefix,
			})
			.catch(err => {
				console.error(
					'[WhatsApp Agent] Error saving outbound message log:',
					err,
				);
				this.logService
					.logError({
					context: 'logMessage:outbound',
					error: err,
					phoneNumber,
					botPhoneNumberId,
				})
					.catch(e =>
						console.error('[WhatsApp Agent] Failed to save error log:', e),
					);
			});
	};

	private handleIncomingImage = (
		phoneNumber: string,
		botPhoneNumberId: string,
		mediaId: string,
		mediaType: 'image' | 'document',
	): Promise<void> => {
		return this.mediaHandlerService.handleIncomingImage(
			phoneNumber,
			botPhoneNumberId,
			mediaId,
			mediaType,
			this.processingQueue,
		);
	};

	private sendReply = async (
		to: string,
		botPhoneNumberId: string,
		replyText: string,
	) => {
		// Último punto de control antes de salir. El turno puede tardar más de
		// 15 s (debounce + LLM + REPLY_DELAY_MS), de sobra para que un empleado
		// conteste mientras se procesa: sin esta comprobación la IA respondería
		// encima de la persona. Cubre también los interceptores de flujo, que
		// envían por su cuenta.
		if (await this.aiStateService.isPaused(botPhoneNumberId, to)) {
			console.log(
				`[WhatsApp Agent] Reply to ${to} suppressed: a human took over mid-turn.`,
			);
			return;
		}

		if (!ENV.WHATSAPP_ACCESS_TOKEN) {
			console.error('[WhatsApp Agent] WHATSAPP_ACCESS_TOKEN not set.');
			this.logService
				.logError({
					context: 'sendReply',
					error: new Error('WHATSAPP_ACCESS_TOKEN not set'),
					phoneNumber: to,
					botPhoneNumberId,
				})
				.catch(e =>
					console.error('[WhatsApp Agent] Failed to save error log:', e),
				);
			return;
		}

		try {
			const response = await axios.post(
				`https://graph.facebook.com/v21.0/${botPhoneNumberId}/messages`,
				{
					messaging_product: 'whatsapp',
					to,
					type: 'text',
					text: {
						body: replyText,
					},
				},
				{
					headers: {
						Authorization: `Bearer ${ENV.WHATSAPP_ACCESS_TOKEN}`,
						'Content-Type': 'application/json',
					},
					timeout: WHATSAPP_API_TIMEOUT_MS,
				},
			);
			// Se registra el wamid propio para que su eventual echo no se
			// interprete como una intervención humana.
			await this.aiStateService.registerSelfSend(
				response.data?.messages?.[0]?.id ?? null,
			);
			console.log(`[WhatsApp Agent] Reply sent to ${to}`);
		} catch (error) {
			if (error instanceof AxiosError) {
				if (error.code === 'ECONNABORTED') {
					console.error(`[WhatsApp Agent] Timeout sending reply to ${to}`);
					this.logService
						.logError({
							context: 'sendReply:timeout',
							error,
							phoneNumber: to,
							botPhoneNumberId,
						})
						.catch(e =>
							console.error('[WhatsApp Agent] Failed to save error log:', e),
						);
				} else {
					console.error(
						`[WhatsApp Agent] WhatsApp API error [${error.response?.status}]:`,
						error.response?.data,
					);
					this.logService
						.logError({
							context: `sendReply:apiError:${error.response?.status ?? 'unknown'}`,
							error,
							phoneNumber: to,
							botPhoneNumberId,
						})
						.catch(e =>
							console.error('[WhatsApp Agent] Failed to save error log:', e),
						);
				}
			} else {
				console.error(
					'[WhatsApp Agent] Unexpected error sending reply:',
					error,
				);
				this.logService
					.logError({
						context: 'sendReply:unexpected',
						error,
						phoneNumber: to,
						botPhoneNumberId,
					})
					.catch(e =>
						console.error('[WhatsApp Agent] Failed to save error log:', e),
					);
			}
		}
	};
}
