import axios, { AxiosError } from 'axios';
import { ENV } from '../../config/env';
import { redis } from '../../config/redis';
import { WhatsAppLogService } from './logging/log.service';
import { CountryService } from './agent-services/country.service';
import { MediaHandlerService } from './agent-services/media-handler.service';
import { OpenAIService, NLUIntent } from './openai.service';
import { PaymentLinkService } from './payment-link.service';
import { ProductSearchService } from './agent-services/product-search.service';
import { FlowsService } from './agent-services/flows.service';
import { normalizeText } from './utils';
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
	SESSION_TTL_SECONDS,
	CONVERSATION_HISTORY_MAX_TURNS,
	CONVERSATION_HISTORY_MESSAGE_MAX_CHARS,
} from './constants';
import {
	BufferEntry,
	CartChange,
	ConversationTurn,
	UserSession,
} from './types';
import { stripCallingCode } from './helpers/intent-detection';

import {
	IntentHandlerService,
	IntentContext,
} from './agent-services/intent-handler.service';
import { RagDocService } from '../rag-docs/service';
import { RagDocModel } from '../rag-docs/model';

export class WhatsAppAgentService {
	private messageBuffer = new Map<string, BufferEntry>();
	private processingQueue = new Map<string, Promise<void>>();
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
	);
	private mediaHandlerService!: MediaHandlerService;
	private intentHandlerService!: IntentHandlerService;
	private ragDocService = new RagDocService(RagDocModel, this.openai);

	constructor() {
		this.mediaHandlerService = new MediaHandlerService(
			this.countryService,
			this.quoteService,
			this.whatsAppService,
			this.sendReply,
			this.billingService,
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
		const payload = body as {
			entry?: Array<{
				changes?: Array<{
					value?: {
						messages?: Array<{
							text?: { body?: string };
							from?: string;
							timestamp?: string;
							id?: string;
						}>;
						statuses?: unknown[];
						metadata?: { phone_number_id?: string };
					};
				}>;
			}>;
		};
		if (!payload?.entry) {
			console.warn('[WhatsApp Agent] Payload without entry, ignoring.');
			return { status: 200, message: 'Sin datos para procesar.' };
		}

		try {
			const entry = payload?.entry?.[0];
			const changes = entry?.changes?.[0];
			const value = changes?.value;
			const messages = value?.messages?.[0];

			if (value?.statuses) {
				console.log('[WhatsApp Agent] Status update event, ignoring.');
				return { status: 200, message: 'Status update ignorado.' };
			}

			const text = messages?.text?.body ?? null;
			const imageId =
				(messages as { image?: { id?: string } } | undefined)?.image?.id ??
				null;
			const documentId =
				(messages as { document?: { id?: string } } | undefined)?.document
					?.id ?? null;
			const botPhoneNumberId = value?.metadata?.phone_number_id ?? null;
			const phoneNumber = messages?.from ?? null;
			const timestamp = messages?.timestamp ?? null;
			const message_id = messages?.id ?? null;

			if (timestamp) {
				const ageMs = Date.now() - Number(timestamp) * 1000;
				const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutos
				if (ageMs > MAX_AGE_MS) {
					console.warn(
						`[WhatsApp Agent] Stale message (${Math.round(ageMs / 1000)}s old), ignoring.`,
					);
					return { status: 200, message: 'Mensaje antiguo ignorado.' };
				}
			}

			if (!botPhoneNumberId) {
				console.warn(
					'[WhatsApp Agent] Event without phone_number_id (status update?), ignoring.',
				);
				return { status: 200, message: 'Evento sin phoneNumberId del bot.' };
			}

			if (
				ENV.WHATSAPP_AGENT_PHONE_NUMBER_ID &&
				botPhoneNumberId !== ENV.WHATSAPP_AGENT_PHONE_NUMBER_ID
			) {
				console.log(
					'[WhatsApp Agent] botPhoneNumberId no coincide con el configurado, ignorando mensaje de:',
					phoneNumber,
				);
				return { status: 200, message: 'botPhoneNumberId no autorizado.' };
			}

			console.log('[WhatsApp Agent] Incoming message:', {
				text,
				botPhoneNumberId,
				phoneNumber,
				timestamp,
				message_id,
			});

			if (!messages) {
				console.warn('[WhatsApp Agent] Event without messages, ignoring.');
				return { status: 200, message: 'Evento sin mensajes.' };
			}

			const mediaId = imageId ?? documentId ?? null;
			const mediaType = imageId
				? ('image' as const)
				: documentId
					? ('document' as const)
					: null;

			if (!text && !mediaId) {
				console.warn('[WhatsApp Agent] Event without text or media, ignoring.');
				return { status: 200, message: 'Evento sin texto ni media.' };
			}

			if (mediaId && mediaType && phoneNumber && botPhoneNumberId) {
				this.handleIncomingImage(
					phoneNumber,
					botPhoneNumberId,
					mediaId,
					mediaType,
				).catch(err =>
					console.error('[WhatsApp Agent] Error handling incoming media:', err),
				);
			} else if (text && phoneNumber && botPhoneNumberId) {
				this.bufferMessage(phoneNumber, botPhoneNumberId, text);
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

	private bufferMessage = (
		phoneNumber: string,
		botPhoneNumberId: string,
		text: string,
	) => {
		const existing = this.messageBuffer.get(phoneNumber);

		if (existing) {
			clearTimeout(existing.timer);
			existing.texts.push(text);
		} else {
			this.messageBuffer.set(phoneNumber, {
				botPhoneNumberId,
				texts: [text],
				timer: setTimeout(() => {}, 0), // placeholder, se reemplaza abajo
			});
		}

		const entry = this.messageBuffer.get(phoneNumber)!;
		entry.timer = setTimeout(() => {
			this.messageBuffer.delete(phoneNumber);
			const combined = entry.texts.join('\n');
			console.log(
				`[WhatsApp Agent] Processing ${entry.texts.length} buffered message(s) from ${phoneNumber}: "${entry.texts.join(' | ')}"`,
			);
			this.processAndReply(phoneNumber, entry.botPhoneNumberId, combined).catch(
				err => {
					console.error('[WhatsApp Agent] Error in processAndReply:', err);
					this.logService
						.logError({ context: 'processAndReply', error: err, phoneNumber })
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
		const prev = this.processingQueue.get(phoneNumber);
		let resolveCurrent!: () => void;
		const current = new Promise<void>(resolve => {
			resolveCurrent = resolve;
		});
		this.processingQueue.set(phoneNumber, current);
		if (prev) await prev;

		try {
			await this.doProcessAndReply(phoneNumber, botPhoneNumberId, text);
		} finally {
			resolveCurrent();
			// Limpiar la entrada solo si sigue siendo la nuestra (no hay otra en cola)
			if (this.processingQueue.get(phoneNumber) === current) {
				this.processingQueue.delete(phoneNumber);
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
		const raw = await redis.get(`session:${phoneNumber}`);
		const session: UserSession = raw ? JSON.parse(raw) : {};

		// Use cached country info from session if available — avoids a DB query on every message
		const countryInfo =
			session.lastCountryInfo ??
			(await this.countryService.detectFromPhone(phoneNumber));
		const countryPrefix = phoneNumber.startsWith('593')
			? '+593'
			: phoneNumber.startsWith('57')
				? '+57'
				: null;
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
				this.logService.hasInteractedBefore(phoneNumber),
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
		await redis.set(
			`session:${phoneNumber}`,
			JSON.stringify(session),
			'EX',
			SESSION_TTL_SECONDS,
		);

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
				await redis.set(
					`session:${phoneNumber}`,
					JSON.stringify(session),
					'EX',
					SESSION_TTL_SECONDS,
				);
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
						countryPrefix: countryInfo
							? `+${phoneNumber.startsWith('593') ? '593' : '57'}`
							: null,
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
				await redis.set(
					`session:${phoneNumber}`,
					JSON.stringify(session),
					'EX',
					SESSION_TTL_SECONDS,
				);
				const countryPrefix = countryInfo
					? `+${phoneNumber.startsWith('593') ? '593' : '57'}`
					: null;
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

		// Si el cliente acaba de dar su nombre/ciudad, ignorar el intent detectado por NLU.
		if (nameJustCollected) {
			intent = 'name_collected';
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
			secondaryIntent: aiSecondaryIntent,
			isFirstEverInteraction: session.isFirstEverInteraction,
			knownCustomerName:
				session.knownCustomerName ?? session.collectedCustomerName,
		};

		const replyText = await this.intentHandlerService.handle(intent, ctx);

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

		await redis.set(
			`session:${phoneNumber}`,
			JSON.stringify(session),
			'EX',
			SESSION_TTL_SECONDS,
		);

		if (!handlerSentOwnMessage) {
			await new Promise(resolve => setTimeout(resolve, REPLY_DELAY_MS));
			await this.sendReply(phoneNumber, botPhoneNumberId, replyText);
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
					.logError({ context: 'logMessage:outbound', error: err, phoneNumber })
					.catch(e =>
						console.error('[WhatsApp Agent] Failed to save error log:', e),
					);
			});
	};

	/**
	 * Notifica al proveedor del pedido por WhatsApp.
	 */

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
		if (!ENV.WHATSAPP_ACCESS_TOKEN) {
			console.error('[WhatsApp Agent] WHATSAPP_ACCESS_TOKEN not set.');
			this.logService
				.logError({
					context: 'sendReply',
					error: new Error('WHATSAPP_ACCESS_TOKEN not set'),
					phoneNumber: to,
				})
				.catch(e =>
					console.error('[WhatsApp Agent] Failed to save error log:', e),
				);
			return;
		}

		try {
			await axios.post(
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
			console.log(`[WhatsApp Agent] Reply sent to ${to}`);
		} catch (error) {
			if (error instanceof AxiosError) {
				if (error.code === 'ECONNABORTED') {
					console.error(`[WhatsApp Agent] Timeout sending reply to ${to}`);
					this.logService
						.logError({ context: 'sendReply:timeout', error, phoneNumber: to })
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
					.logError({ context: 'sendReply:unexpected', error, phoneNumber: to })
					.catch(e =>
						console.error('[WhatsApp Agent] Failed to save error log:', e),
					);
			}
		}
	};
}
