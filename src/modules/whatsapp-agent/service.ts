import axios, { AxiosError } from 'axios';
import { ENV } from '../../config/env';
import { redis } from '../../config/redis';
import { WhatsAppLogService } from './logging/log.service';
import { CountryService } from './agent-services/country.service';
import { MediaHandlerService } from './agent-services/media-handler.service';
import { OpenAIService } from './openai.service';
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
} from './constants';
import { BufferEntry, UserSession } from './types';
import {
	detectDeterministicIntent,
	detectIntent,
	detectSelection,
	detectSelectionByName,
	stripCallingCode,
} from './helpers/intent-detection';
import {
	resolveVariant,
	parseVariantWeightGrams,
	detectRequestedWeightGrams,
	resolveVariantByWeight,
} from './helpers/product-helpers';

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
	private docsService = new DocsService(
		this.quoteService,
		new BillingService(BillingModel),
	);
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
		);
		this.intentHandlerService = new IntentHandlerService(
			this.openai,
			this.productSearchService,
			this.quoteService,
			this.paymentLinkService,
			this.customerService,
			this.logService,
			this.ragDocService,
		);
	}

	verifyWebhook = (mode: string, token: string, challenge: string) => {
		if (mode !== 'subscribe') {
			return { status: 403, message: 'Modo inválido' };
		}

		if (token !== ENV.WHATSAPP_VERIFY_TOKEN) {
			return { status: 403, message: 'Token de verificación inválido' };
		}

		return { status: 200, challenge };
	};

	receiveMessage = async (body: unknown) => {
		console.log('**************** receiving message ****************');
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

			console.log(botPhoneNumberId);

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
					'[WhatsApp Agent] phoneNumberId no coincide con el configurado, ignorando mensaje de:',
					phoneNumber,
				);
				return { status: 200, message: 'phoneNumberId no autorizado.' };
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
		const countryInfo = await this.countryService.detectFromPhone(phoneNumber);
		const countryPrefix = countryInfo
			? `+${phoneNumber.startsWith('593') ? '593' : '57'}`
			: null;

		const raw = await redis.get(`session:${phoneNumber}`);
		const session: UserSession = raw ? JSON.parse(raw) : {};
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
			console.log(
				`[WhatsApp Agent] isFirstEverInteraction=${session.isFirstEverInteraction}, knownCustomerName=${session.knownCustomerName ?? 'none'}`,
			);
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
				session.lastBotMessage = purchaseReply;
				await redis.set(
					`session:${phoneNumber}`,
					JSON.stringify(session),
					'EX',
					SESSION_TTL_SECONDS,
				);
				await new Promise(resolve => setTimeout(resolve, REPLY_DELAY_MS));
				await this.sendReply(phoneNumber, botPhoneNumberId, purchaseReply);
				this.logService
					.logMessage({
						phoneNumber,
						botPhoneNumberId,
						direction: 'outbound',
						text: purchaseReply,
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

		const selectionIndex = detectSelection(normalizedText);
		const nameSelectionIndex =
			selectionIndex === null && hasActiveList
				? detectSelectionByName(normalizedText, session.lastProductList ?? [])
				: null;
		const effectiveSelectionIndex = selectionIndex ?? nameSelectionIndex;

		// Checks determinísticos: show_more y affirmation también los resuelve el backend
		const deterministicIntent = detectDeterministicIntent(normalizedText);

		let intent: string;
		let aiSearchQuery: string | undefined;
		let aiSelectionIndexes: number[] | undefined;
		let aiVariantHint: string | undefined;
		let aiQuantity: number | undefined;
		let aiQuantities: number[] | undefined;
		let aiRemoveProductHint: string | undefined;
		let aiAddProductHint: string | undefined;
		let aiCartEdits:
			| Array<{ productHint: string; quantity: number }>
			| undefined;
		let aiProductList:
			| Array<{
					productHint: string;
					quantity: number;
					variantHint?: string;
					unit?: string;
			  }>
			| undefined;

		if (isResumption && deterministicIntent !== 'search_product') {
			intent = 'resumption';
		} else if (deterministicIntent !== null) {
			intent = deterministicIntent;
		} else {
			// Helper: true si el texto menciona palabras de un producto DIFERENTE al selectedProduct,
			// tanto en el carrito como en la lista activa.
			const checkMentionsDifferentProduct = (): boolean =>
				!!(
					session.selectedProduct &&
					(session.cart?.some(item => {
						if (item.productName === session.selectedProduct) return false;
						const words = normalizeText(item.productName)
							.split(/\s+/)
							.filter(w => w.length > 3);
						return words.some(w => normalizedText.includes(w));
					}) ||
						session.lastProductList?.some(p => {
							if (p.name === session.selectedProduct) return false;
							const words = normalizeText(p.name)
								.split(/\s+/)
								.filter(w => w.length > 3);
							return words.some(w => normalizedText.includes(w));
						}))
				);

			// Deterministic override (PRIORITARIO): si detectSelectionByName encontró un
			// producto DIFERENTE al seleccionado, forzar select_product ANTES de los bloques
			// de cantidad/peso. Esto evita que "6 kilos de la cca" se interprete como
			// cantidad de KARITE cuando CCA es un producto diferente en la lista.
			// Se ejecuta aquí porque checkMentionsDifferentProduct filtra palabras de <=3
			// caracteres (ej: "cca") y no las detecta como producto diferente.
			if (
				session.selectedProduct &&
				hasActiveList &&
				effectiveSelectionIndex !== null
			) {
				const mentionedProduct =
					session.lastProductList?.[effectiveSelectionIndex - 1];
				if (
					mentionedProduct &&
					mentionedProduct.name !== session.selectedProduct
				) {
					intent = 'select_product';
					aiSelectionIndexes = [effectiveSelectionIndex];

					// Extraer cantidad del texto (ej: "tambien dame 2 de la de avena")
					const qtyMatch = normalizedText.match(/\b(\d+)\b/);
					if (qtyMatch) {
						const parsedQty = parseInt(qtyMatch[1], 10);
						if (parsedQty > 0 && parsedQty <= 1000) {
							// Verificar si es peso (ej: "2 kilos") → convertir a unidades
							const requestedGramsDet =
								detectRequestedWeightGrams(normalizedText);
							if (requestedGramsDet !== null) {
								const resolvedV = resolveVariant(
									mentionedProduct,
									undefined,
									normalizedText,
								);
								const vGrams = resolvedV
									? parseVariantWeightGrams(resolvedV.name)
									: null;
								if (vGrams !== null) {
									aiQuantity = Math.ceil(requestedGramsDet / vGrams);
								} else {
									aiQuantity = parsedQty;
								}
							} else {
								aiQuantity = parsedQty;
							}
						}
					}

					console.log(
						`[WhatsApp Agent] Deterministic select_product for different product: "${mentionedProduct.name}" (idx ${effectiveSelectionIndex})` +
							(aiQuantity !== undefined ? `, qty: ${aiQuantity}` : ''),
					);
				}
			}

			// Helper: true si el texto menciona nombres de variante de un producto
			// multi-variante en la lista activa (útil para evitar que "quiero 1 rectangular"
			// se interprete como qty=1 del producto ya seleccionado).
			const mentionsMultiVariantNames = (): boolean => {
				if (!hasActiveList) return false;
				return (session.lastProductList ?? []).some(p => {
					if (p.variants.length <= 1) return false;
					return p.variants.some(v => {
						const vWords = normalizeText(v.name)
							.split(/\s+/)
							.filter(w => w.length > 2);
						return vWords.some(w => normalizedText.includes(w));
					});
				});
			};

			// Detección con contexto de sesión: "dame/quiero/ponme X" cuando hay producto activo
			// Esto evita que la IA clasifique como "unknown" y pierda el contexto del producto
			// NOTA: no aplica cuando el número va seguido de unidad de peso (ej: "quiero 1 kilo")
			// NOTA: no aplica cuando el texto menciona variantes de un producto multi-variante
			// Solo matchea "verbo N" sin texto adicional (ej: "dame 3", "agrega 2").
			// Si hay texto de producto después del número (ej: "agrega 2 fragancias de chicle"),
			// el bloque verbQtyHint más abajo se encarga de resolverlo via carrito.
			const qtyCommandMatch = !intent!
				? normalizedText.match(
						/^(?:dame|quiero|pon|ponme|agrega|necesito|llevo|llevame|mandame|enviame)\s+(\d+)(?!\s*(?:kilo[s]?|kg|gramo[s]?|gr|g\b))\s*$/i,
					)
				: null;
			if (qtyCommandMatch && !mentionsMultiVariantNames()) {
				const extractedQty = parseInt(qtyCommandMatch[1], 10);
				if (session.selectedProduct && hasActiveList) {
					// Verificar que el mensaje no mencione un producto DIFERENTE al seleccionado.
					// Si lo hace, dejar que la IA resuelva (puede ser edit_cart con otro producto).
					if (!checkMentionsDifferentProduct()) {
						// Producto ya en contexto: interpretar como cantidad de ese producto
						intent = 'product_followup';
						aiQuantity = extractedQty;
						console.log(
							`[WhatsApp Agent] Context qty for selected product: ${extractedQty}`,
						);
					}
				} else if (
					hasActiveList &&
					(session.lastProductList?.length ?? 0) === 1
				) {
					// Un solo producto en lista: selección implícita con cantidad
					intent = 'select_product';
					aiSelectionIndexes = [1];
					aiQuantity = extractedQty;
					console.log(
						`[WhatsApp Agent] Context qty → select_product [1] qty=${extractedQty}`,
					);
				}
			}

			// Detección de cantidad por peso (ej: "quiero 1 kilo", "dame 500 gramos")
			// Aplica cuando hay producto seleccionado O cuando la lista activa tiene exactamente
			// 1 producto (el cliente implícitamente se refiere a ese).
			if (!intent! && hasActiveList) {
				const weightProductEntry = session.selectedProduct
					? session.lastProductList?.find(
							p => p.name === session.selectedProduct,
						)
					: session.lastProductList?.length === 1
						? session.lastProductList[0]
						: undefined;
				// No aplicar la conversión por peso si el mensaje menciona explícitamente
				// un producto distinto al seleccionado (ej: "5 kilos de cera" cuando selectedProduct es Ácido Esteárico).
				if (weightProductEntry && !checkMentionsDifferentProduct()) {
					const requestedGrams = detectRequestedWeightGrams(normalizedText);
					if (requestedGrams !== null) {
						const resolved = resolveVariantByWeight(
							weightProductEntry.variants,
							requestedGrams,
						);
						if (resolved) {
							intent = 'product_followup';
							aiQuantity = resolved.units;
							session.selectedProduct = weightProductEntry.name;
							session.selectedVariantName = resolved.variant.name;
							console.log(
								`[WhatsApp Agent] Weight request: ${requestedGrams}g → ${resolved.units}x "${resolved.variant.name}" (product: ${weightProductEntry.name})`,
							);
						}
					}
				}
			}

			// Detección multi-producto: "Necesito 4 kilos de cera de palma y 1 termometro".
			// Si el mensaje (o la combinación de mensajes del buffer) contiene 2+ segmentos
			// con formato "N [unidad?] [de?] producto", se procesa como multi_product_add.
			// Esto evita que el buffer genere 2 respuestas separadas (una por producto).
			if (!intent!) {
				const stripped = normalizedText.replace(
					/^(?:dame|quiero|necesito|llevame|llevo|mandame|enviame|pon|ponme|agregar?)\s+/i,
					'',
				);
				let segments = stripped.split(/\s+y\s+|,\s*/i);
				// Si no se encontraron múltiples segmentos por "y"/"," intentar dividir
				// por saltos de línea del texto original (mensaje con shift+enter en WhatsApp)
				if (segments.length < 2 && text.includes('\n')) {
					const STRIP_VERB =
						/^(?:dame|quiero|necesito|llevame|llevo|mandame|enviame|pon|ponme|agregar?)\s+/i;
					segments = text
						.split('\n')
						.map(l => normalizeText(l).replace(STRIP_VERB, '').trim())
						.filter(l => l.length > 0);
				}
				if (segments.length >= 2) {
					const parsedItems: Array<{
						productHint: string;
						quantity: number;
						unit?: string;
					}> = [];
					let allSegmentsValid = true;
					for (const seg of segments) {
						const m = seg
							.trim()
							.match(
								/^(\d+)\s*(kilo[s]?|kg|gramo[s]?|gr|ml|litro[s]?)?\s*(?:de\s+)?(.{2,})$/i,
							);
						if (!m) {
							allSegmentsValid = false;
							break;
						}
						const qty = parseInt(m[1], 10);
						const unit = m[2]?.toLowerCase() || undefined;
						const productHint = m[3].trim();
						if (qty <= 0 || productHint.length < 2) {
							allSegmentsValid = false;
							break;
						}
						parsedItems.push({ productHint, quantity: qty, unit });
					}
					if (allSegmentsValid && parsedItems.length >= 2) {
						intent = 'multi_product_add';
						aiProductList = parsedItems;
						console.log(
							`[WhatsApp Agent] Multi-product detected: ${parsedItems.map(i => `${i.quantity}x "${i.productHint}"`).join(', ')}`,
						);
					}
				}
			}

			// Decremento parcial: "quita 1 cera de palma" / "quita una fragancia".
			// Si se especifica una cantidad N menor que la cantidad actual en el carrito,
			// se reduce en N en lugar de eliminar el ítem completo.
			if (!intent! && session.cart?.length) {
				const removeQtyMatch = normalizedText.match(
					/^(?:quita[r]?|sac[ae][r]?)\s+(\d+|una?|un)\s+(.+)$/i,
				);
				if (removeQtyMatch) {
					const rawQty = removeQtyMatch[1];
					const removeQty = /^una?$|^un$/i.test(rawQty)
						? 1
						: parseInt(rawQty, 10);
					const removeHintRaw = removeQtyMatch[2].trim();
					const removeHintNorm = normalizeText(removeHintRaw);
					const removeTokens = removeHintNorm
						.split(/\s+/)
						.filter(t => !/\d/.test(t) && t.length > 2);
					if (removeTokens.length > 0) {
						let bestRemoveItem: NonNullable<typeof session.cart>[0] | undefined;
						let bestRemoveScore = 0;
						for (const item of session.cart) {
							const fullName = normalizeText(
								item.variantName
									? `${item.productName} ${item.variantName}`
									: item.productName,
							);
							const score = removeTokens.filter(t =>
								fullName.includes(t),
							).length;
							if (score > bestRemoveScore) {
								bestRemoveScore = score;
								bestRemoveItem = item;
							}
						}
						if (bestRemoveItem && bestRemoveScore > 0) {
							if (removeQty < bestRemoveItem.quantity) {
								// Decremento parcial: establecer la nueva cantidad
								intent = 'edit_cart';
								aiAddProductHint = removeHintRaw;
								aiQuantity = bestRemoveItem.quantity - removeQty;
								console.log(
									`[WhatsApp Agent] Partial remove: "${removeHintRaw}" -${removeQty} → new qty=${aiQuantity}`,
								);
							} else {
								// Quitar todo (qty >= cantidad en carrito)
								intent = 'edit_cart';
								aiRemoveProductHint = removeHintRaw;
								console.log(
									`[WhatsApp Agent] Full remove (qty≥cart): "${removeHintRaw}"`,
								);
							}
						}
					}
				}
			}

			// Detección del patrón "verbo N producto": "agrega 2 fragancias de chicle".
			// Cuando el mensaje contiene verbo de acción + número + nombre, y el nombre
			// coincide con un ítem del carrito, se fuerza edit_cart directo sin pasar por la IA.
			// Esto evita que qtyCommandMatch interprete el número como cantidad del selectedProduct
			// anterior en lugar del producto explícitamente mencionado.
			if (!intent! && session.cart?.length) {
				const verbQtyHintMatch = normalizedText.match(
					/^(?:dame|quiero|pon|ponme|agrega[r]?|a[nñ]ade[r]?|sum[ae][r]?|necesito|llevo|llevame|mandame|enviame)\s+(\d+)\s+(.{2,})$/i,
				);
				if (verbQtyHintMatch) {
					const vqhQty = parseInt(verbQtyHintMatch[1], 10);
					const vqhHint = verbQtyHintMatch[2].trim();
					const vqhNorm = normalizeText(vqhHint);
					const vqhIdTokens = vqhNorm.split(/\s+/).filter(t => /\d/.test(t));
					// Palabras de unidad de medida: no sirven para identificar un producto
					// y pueden causar falsos positivos contra variantes que las contienen
					// (ej: "kilos" matchea "KILO" en el nombre de variante de Cera de Palma).
					const VQH_UNIT_WORDS = new Set([
						'kilo',
						'kilos',
						'kg',
						'gramo',
						'gramos',
						'gr',
						'ml',
						'litro',
						'litros',
						'unidad',
						'unidades',
						'libra',
						'libras',
						'onza',
						'onzas',
					]);
					const vqhWordTokens = vqhNorm
						.split(/\s+/)
						.filter(
							t => !/\d/.test(t) && t.length > 2 && !VQH_UNIT_WORDS.has(t),
						);
					if (vqhIdTokens.length > 0 || vqhWordTokens.length > 0) {
						let bestVqhItem: NonNullable<typeof session.cart>[0] | undefined;
						let bestVqhScore = 0;
						for (const item of session.cart) {
							const fullName = normalizeText(
								item.variantName
									? `${item.productName} ${item.variantName}`
									: item.productName,
							);
							if (
								vqhIdTokens.length > 0 &&
								!vqhIdTokens.every(t => fullName.includes(t))
							)
								continue;
							const score = vqhWordTokens.filter(t =>
								fullName.includes(t),
							).length;
							if (score > bestVqhScore) {
								bestVqhScore = score;
								bestVqhItem = item;
							}
						}
						// Requiere que al menos la mitad de los tokens significativos coincidan.
						// Evita que una sola palabra genérica (ej: "cera") fuerce edit_cart
						// contra un producto existente cuando el mensaje describe uno distinto.
						const vqhMinScore = Math.max(
							1,
							Math.ceil(vqhWordTokens.length / 2),
						);
						if (bestVqhItem && bestVqhScore >= vqhMinScore) {
							intent = 'edit_cart';
							aiAddProductHint = vqhHint;
							aiQuantity = vqhQty;
							console.log(
								`[WhatsApp Agent] Verb+qty+hint (cart): "${vqhHint}" x${vqhQty} → edit_cart (matched: ${bestVqhItem.productName})`,
							);
						}
					}
				}
			}

			// Detección de frases de corrección: "son N X", "deben ser N X", "mejor N X", etc.
			// Cubre el caso en que el cliente corrige la cantidad de un producto del carrito
			// sin usar verbos de acción explícitos.
			if (!intent! && session.cart?.length) {
				const correctionMatch = normalizedText.match(
					/^(?:son|deben?\s+ser|mejor(?:\s+(?:son|sean))?|que\s+sean|en\s+realidad|mejor\s+dicho)\s+(\d+)\s+(.+)$/i,
				);
				if (correctionMatch) {
					const corrQty = parseInt(correctionMatch[1], 10);
					const corrHint = correctionMatch[2].trim();
					const corrTokens = normalizeText(corrHint)
						.split(/\s+/)
						.filter(w => w.length > 1);
					const matchedCartItem = session.cart.find(item => {
						const fullName = normalizeText(
							item.variantName
								? `${item.productName} ${item.variantName}`
								: item.productName,
						);
						const idTokens = corrTokens.filter(t => /\d/.test(t));
						const wordTokens = corrTokens.filter(
							t => !/\d/.test(t) && t.length > 1,
						);
						const idMatch =
							idTokens.length === 0 ||
							idTokens.every(t => fullName.includes(t));
						const wordMatch =
							wordTokens.length === 0 ||
							wordTokens.some(t => fullName.includes(t));
						return (
							(idTokens.length > 0 || wordTokens.length > 0) &&
							idMatch &&
							wordMatch
						);
					});
					if (matchedCartItem) {
						intent = 'edit_cart';
						aiAddProductHint = corrHint;
						aiQuantity = corrQty;
						console.log(
							`[WhatsApp Agent] Correction phrase: "${corrHint}" x${corrQty} → edit_cart`,
						);
					}
				}
			}

			// Texto sin conjunción inicial ("y", "e") para matching de patrones.
			// "y 5 kilos de easy soap white" → "5 kilos de easy soap white".
			// El normalizedText original se preserva para el llamado a la IA.
			const patternText = normalizedText.replace(/^(?:y|e)\s+/i, '');

			// Detección del patrón "[N] kilos/gramos de [producto]" como búsqueda de nuevo producto.
			// Maneja mensajes como "y 5 kilos de easy soap white" (tras quitar la conjunción).
			// Solo aplica cuando el producto NO está en el carrito ni en la lista activa.
			if (!intent!) {
				const weightedProductSearchMatch = patternText.match(
					/^(\d+)\s+(?:kilo(?:s)?|kg|gramos?|gr)\s+(?:de\s+)?(.{2,})$/i,
				);
				if (weightedProductSearchMatch) {
					const wpsQty = parseInt(weightedProductSearchMatch[1], 10);
					const wpsProduct = weightedProductSearchMatch[2].trim();
					const wpsTokens = normalizeText(wpsProduct)
						.split(/\s+/)
						.filter(w => w.length > 2);
					if (wpsTokens.length > 0) {
						const matchesCartWps = (session.cart ?? []).some(item => {
							const fullName = normalizeText(
								item.variantName
									? `${item.productName} ${item.variantName}`
									: item.productName,
							);
							return wpsTokens.some(w => fullName.includes(w));
						});
						const matchesActiveListWps = (session.lastProductList ?? []).some(
							p => {
								const pNorm = normalizeText(p.name);
								return wpsTokens.some(w => pNorm.includes(w));
							},
						);
						if (!matchesCartWps && !matchesActiveListWps) {
							intent = 'search_product';
							aiSearchQuery = wpsProduct;
							aiQuantity = wpsQty;
							session.selectedProduct = undefined;
							console.log(
								`[WhatsApp Agent] Weight+product search: "${wpsProduct}" x${wpsQty} → search_product`,
							);
						}
					}
				}
			}

			// Detección del patrón "[número] [nombre]" sin verbo de acción.
			// Si el nombre coincide con el carrito → edit_cart.
			// Si el nombre no está en la lista activa ni coincide con un índice → search_product.
			if (!intent!) {
				const bareQtyProductMatch = patternText.match(/^(\d{1,4})\s+(.{2,})$/);
				if (bareQtyProductMatch) {
					const bareQty = parseInt(bareQtyProductMatch[1], 10);
					const bareNameRaw = bareQtyProductMatch[2].trim();
					const bareTokens = normalizeText(bareNameRaw)
						.split(/\s+/)
						.filter(w => w.length > 2);
					// Verificar si parece una selección de lista por índice:
					// el número es un índice válido Y el producto en ese índice
					// tiene palabras que coinciden con el texto restante.
					const validIndex =
						bareQty >= 1 && bareQty <= (session.lastProductList?.length ?? 0);
					const indexMatchesName =
						validIndex && session.lastProductList?.[bareQty - 1]
							? bareTokens.some(t =>
									normalizeText(
										session.lastProductList![bareQty - 1].name,
									).includes(t),
								)
							: false;
					if (!indexMatchesName) {
						const matchesCart = (session.cart ?? []).some(item => {
							const fullName = normalizeText(
								item.variantName
									? `${item.productName} ${item.variantName}`
									: item.productName,
							);
							return bareTokens.some(w => fullName.includes(w));
						});
						const matchesActiveList = (session.lastProductList ?? []).some(
							p => {
								const pNorm = normalizeText(p.name);
								return bareTokens.some(w => pNorm.includes(w));
							},
						);
						if (matchesCart && !matchesActiveList) {
							intent = 'edit_cart';
							aiAddProductHint = bareNameRaw;
							aiQuantity = bareQty;
							console.log(
								`[WhatsApp Agent] Bare qty+name (cart): "${bareNameRaw}" x${bareQty} → edit_cart`,
							);
						} else if (!matchesActiveList && bareTokens.length > 0) {
							intent = 'search_product';
							aiSearchQuery = bareNameRaw;
							aiQuantity = bareQty;
							session.selectedProduct = undefined;
							console.log(
								`[WhatsApp Agent] Bare qty+name (new product): "${bareNameRaw}" x${bareQty} → search_product`,
							);
						}
					}
				}
			}

			// Detección determinista: "N de [variante]" cuando hay lista activa con variantes.
			// Cubre el caso en que el cliente ya vio la lista de variantes y responde con
			// cantidad + variante en un solo mensaje (ej: "4 de 20 ml", "2 de 100 gramos").
			// Se ejecuta antes de la IA para evitar que clasifique incorrectamente.
			if (!intent! && hasActiveList) {
				const variantQtyMatch = normalizedText.match(
					/^(\d+)\s+de\s+(?:la\s+de\s+)?(.{2,})$/i,
				);
				if (variantQtyMatch) {
					const vqQty = parseInt(variantQtyMatch[1], 10);
					const vqHint = variantQtyMatch[2].trim();
					const vqHintNorm = normalizeText(vqHint);
					const matchingProducts: Array<{
						index: number;
						variantName: string;
					}> = [];
					for (let pi = 0; pi < (session.lastProductList?.length ?? 0); pi++) {
						const product = session.lastProductList![pi];
						if (product.variants.length <= 1) continue;
						const matchedVariant = product.variants.find(v => {
							const vNorm = normalizeText(v.name);
							return vNorm.includes(vqHintNorm) || vqHintNorm.includes(vNorm);
						});
						if (matchedVariant) {
							matchingProducts.push({
								index: pi + 1,
								variantName: matchedVariant.name,
							});
						}
					}
					if (matchingProducts.length === 1) {
						intent = 'select_product';
						aiSelectionIndexes = [matchingProducts[0].index];
						aiVariantHint = vqHint;
						aiQuantity = vqQty;
						console.log(
							`[WhatsApp Agent] Variant+qty deterministic: "${vqHint}" x${vqQty} → select_product [${matchingProducts[0].index}] (variant: "${matchingProducts[0].variantName}")`,
						);
					} else if (matchingProducts.length > 1 && session.selectedProduct) {
						const selIdx = session.lastProductList?.findIndex(
							p => p.name === session.selectedProduct,
						);
						if (selIdx !== undefined && selIdx >= 0) {
							const match = matchingProducts.find(m => m.index === selIdx + 1);
							if (match) {
								intent = 'select_product';
								aiSelectionIndexes = [match.index];
								aiVariantHint = vqHint;
								aiQuantity = vqQty;
								console.log(
									`[WhatsApp Agent] Variant+qty deterministic (selected product): "${vqHint}" x${vqQty} → select_product [${match.index}] (variant: "${match.variantName}")`,
								);
							}
						}
					}
				}
			}

			if (!intent!) {
				// Pasar siempre la lista activa al clasificador de IA.
				// Cuando hay un producto seleccionado se añade nota para que la IA distinga
				// entre "menciona otro producto de la lista" vs "dice una cantidad".
				try {
					// Suppress active product list when message clearly targets a cart item with an
					// edit verb → prevents AI from picking "select_product" by index
					const suppressActiveList = !!(
						hasActiveList &&
						session.cart?.length &&
						/\b(agrega[r]?|a[nñ]ade[r]?|sum[ae][r]?|quita[r]?|saca[r]?)\b/i.test(
							normalizedText,
						) &&
						session.cart.some(item => {
							const words = normalizeText(item.productName)
								.split(/\s+/)
								.filter(w => w.length > 3);
							return words.some(w => normalizedText.includes(w));
						})
					);

					const activeProductsList =
						hasActiveList && !suppressActiveList
							? (session.lastProductList ?? []).map((p, i) => {
									const variantNames = p.variants
										.map(v => v.name)
										.filter(Boolean);
									const label =
										variantNames.length === 1
											? `${p.name} – ${variantNames[0]}`
											: variantNames.length > 1
												? `${p.name} (variantes: ${variantNames.join(', ')})`
												: p.name;
									return { index: i + 1, label };
								})
							: undefined;

					const aiResult = await this.openai.detectIntentWithAI(
						text,
						hasActiveList && !suppressActiveList,
						activeProductsList,
						session.awaitingMoreProducts,
						session.selectedProduct,
						session.cart,
						session.lastBotMessage,
					);

					// unknown + producto activo → continuar conversación del producto
					// unknown + sin contexto → saludo genérico
					intent =
						aiResult.intent === 'unknown'
							? session.selectedProduct
								? 'product_followup'
								: 'greeting'
							: aiResult.intent;

					aiSearchQuery = aiResult.searchQuery;
					aiSelectionIndexes = aiResult.selectionIndexes;
					aiVariantHint = aiResult.variantHint;
					aiQuantity = aiResult.quantity;
					aiQuantities = aiResult.quantities;
					aiRemoveProductHint = aiResult.removeProductHint;
					aiAddProductHint = aiResult.addProductHint;
					aiCartEdits = aiResult.cartEdits;
					aiProductList = aiResult.productList;
					console.log(
						`[WhatsApp Agent] AI intent: ${aiResult.intent}` +
							(aiSearchQuery ? `, searchQuery: "${aiSearchQuery}"` : '') +
							(aiSelectionIndexes
								? `, selection: [${aiSelectionIndexes}]`
								: '') +
							(aiVariantHint ? `, variantHint: "${aiVariantHint}"` : '') +
							(aiQuantity !== undefined ? `, qty: ${aiQuantity}` : '') +
							(aiAddProductHint ? `, addHint: "${aiAddProductHint}"` : '') +
							(aiRemoveProductHint
								? `, removeHint: "${aiRemoveProductHint}"`
								: '') +
							(aiCartEdits
								? `, cartEdits: ${JSON.stringify(aiCartEdits)}`
								: ''),
					);

					// Si detectó búsqueda nueva → limpiar producto seleccionado
					if (intent === 'search_product') {
						session.selectedProduct = undefined;
					}
				} catch (err) {
					console.warn(
						'[WhatsApp Agent] AI intent detection failed, falling back to rules:',
						err,
					);
					if (effectiveSelectionIndex !== null && hasActiveList) {
						intent = 'select_product';
						aiSelectionIndexes = [effectiveSelectionIndex];
					} else if (session.selectedProduct) {
						intent = 'product_followup';
					} else {
						intent = detectIntent(normalizedText);
					}
				}
			} // end if (!intent!)
		}

		// Reclasificar: edit_cart + addProductHint sin coincidencia en carrito → search_product
		// Ocurre cuando el cliente pide un producto con cantidad pero el carrito está vacío
		// o no tiene ese producto (ej: "Necesito 4 kilos de cera de palma").
		if (
			intent === 'edit_cart' &&
			aiAddProductHint &&
			!session.cart?.some(item => {
				const fullName = normalizeText(
					item.variantName
						? `${item.productName} ${item.variantName}`
						: item.productName,
				);
				const tokens = normalizeText(aiAddProductHint)
					.split(/\s+/)
					.filter(t => t.length > 2);
				return tokens.some(t => fullName.includes(t));
			})
		) {
			console.log(
				`[WhatsApp Agent] Reclassifying edit_cart → search_product: hint "${aiAddProductHint}" not found in cart`,
			);
			intent = 'search_product';
			// Filtrar preposiciones y palabras cortas del hint antes de usarlo como
			// search query, para evitar que "de" contamine el fallback OR en buildProductReply
			const cleanedHint = normalizeText(aiAddProductHint)
				.split(/\s+/)
				.filter(w => w.length > 1)
				.join(' ');
			aiSearchQuery = cleanedHint || undefined;
			session.selectedProduct = undefined;
		}

		// Reclasificar: request_quote sin lista de productos y sin palabras clave de cotización → search_product
		// Ocurre cuando el AI malinterpreta "Necesito X kilos de Y" como solicitud de cotización.
		if (
			intent === 'request_quote' &&
			(!aiProductList || aiProductList.length === 0) &&
			!/cotiz[ao]|cotizaci[oó]n|presupuesto|proforma/i.test(text)
		) {
			console.log(
				'[WhatsApp Agent] Reclassifying request_quote → search_product: no quote keywords detected',
			);
			intent = 'search_product';
			session.selectedProduct = undefined;
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
			aiRemoveProductHint,
			aiAddProductHint,
			aiCartEdits,
			aiProductList,
			isFirstEverInteraction: session.isFirstEverInteraction,
			knownCustomerName: session.knownCustomerName,
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

		// Guardar último mensaje del bot en la sesión para contexto en próximas respuestas
		session.lastBotMessage = replyText;
		await redis.set(
			`session:${phoneNumber}`,
			JSON.stringify(session),
			'EX',
			SESSION_TTL_SECONDS,
		);

		await new Promise(resolve => setTimeout(resolve, REPLY_DELAY_MS));
		await this.sendReply(phoneNumber, botPhoneNumberId, replyText);

		this.logService
			.logMessage({
				phoneNumber,
				botPhoneNumberId,
				direction: 'outbound',
				text: replyText,
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
