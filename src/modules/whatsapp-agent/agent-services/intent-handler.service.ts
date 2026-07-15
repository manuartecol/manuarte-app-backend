import crypto from 'crypto';
import { redis } from '../../../config/redis';
import { OpenAIService, OpenAIProduct } from '../openai.service';
import { PaymentLinkService } from '../payment-link.service';
import { ProductSearchService } from './product-search.service';
import { FlowsService } from './flows.service';
import { CountryContext } from './country.service';
import { WhatsAppLogService } from '../logging/log.service';
import { QuoteService } from '../../quote/service';
import { CustomerService } from '../../customer/service';
import { calculateTotals } from '../../docs/utils';
import {
	formatPrice,
	normalizeText,
	stemTerm,
	SYNONYM_REPLACEMENTS,
	PRODUCT_FAMILY_WORDS,
	normalizeRagQuery,
} from '../utils';
import { SESSION_TTL_SECONDS, MAX_PRODUCT_RESULTS } from '../constants';
import { RagDocService, RagSearchResult } from '../../rag-docs/service';
import {
	ProductListEntry,
	CartItem,
	CartChange,
	CartChangeResult,
	PendingPurchaseFlow,
	PendingPresentationChoice,
	PresentationOption,
	UserSession,
} from '../types';
import { stripCallingCode, isFarewellOnly } from '../helpers/intent-detection';
import {
	buildSelectionReply,
	buildResumptionReply,
	resolveVariant,
	parseVariantWeightGrams,
	detectRequestedWeightGrams,
	resolveVariantByWeight,
	buildOutOfStockResolutionMessage,
	scoreNameMatch,
	allHintWordsMatch,
	fuzzyWordMatch,
	classifyPresentationPreference,
	resolveWeightedPresentation,
	WeightedPresentationResult,
	PRESENTATION_AMBIGUITY_MIN_GRAMS,
} from '../helpers/product-helpers';
import { addToCart } from '../helpers/cart-helpers';

/** Intenciones que representan una interacción productiva (el cliente avanza hacia la
 *  compra): al detectarlas reiniciamos el contador de frustración de la sesión. */
const PRODUCTIVE_INTENTS = new Set([
	'select_product',
	'search_product',
	'edit_cart',
	'multi_product_add',
	'purchase_intent',
	'request_quote',
	'show_cart',
	'affirmation',
]);

/** Etiqueta legible de un ítem del carrito ("Cera de Palma KILO"). */
const cartItemLabel = (item: CartItem): string =>
	item.variantName
		? `${item.productName} ${item.variantName}`
		: item.productName;

/**
 * Palabras de instrucción/relleno que NO cuentan como mención de producto al
 * analizar el mensaje del cliente (guarda anti-arrastre del NLU).
 */
const CART_INSTRUCTION_STOPWORDS = new Set([
	'que',
	'quiero',
	'quita',
	'quitar',
	'quite',
	'quitame',
	'elimina',
	'eliminar',
	'borra',
	'borrar',
	'saca',
	'sacar',
	'retira',
	'retirar',
	'agrega',
	'agregar',
	'agregame',
	'anade',
	'anadir',
	'suma',
	'sumar',
	'pon',
	'ponme',
	'ponga',
	'dame',
	'deme',
	'cambia',
	'cambiar',
	'cambiame',
	'deja',
	'dejar',
	'mejor',
	'solo',
	'sola',
	'sean',
	'sea',
	'son',
	'mas',
	'menos',
	'otro',
	'otra',
	'otros',
	'otras',
	'una',
	'uno',
	'unos',
	'unas',
	'los',
	'las',
	'este',
	'esta',
	'ese',
	'esa',
	'eso',
	'del',
	'para',
	'por',
	'con',
	'sin',
	'favor',
	'porfavor',
	'gracias',
	'listo',
	'vale',
	'total',
	'cantidad',
	'unidad',
	'unidades',
	'pedido',
	'carrito',
	'orden',
	'ahora',
	'tambien',
	'entonces',
]);

/** Palabras significativas del mensaje del cliente (sin instrucciones, números ni relleno). */
const significantTextWords = (normalizedText: string): string[] =>
	normalizedText
		.split(/\s+/)
		.filter(
			w =>
				w.length > 2 && !/^\d+$/.test(w) && !CART_INSTRUCTION_STOPWORDS.has(w),
		);

/** true si alguna palabra del nombre del ítem aparece en el mensaje (exacta o parcial). */
const itemMentionedInText = (textWords: string[], label: string): boolean => {
	const labelWords = normalizeText(label)
		.split(/\s+/)
		.filter(w => w.length > 2 && !/^\d+$/.test(w));
	return labelWords.some(lw => textWords.some(tw => fuzzyWordMatch(tw, lw)));
};

/**
 * Infiere si el cliente está haciendo JABONES o VELAS, mirando el carrito y los
 * últimos mensajes del cliente. Sirve para priorizar productos del uso correcto en
 * categorías que existen para ambos (ej. colorantes "para jabon" vs "para velas").
 * Devuelve undefined si no hay señal clara o hay empate.
 */
const inferCraftContext = (
	session: UserSession,
): 'jabon' | 'vela' | undefined => {
	const text = [
		...(session.cart ?? []).map(i => `${i.productName} ${i.variantName ?? ''}`),
		...(session.conversationHistory ?? [])
			.filter(t => t.role === 'user')
			.slice(-6)
			.map(t => t.text),
	]
		.map(s => normalizeText(s))
		.join(' ');
	const has = (kw: string) => text.includes(kw);
	let jabon = 0;
	let vela = 0;
	if (has('jabon')) jabon += 2; // jabon, jabones, jaboncillo…
	if (has('glicerina')) jabon += 1; // base de glicerina = jabón
	if (has('vela')) vela += 2;
	if (has('pabilo') || has('mecha')) vela += 1;
	if (jabon > vela && jabon > 0) return 'jabon';
	if (vela > jabon && vela > 0) return 'vela';
	return undefined;
};

/** Vocabulario de palabras de productos conocidos (carrito + lista activa). */
const buildProductVocab = (
	cart: CartItem[],
	list?: ProductListEntry[],
): string[] => {
	const vocab: string[] = [];
	for (const item of cart) {
		vocab.push(...normalizeText(cartItemLabel(item)).split(/\s+/));
	}
	for (const entry of list ?? []) {
		vocab.push(...normalizeText(entry.name).split(/\s+/));
	}
	return vocab.filter(w => w.length > 2 && !/^\d+$/.test(w));
};

/** true si la palabra indica un producto: familia ("aceite", "cera"...) o vocabulario conocido. */
const isProductIndicator = (word: string, vocab: string[]): boolean =>
	PRODUCT_FAMILY_WORDS.has(word) ||
	PRODUCT_FAMILY_WORDS.has(stemTerm(word)) ||
	vocab.some(vw => fuzzyWordMatch(vw, word));

/** true si el mensaje nombra algún producto explícitamente (no es solo pronombre/cantidad). */
const textNamesAnyProduct = (textWords: string[], vocab: string[]): boolean =>
	textWords.some(w => isProductIndicator(w, vocab));

/**
 * true si el producto candidato ES el que pidió el cliente: todas las palabras
 * DISTINTIVAS del hint (las que no son de familia como "aceite"/"cera"/"base")
 * deben coincidir en el nombre real, considerando sinónimos de BD
 * ("castor" → "ricino"). Evita aceptar "Aceite Vegetal Aguacate" cuando se
 * pidió "aceite de coco" solo porque comparten la familia.
 */
const matchesRequestedProduct = (hint: string, candidate: string): boolean => {
	const candidateWords = normalizeText(candidate).split(/\s+/);
	const hintWords = normalizeText(hint)
		.split(/\s+/)
		.filter(w => w.length > 2);
	if (hintWords.length === 0) return false;
	const distinctive = hintWords.filter(
		w => !PRODUCT_FAMILY_WORDS.has(w) && !PRODUCT_FAMILY_WORDS.has(stemTerm(w)),
	);
	const significant = distinctive.length > 0 ? distinctive : hintWords;
	return significant.every(hw => {
		const terms = [hw, ...(SYNONYM_REPLACEMENTS[stemTerm(hw)] ?? [])];
		return terms.some(term =>
			candidateWords.some(cw => fuzzyWordMatch(cw, term)),
		);
	});
};

export type IntentContext = {
	session: UserSession;
	phoneNumber: string;
	botPhoneNumberId: string;
	text: string;
	normalizedText: string;
	countryInfo: CountryContext | null;
	isFirstInteraction: boolean;
	hasActiveList: boolean;
	aiSearchQuery?: string;
	aiSelectionIndexes?: number[];
	aiVariantHint?: string;
	aiQuantity?: number;
	aiQuantities?: number[];
	aiProductList?: Array<{
		productHint: string;
		quantity: number;
		variantHint?: string;
	}>;
	aiReasoning?: string; // Razonamiento del modelo sobre qué hacer
	aiChanges?: CartChange[];
	/** true cuando la IA no pudo extraer un slot necesario y conviene pedir una aclaración */
	aiNeedsClarification?: boolean;
	/** true cuando el cliente pide recomendación sobre cuál elegir entre los productos mostrados */
	aiRecommendFromList?: boolean;
	/** Tema canónico de FAQ identificado por el NLU (ej. 'store_location'). El handler lo
	 *  resuelve con un lookup determinístico por título en vez de fiarse del score semántico. */
	aiFaqTopic?: string;
	/** Intención secundaria detectada en el mismo mensaje (multi-intent). El handler primario puede usarla para enriquecer la respuesta. */
	secondaryIntent?: import('../openai.service').NLUIntent;
	isFirstEverInteraction?: boolean;
	knownCustomerName?: string;
	/** true cuando el cliente es nuevo y aún no tenemos su nombre/ciudad: el cierre debe pedirlos. */
	awaitingNameAndCity?: boolean;
};

export class IntentHandlerService {
	constructor(
		private openai: OpenAIService,
		private productSearchService: ProductSearchService,
		private quoteService: QuoteService,
		private paymentLinkService: PaymentLinkService,
		private customerService: CustomerService,
		private logService: WhatsAppLogService,
		private ragDocService: RagDocService,
		private flowsService: FlowsService,
	) {}

	handle = async (intent: string, ctx: IntentContext): Promise<string> => {
		// Si el producto discutido vía RAG no está disponible y el cliente intenta comprarlo,
		// redirigir al handler de afirmación para que informe que no hay stock + alternativas.
		if (
			ctx.session.outOfStockRagProductName &&
			!ctx.session.selectedProduct &&
			(intent === 'affirmation' ||
				intent === 'select_product' ||
				intent === 'product_followup')
		) {
			return this.handleIntentAffirmation(ctx);
		}

		// Si el cliente vuelve a escribir (saludo/retomada) y tiene una cotización
		// reciente sin flujo activo ni carrito, ofrecerle retomar la COMPRA de esa
		// cotización en vez de tratarlo como un inicio en frío (pedir datos de nuevo).
		if (
			(intent === 'greeting' || intent === 'resumption') &&
			ctx.session.lastQuoteId &&
			ctx.session.lastQuoteSerial &&
			!ctx.session.pendingPurchaseFlow &&
			!ctx.session.pendingQuoteFlow &&
			(ctx.session.cart?.length ?? 0) === 0
		) {
			return this.offerQuotePurchaseResumption(ctx);
		}

		// El NLU marcó la consulta como un tema canónico de FAQ (ej. ubicación de la
		// tienda). Ese tema se resuelve en handleIntentGeneralQuestion con un lookup
		// determinístico por título; garantizamos que llegue allí. Es una señal del NLU
		// (no un regex sobre el texto): la decisión de "esto es una pregunta de ubicación"
		// la tomó el clasificador, robusto a verbos y errores de tipeo.
		if (ctx.aiFaqTopic) {
			intent = 'general_question';
		}

		// Si el cliente retoma una interacción productiva (busca, elige, agrega, compra),
		// reiniciamos el contador de frustración: la conversación se reencauzó.
		if (PRODUCTIVE_INTENTS.has(intent) && ctx.session.frustrationCount) {
			ctx.session.frustrationCount = 0;
		}

		if (intent === 'resumption') {
			return this.handleIntentResumption(ctx);
		} else if (intent === 'select_product') {
			return this.handleIntentSelectProduct(ctx);
		} else if (intent === 'search_product') {
			return this.handleIntentSearchProduct(ctx);
		} else if (intent === 'show_more') {
			return this.handleIntentShowMore(ctx);
		} else if (intent === 'objection') {
			return this.handleIntentObjection(ctx);
		} else if (intent === 'affirmation') {
			return this.handleIntentAffirmation(ctx);
		} else if (intent === 'general_question') {
			return this.handleIntentGeneralQuestion(ctx);
		} else if (intent === 'smalltalk') {
			return this.handleIntentSmalltalk(ctx);
		} else if (intent === 'human_handoff') {
			return this.handleIntentHumanHandoff(ctx);
		} else if (intent === 'complaint') {
			return this.handleIntentComplaint(ctx);
		} else if (intent === 'product_followup') {
			return this.handleIntentProductFollowup(ctx);
		} else if (intent === 'edit_cart') {
			return this.handleIntentEditCart(ctx);
		} else if (intent === 'show_cart') {
			return this.handleIntentShowCart(ctx);
		} else if (intent === 'request_quote') {
			return this.handleIntentRequestQuote(ctx);
		} else if (intent === 'multi_product_add') {
			return this.handleIntentMultiProductAdd(ctx);
		} else if (intent === 'purchase_intent') {
			return this.handleIntentPurchaseIntent(ctx);
		} else if (intent === 'farewell') {
			return this.handleIntentFarewell(ctx);
		} else if (intent === 'name_collected') {
			return this.handleIntentNameCollected(ctx);
		} else {
			// Para intents 'greeting' que llegan con historial de sesión y son
			// cierres de conversación ("gracias", "listo gracias", "perfecto gracias"),
			// redirigir a farewell en lugar de responder con bienvenida
			if (ctx.session.lastBotMessage && isFarewellOnly(ctx.normalizedText)) {
				return this.handleIntentFarewell(ctx);
			}
			const afterPurchase =
				Boolean(ctx.session.lastPurchaseAt) &&
				!ctx.session.cart?.length &&
				!ctx.session.pendingPurchaseFlow &&
				!ctx.session.pendingQuoteFlow;
			return this.openai
				.generateReply({
					userMessage: ctx.text,
					isFirstInteraction: ctx.isFirstInteraction,
					isFirstEverInteraction: ctx.isFirstEverInteraction,
					knownCustomerName: ctx.knownCustomerName,
					askNameAndCity: ctx.awaitingNameAndCity,
					lastBotMessage: ctx.session.lastBotMessage,
					conversationHistory: ctx.session.conversationHistory,
					afterPurchase,
				})
				.catch(() => 'Hola, soy Gema 👋 ¿En qué le puedo ayudar?');
		}
	};

	private handleIntentResumption = async (
		ctx: IntentContext,
	): Promise<string> => {
		const { session, text, countryInfo } = ctx;
		const lastProduct = session.lastProductList![0];
		const currency =
			session.lastCountryInfo?.currency ?? countryInfo?.currency ?? 'USD';
		return this.openai
			.generateReply({
				userMessage: text,
				resumptionProduct: lastProduct,
				currency,
			})
			.catch(() => buildResumptionReply(lastProduct));
	};

	/**
	 * El cliente regresa (saludo) tras haber generado una cotización pero sin
	 * compra en curso. En vez de empezar en frío, le recordamos que su cotización
	 * sigue lista y le preguntamos si desea proceder con la compra.
	 * NO dejamos un flujo activo: el ofrecimiento queda como lastBotMessage, así un
	 * "sí"/"voy a comprar" en el siguiente turno se clasifica como purchase_intent
	 * (→ pago con QR), y cualquier otra cosa que pida se atiende con normalidad.
	 */
	private offerQuotePurchaseResumption = async (
		ctx: IntentContext,
	): Promise<string> => {
		const { session } = ctx;
		return this.openai
			.generateReply({
				userMessage: ctx.text,
				intent: 'resume_quote_purchase',
				knownCustomerName: ctx.knownCustomerName,
				lastBotMessage: session.lastBotMessage,
				conversationHistory: session.conversationHistory,
			})
			.catch(
				() =>
					`¡Hola de nuevo! 👋 Su cotización #${session.lastQuoteSerial} sigue lista. ¿Desea proceder con la compra?`,
			);
	};

	private handleIntentSelectProduct = async (
		ctx: IntentContext,
	): Promise<string> => {
		const {
			session,
			phoneNumber,
			text,
			normalizedText,
			countryInfo,
			aiSelectionIndexes,
			aiVariantHint,
			aiQuantity,
			aiQuantities,
		} = ctx;

		// Resolver intención secundaria (multi-intent) una sola vez al inicio del handler
		const secondaryCtx = await this.resolveSecondaryContext(
			ctx.secondaryIntent,
			ctx.text,
		);

		const indexes = aiSelectionIndexes ?? [];
		const selectedItems = indexes
			.map(i => session.lastProductList?.[i - 1])
			.filter((p): p is ProductListEntry => !!p);

		if (selectedItems.length > 0) {
			const currency =
				session.lastCountryInfo?.currency ?? countryInfo?.currency ?? 'USD';

			const firstVariantHint = aiVariantHint;
			const resolvedVariant = resolveVariant(
				selectedItems[0],
				firstVariantHint,
				normalizedText,
			);
			session.selectedProduct = selectedItems[0].name;
			session.selectedVariantName = resolvedVariant?.name;

			const requestedGramsInSelection =
				detectRequestedWeightGrams(normalizedText);

			// Cross-list weight resolution: when a weight is requested and a single product
			// is selected, search all related products in the list for the optimal variant.
			// Example: "dame 4 kilos de la white" → prefer WHITE KILO x4 over WHITE 10 KILOS x1.
			if (requestedGramsInSelection !== null && selectedItems.length === 1) {
				const selectedKeywords = normalizeText(selectedItems[0].name)
					.split(/\s+/)
					.filter(w => w.length > 2);
				type VariantRef = {
					variant: ProductListEntry['variants'][0];
					product: ProductListEntry;
					grams: number;
				};
				const candidatePool: VariantRef[] = [];
				for (const listProduct of session.lastProductList ?? []) {
					const pNorm = normalizeText(listProduct.name);
					if (selectedKeywords.some(kw => pNorm.includes(kw))) {
						for (const v of listProduct.variants) {
							const g = parseVariantWeightGrams(v.name);
							if (g !== null && g > 0) {
								candidatePool.push({
									variant: v,
									product: listProduct,
									grams: g,
								});
							}
						}
					}
				}
				if (candidatePool.length > 0) {
					const exact = candidatePool.filter(
						c => requestedGramsInSelection % c.grams === 0,
					);
					const pool = exact.length > 0 ? exact : candidatePool;
					const best = pool.reduce((a, b) => {
						const uA = Math.ceil(requestedGramsInSelection / a.grams);
						const uB = Math.ceil(requestedGramsInSelection / b.grams);
						return uB < uA ? b : a;
					});
					// Only redirect when a genuinely better product or variant was found
					if (
						best.product.name !== selectedItems[0].name ||
						best.variant.name !== resolvedVariant?.name
					) {
						const units = Math.ceil(requestedGramsInSelection / best.grams);
						const cappedUnits = Math.min(units, best.variant.totalQty);
						const stockExceeded = cappedUnits < units;
						if (!stockExceeded) {
							addToCart(
								session,
								best.product,
								cappedUnits,
								currency,
								best.variant,
							);
						}
						session.selectedProduct = best.product.name;
						session.selectedVariantName = best.variant.name;
						const productForReply = {
							...best.product,
							variants: [best.variant],
						};
						await redis.set(
							`session:${phoneNumber}`,
							JSON.stringify(session),
							'EX',
							SESSION_TTL_SECONDS,
						);
						return this.openai
							.generateReply({
								userMessage: text,
								selectedProduct: productForReply,
								quantity: stockExceeded ? undefined : cappedUnits,
								requestedQuantity: stockExceeded ? units : undefined,
								currency,
								...secondaryCtx,
							})
							.catch(() => buildSelectionReply(productForReply, currency));
					}
				}
			}

			let primaryItemQty: number | undefined;
			let primaryRequestedQty: number | undefined;
			let primaryCappedQty: number | undefined;

			for (let i = 0; i < selectedItems.length; i++) {
				const item = selectedItems[i];
				const itemVariantHint = i === 0 ? aiVariantHint : undefined;
				const itemVariant =
					i === 0
						? resolvedVariant
						: resolveVariant(item, itemVariantHint, normalizedText);
				const itemTotalQty = (
					itemVariant ? [itemVariant] : item.variants
				).reduce((sum, v) => sum + v.totalQty, 0);

				const variantGramsForItem = itemVariant
					? parseVariantWeightGrams(itemVariant.name)
					: null;
				const weightBasedQty =
					requestedGramsInSelection !== null && variantGramsForItem !== null
						? Math.ceil(requestedGramsInSelection / variantGramsForItem)
						: undefined;

				const itemQty =
					weightBasedQty ??
					aiQuantities?.[i] ??
					aiQuantity ??
					(itemTotalQty === 1 ? 1 : undefined);

				const cappedQty =
					itemQty !== undefined ? Math.min(itemQty, itemTotalQty) : undefined;
				const stockExceededForItem =
					itemQty !== undefined &&
					cappedQty !== undefined &&
					cappedQty < itemQty;

				if (i === 0) {
					primaryCappedQty = cappedQty;
					primaryItemQty = stockExceededForItem ? undefined : cappedQty;
					primaryRequestedQty = stockExceededForItem ? itemQty : undefined;
					// Stock insuficiente: no agregamos; dejamos el pendiente para que un "sí"
					// del cliente agregue la cantidad disponible.
					if (stockExceededForItem && cappedQty) {
						session.pendingStockConfirmQty = cappedQty;
					}
				}
				if (cappedQty && !stockExceededForItem) {
					addToCart(session, item, cappedQty, currency, itemVariant);
				}
			}

			await redis.set(
				`session:${phoneNumber}`,
				JSON.stringify(session),
				'EX',
				SESSION_TTL_SECONDS,
			);
			const selectedProductForReply = resolvedVariant
				? { ...selectedItems[0], variants: [resolvedVariant] }
				: selectedItems[0];

			const resolvedSelectedItems =
				selectedItems.length > 1
					? selectedItems.map((item, i) => {
							const hint = i === 0 ? aiVariantHint : undefined;
							const v =
								i === 0
									? resolvedVariant
									: resolveVariant(item, hint, normalizedText);
							return v ? { ...item, variants: [v] } : item;
						})
					: undefined;

			// Stock insuficiente en el ítem principal → no confirmar cantidad; pedir que
			// confirme si quiere la cantidad disponible (stockOnlyAvailable), sin `quantity`.
			const stockShort = primaryRequestedQty !== undefined;
			return this.openai
				.generateReply({
					userMessage: text,
					selectedProduct: selectedProductForReply,
					selectedProducts: resolvedSelectedItems,
					quantity:
						aiQuantities || stockShort
							? undefined
							: (primaryItemQty ?? primaryCappedQty),
					requestedQuantity: primaryRequestedQty,
					stockOnlyAvailable: stockShort ? primaryCappedQty : undefined,
					currency,
					...secondaryCtx,
				})
				.catch(() => buildSelectionReply(selectedProductForReply, currency));
		} else {
			const count = session.lastProductList!.length;
			return `Solo tengo ${count} opción${count !== 1 ? 'es' : ''} en la lista. Dígame un número del 1 al ${count}.`;
		}
	};

	private handleIntentSearchProduct = async (
		ctx: IntentContext,
	): Promise<string> => {
		const {
			session,
			phoneNumber,
			botPhoneNumberId,
			text,
			normalizedText,
			countryInfo,
			isFirstInteraction,
			aiSearchQuery,
			aiQuantity,
			aiVariantHint,
		} = ctx;
		const countryPrefix = phoneNumber.replace(/\d+$/, '');

		const secondaryCtx = await this.resolveSecondaryContext(
			ctx.secondaryIntent,
			ctx.text,
		);

		session.selectedProduct = undefined;
		session.outOfStockRagProductName = undefined;
		const result = await this.productSearchService.buildProductReply(
			normalizedText,
			countryInfo,
			aiSearchQuery,
			inferCraftContext(session),
		);
		console.log(
			`[WhatsApp Agent] Search "${aiSearchQuery ?? normalizedText}" → found=${result.productFound} products=${result.products.length} outOfStock=${result.outOfStockProductName ?? 'none'} suggestions=${result.remainingProducts.length} country=${countryInfo?.currency ?? 'none'} stockIds=${JSON.stringify(countryInfo?.stockIds ?? [])}`,
		);
		session.lastProductList = result.products;
		session.remainingProductList = result.remainingProducts;
		session.awaitingMoreProducts = result.remainingProducts.length > 0;
		session.lastSearchQuery = aiSearchQuery ?? normalizedText;
		session.lastCountryInfo = countryInfo;

		const currency = countryInfo?.currency ?? 'USD';

		let autoAddedProduct: ProductListEntry | undefined;
		let autoAddedQty: number | undefined;
		let autoAddedVariant: ProductListEntry['variants'][0] | undefined;
		let autoAddedRequestedQty: number | undefined;
		let autoAddedStockExceededNote: string | undefined;

		// Usar el producto con mayor score (primero en la lista, ya ordenada por relevancia+stock).
		// Cuando hay varios resultados para la misma búsqueda (ej: "cera de palma" devuelve
		// "Cera de Palma / de Vaso" y "Cera de palma para Moldes - APF"), se toma el primero.
		const requestedGramsFromText = detectRequestedWeightGrams(normalizedText);
		const requestedGramsFromHint = aiVariantHint
			? detectRequestedWeightGrams(aiVariantHint)
			: null;
		const requestedGramsForAutoAdd =
			requestedGramsFromText ?? requestedGramsFromHint;

		if (
			(aiQuantity !== undefined || requestedGramsForAutoAdd !== null) &&
			result.products.length >= 1 &&
			result.productFound
		) {
			// Con variantHint no-peso (ej. "bloque", "rosado"): preferir el producto cuya
			// variante realmente lo cumple, no siempre products[0]. Ej: "bloque de tr" trae
			// TR-transparente y Triple Butter; ambos tienen bloque, pero si el primero NO
			// tuviera esa presentación, saltamos al que sí. Evita agregar la variante
			// equivocada de un producto que no tiene lo pedido.
			let product = result.products[0];
			if (aiVariantHint && requestedGramsForAutoAdd === null) {
				const hintNorm = normalizeText(aiVariantHint);
				const satisfiesHint = (p: ProductListEntry) =>
					p.variants.some(v => {
						const vn = normalizeText(v.name);
						return (
							vn.length > 0 &&
							(vn.includes(hintNorm) || hintNorm.includes(vn))
						);
					});
				if (!satisfiesHint(product)) {
					const better = result.products.find(satisfiesHint);
					if (better) product = better;
				}
			}
			const requestedGrams = requestedGramsForAutoAdd;

			if (requestedGrams !== null) {
				// Presentación dual (por KILO + bloque/caja): si el cliente no especifica
				// forma y el peso es ambiguo (≥ umbral), preguntar en vez de asumir.
				const pref = classifyPresentationPreference(
					aiVariantHint ?? normalizedText,
				);
				const wp = resolveWeightedPresentation(
					product.variants,
					requestedGrams,
					pref,
				);
				if (wp.mode === 'ambiguous') {
					return this.askPresentationChoice(
						session,
						phoneNumber,
						product,
						requestedGrams,
						wp,
						currency,
						'add',
					);
				}
				// Presentación a granel pedida (peso ≥ umbral o palabra "bloque/caja")
				// pero sin stock aquí: si existe en catálogo, informar y ofrecer kilos.
				const wantsBulk =
					pref === 'bulk' ||
					requestedGrams >= PRESENTATION_AMBIGUITY_MIN_GRAMS;
				const inStockBulk = product.variants.some(
					v => (parseVariantWeightGrams(v.name) ?? 0) > 1000,
				);
				const kiloVariant = product.variants.find(
					v => parseVariantWeightGrams(v.name) === 1000,
				);
				if (wp.mode === 'none' && wantsBulk && !inStockBulk && kiloVariant) {
					const stockIds =
						countryInfo?.stockIds ?? session.lastCountryInfo?.stockIds ?? [];
					const full =
						await this.productSearchService.getVariantsWithStock(
							product.productId,
							stockIds,
						);
					const bulks = full
						.filter(v => (parseVariantWeightGrams(v.name) ?? 0) > 1000)
						.sort(
							(a, b) =>
								(parseVariantWeightGrams(b.name) ?? 0) -
								(parseVariantWeightGrams(a.name) ?? 0),
						);
					// Preferir la presentación cuyo peso calza con lo pedido (no la más grande)
					const catalogBulk =
						bulks.find(
							v => parseVariantWeightGrams(v.name) === requestedGrams,
						) ?? bulks[0];
					if (catalogBulk) {
						return this.offerKiloForUnavailableBulk(
							session,
							phoneNumber,
							product,
							requestedGrams,
							kiloVariant,
							catalogBulk.name,
							currency,
							'add',
							undefined,
							undefined,
							isFirstInteraction,
						);
					}
				}
				const resolved =
					wp.mode === 'resolved'
						? { variant: wp.variant, units: wp.units }
						: resolveVariantByWeight(product.variants, requestedGrams);
				if (resolved) {
					const cappedUnits = Math.min(
						resolved.units,
						resolved.variant.totalQty,
					);
					const stockExceeded = cappedUnits < resolved.units;
					if (!stockExceeded) {
						addToCart(
							session,
							product,
							cappedUnits,
							currency,
							resolved.variant,
						);
					}
					session.selectedProduct = product.name;
					session.selectedVariantName = resolved.variant.name;
					if (cappedUnits > 0) {
						autoAddedProduct = product;
						autoAddedQty = cappedUnits;
						autoAddedVariant = resolved.variant;
						if (stockExceeded) {
							const variantGrams = parseVariantWeightGrams(
								resolved.variant.name,
							);
							const requestedKg = requestedGrams / 1000;
							const availableGrams =
								variantGrams !== null ? cappedUnits * variantGrams : null;
							const availableKg =
								availableGrams !== null ? availableGrams / 1000 : null;
							const availableLabel =
								availableKg !== null
									? `${availableKg % 1 === 0 ? availableKg : availableKg.toFixed(1)} kg (${cappedUnits} unidades de ${resolved.variant.name})`
									: `${cappedUnits} unidades de ${resolved.variant.name}`;
							const requestedLabel = `${requestedKg % 1 === 0 ? requestedKg : requestedKg.toFixed(1)} kg`;
							autoAddedStockExceededNote = `El cliente pidió ${requestedLabel} pero solo hay ${availableLabel} disponible(s). NO confirmes el pedido ni calcules total. Informa brevemente la cantidad disponible en kg y pregunta si quiere esa cantidad. Varía la frase: "Solo tenemos X kg, ¿las quiere?" u otra variación natural. NUNCA uses frases como "te lo llevo", "te la llevo" ni similares.`;
							session.pendingStockConfirmQty = cappedUnits;
						}
					}
					console.log(
						`[WhatsApp Agent] Auto-added to cart from search (weight): ${product.name} – ${resolved.variant.name} x${cappedUnits} (${requestedGrams}g → ${resolved.units} units, capped: ${cappedUnits})`,
					);
				}
			} else if (product.variants.length === 1 && aiQuantity !== undefined) {
				const variant = product.variants[0];
				const cappedUnits = Math.min(aiQuantity, variant.totalQty);
				const stockExceeded = cappedUnits < aiQuantity;
				if (!stockExceeded) {
					addToCart(session, product, cappedUnits, currency, variant);
				}
				session.selectedProduct = product.name;
				session.selectedVariantName = variant.name;
				if (cappedUnits > 0) {
					autoAddedProduct = product;
					autoAddedQty = cappedUnits;
					autoAddedVariant = variant;
					if (stockExceeded) {
						autoAddedRequestedQty = aiQuantity;
						session.pendingStockConfirmQty = cappedUnits;
					}
				}
				console.log(
					`[WhatsApp Agent] Auto-added to cart from search (single variant): ${product.name} – ${variant.name} x${cappedUnits}`,
				);
			} else if (aiVariantHint && aiQuantity !== undefined) {
				const resolved = resolveVariant(product, aiVariantHint, normalizedText);
				if (resolved) {
					const cappedUnits = Math.min(aiQuantity, resolved.totalQty);
					const stockExceeded = cappedUnits < aiQuantity;
					if (!stockExceeded) {
						addToCart(session, product, cappedUnits, currency, resolved);
					}
					session.selectedProduct = product.name;
					session.selectedVariantName = resolved.name;
					if (cappedUnits > 0) {
						autoAddedProduct = product;
						autoAddedQty = cappedUnits;
						autoAddedVariant = resolved;
						if (stockExceeded) {
							autoAddedRequestedQty = aiQuantity;
							session.pendingStockConfirmQty = cappedUnits;
						}
					}
					console.log(
						`[WhatsApp Agent] Auto-added to cart from search (variant hint "${aiVariantHint}"): ${product.name} – ${resolved.name} x${cappedUnits}`,
					);
				}
			} else if (aiQuantity !== undefined) {
				// Múltiples variantes disponibles SIN que el cliente especifique cuál
				// (ej. Cortador: Liso vs Ondulado; una base sin presentación). NO elegimos
				// por él: dejamos que se muestre el producto con sus variantes para que
				// escoja. Los colores no llegan aquí porque la búsqueda ya filtró a la
				// variante pedida (queda 1 → se agrega directo en la rama de arriba).
				const inStock = product.variants.filter(v => v.totalQty > 0);
				if (inStock.length === 1) {
					// Solo una disponible: agregarla directo (es la única opción real).
					const only = inStock[0];
					const cappedUnits = Math.min(aiQuantity, only.totalQty);
					if (cappedUnits > 0) {
						addToCart(session, product, cappedUnits, currency, only);
						session.selectedProduct = product.name;
						session.selectedVariantName = only.name;
						autoAddedProduct = product;
						autoAddedQty = cappedUnits;
						autoAddedVariant = only;
					}
					console.log(
						`[WhatsApp Agent] Auto-added (única variante disponible): ${product.name} – ${only.name} x${cappedUnits}`,
					);
				} else {
					// 2+ disponibles → mostrar opciones y preguntar (no auto-elegir).
					console.log(
						`[WhatsApp Agent] Product "${product.name}" has ${inStock.length} available variants and no hint → showing options instead of auto-adding.`,
					);
				}
			}
		}

		await redis.set(
			`session:${phoneNumber}`,
			JSON.stringify(session),
			'EX',
			SESSION_TTL_SECONDS,
		);

		// Detect "ya les llegó / ya llegó / volvió a llegar" arrival queries
		const isArrivalQuery =
			/\bya\b.{0,15}\bllego(ron)?\b|\bvolvio\s+a\s+llegar\b/.test(
				ctx.normalizedText,
			);

		let replyText: string;
		if (autoAddedProduct && autoAddedQty !== undefined) {
			const productForReply = autoAddedVariant
				? { ...autoAddedProduct, variants: [autoAddedVariant] }
				: autoAddedProduct;
			const stockExceeded =
				autoAddedStockExceededNote !== undefined ||
				autoAddedRequestedQty !== undefined;
			// Cliente conocido: saludo cálido de apertura ("Sr. X, con gusto"). No pasamos
			// isFirstEverInteraction a propósito: la rama deseada es la de saludo cálido.
			const firstTurnGreetingCtx = {
				isFirstInteraction,
				knownCustomerName: ctx.knownCustomerName,
				askNameAndCity: ctx.awaitingNameAndCity,
				lastBotMessage: session.lastBotMessage,
				conversationHistory: session.conversationHistory,
			};
			if (stockExceeded) {
				// Stock insuficiente: NO se agregó nada. Informar la cantidad disponible y
				// preguntar (sin `quantity` confirmable, que confundía al modelo a "le sumé").
				replyText = await this.openai
					.generateReply({
						userMessage: text,
						selectedProduct: productForReply,
						requestedQuantity: autoAddedRequestedQty,
						stockOnlyAvailable: autoAddedStockExceededNote
							? undefined
							: autoAddedQty,
						stockExceededNote: autoAddedStockExceededNote,
						currency,
						isArrivalQuery,
						...firstTurnGreetingCtx,
						...secondaryCtx,
					})
					.catch(() => result.replyText);
			} else {
				// Add limpio: usar el formato de RESUMEN del pedido (lista + total, apertura
				// variada "Su pedido queda así:") igual que el flujo edit_cart, en vez de la
				// confirmación aislada de una línea ("serían N unidades...").
				const addedLabel = autoAddedVariant?.name
					? `${autoAddedProduct.name} ${autoAddedVariant.name}`
					: autoAddedProduct.name;
				const addedLineTotal = autoAddedVariant?.price
					? ` = ${formatPrice(String(Number(autoAddedVariant.price) * autoAddedQty), currency)}`
					: '';
				replyText = await this.openai
					.generateReply({
						userMessage: text,
						intent: 'edit_cart',
						cart: session.cart,
						currency,
						editOutcomeNotes: [
							`AGREGADO: ${autoAddedQty}x ${addedLabel}${addedLineTotal}`,
						],
						...firstTurnGreetingCtx,
						...secondaryCtx,
					})
					.catch(() => result.replyText);
			}
		} else {
			// No se encontró el producto y tampoco hay sugerencias que ofrecer: dejar que el
			// modelo aclare según el rubro (si es algo ajeno a insumos de velas/jabones y a
			// artículos relacionados con su fabricación, debe decir que no lo maneja).
			const productNotFound =
				!result.productFound &&
				result.products.length === 0 &&
				!result.outOfStockProductName;
			replyText = await this.openai
				.generateReply({
					userMessage: text,
					products: result.products.length > 0 ? result.products : undefined,
					hasMoreProducts: result.remainingProducts.length > 0,
					isFirstInteraction,
					isFirstEverInteraction: ctx.isFirstEverInteraction,
					knownCustomerName: ctx.knownCustomerName,
					askNameAndCity: ctx.awaitingNameAndCity,
					currency,
					outOfStockProductName: result.outOfStockProductName,
					isArrivalQuery,
					productNotFound,
					notFoundTerm: productNotFound
						? (aiSearchQuery ?? text)
						: undefined,
					// Historial: necesario para que el modelo VARÍE la redacción (frase de
					// agotado, introducción de lista, pregunta de cierre) entre turnos.
					lastBotMessage: session.lastBotMessage,
					conversationHistory: session.conversationHistory,
					...secondaryCtx,
				})
				.catch(() => result.replyText);
		}

		try {
			console.log(
				'[WhatsApp Agent] Productos devueltos al cliente:',
				(result.products ?? []).map(p => ({
					id: p.productId,
					nombre: p.name,
					descripcion: p.description,
					variantes: p.variants.map(v => ({
						id: v.variantId,
						nombre: v.name,
						stock: v.totalQty,
						precio: v.price,
					})),
				})),
			);
		} catch (e) {
			console.error('[WhatsApp Agent] Error loggeando productos devueltos:', e);
		}

		this.logService
			.logQuery({
				phoneNumber,
				botPhoneNumberId,
				rawText: text,
				searchTerms: result.searchTerms,
				productFound: result.productFound,
				suggestionsShown: result.suggestionsShown,
				replyText,
				countryPrefix,
			})
			.catch(err => {
				console.error('[WhatsApp Agent] Error saving query log:', err);
				this.logService
					.logError({
						context: 'logQuery',
						error: err,
						phoneNumber,
						rawText: text,
					})
					.catch(e =>
						console.error('[WhatsApp Agent] Failed to save error log:', e),
					);
			});

		return replyText;
	};

	private handleIntentShowMore = async (
		ctx: IntentContext,
	): Promise<string> => {
		const { session, phoneNumber, text, countryInfo } = ctx;
		const currency =
			session.lastCountryInfo?.currency ?? countryInfo?.currency ?? 'USD';

		if (session.awaitingMoreProducts) {
			const nextBatch = (session.remainingProductList ?? []).slice(
				0,
				MAX_PRODUCT_RESULTS,
			);
			const newRemaining = (session.remainingProductList ?? []).slice(
				MAX_PRODUCT_RESULTS,
			);
			session.lastProductList = [
				...(session.lastProductList ?? []),
				...nextBatch,
			];
			session.remainingProductList = newRemaining;
			session.awaitingMoreProducts = newRemaining.length > 0;
			await redis.set(
				`session:${phoneNumber}`,
				JSON.stringify(session),
				'EX',
				SESSION_TTL_SECONDS,
			);
			return this.openai
				.generateReply({
					userMessage: text,
					products: nextBatch,
					hasMoreProducts: newRemaining.length > 0,
					isShowingMore: true,
					currency,
				})
				.catch(() => 'Aquí hay más opciones, dígame cuál le interesa.');
		} else if (session.lastProductList && session.lastProductList.length > 0) {
			// Ya se mostraron TODAS las opciones disponibles y no quedan más. Repetir
			// la misma lista confunde al cliente (cree que no le entendimos); en su
			// lugar le informamos que esos son todos los productos disponibles.
			return this.openai
				.generateReply({
					userMessage: text,
					noMoreProducts: true,
					currency,
					lastBotMessage: session.lastBotMessage,
					conversationHistory: session.conversationHistory,
				})
				.catch(
					() =>
						'Por el momento esos son todos los que tenemos disponibles. ¿Le interesa alguno?',
				);
		} else if (session.lastSearchQuery) {
			session.selectedProduct = undefined;
			const result = await this.productSearchService.buildProductReply(
				normalizeText(session.lastSearchQuery),
				countryInfo ?? session.lastCountryInfo ?? null,
				session.lastSearchQuery,
			);
			session.lastProductList = result.products;
			session.remainingProductList = result.remainingProducts;
			session.awaitingMoreProducts = result.remainingProducts.length > 0;
			session.lastCountryInfo = countryInfo ?? session.lastCountryInfo ?? null;
			await redis.set(
				`session:${phoneNumber}`,
				JSON.stringify(session),
				'EX',
				SESSION_TTL_SECONDS,
			);
			return this.openai
				.generateReply({
					userMessage: text,
					products: result.products.length > 0 ? result.products : undefined,
					hasMoreProducts: result.remainingProducts.length > 0,
					isShowingMore: true,
					currency,
				})
				.catch(() => result.replyText);
		} else {
			return 'No tengo más opciones disponibles en este momento. ¿Puedo ayudarte con otra cosa?';
		}
	};

	private handleIntentObjection = async (
		ctx: IntentContext,
	): Promise<string> => {
		const { session, text, countryInfo } = ctx;
		const currency =
			session.lastCountryInfo?.currency ?? countryInfo?.currency ?? 'USD';
		const selectedProductEntry = session.lastProductList?.find(
			p => p.name === session.selectedProduct,
		);
		return this.openai
			.generateReply({
				userMessage: text,
				intent: 'objection',
				selectedProduct: selectedProductEntry,
				products: session.lastProductList?.length
					? session.lastProductList
					: undefined,
				currency,
			})
			.catch(() => 'Sin problema, aquí estaré cuando lo necesites. 🙌');
	};

	private handleIntentAffirmation = async (
		ctx: IntentContext,
	): Promise<string> => {
		const {
			session,
			phoneNumber,
			text,
			normalizedText,
			countryInfo,
			aiQuantity,
		} = ctx;
		const currency =
			session.lastCountryInfo?.currency ?? countryInfo?.currency ?? 'USD';
		const affirmationProduct = session.selectedProduct
			? session.lastProductList?.find(p => p.name === session.selectedProduct)
			: session.lastProductList?.length === 1
				? session.lastProductList[0]
				: undefined;
		if (affirmationProduct) {
			if (!session.selectedProduct) {
				session.selectedProduct = affirmationProduct.name;
			}
			const sessionVariantAff = session.selectedVariantName
				? affirmationProduct.variants.find(
						v => v.name === session.selectedVariantName,
					)
				: undefined;
			const relevantVariants = sessionVariantAff
				? [sessionVariantAff]
				: affirmationProduct.variants;
			const totalQtyAff = relevantVariants.reduce(
				(sum, v) => sum + v.totalQty,
				0,
			);
			const impliedQty = totalQtyAff === 1 ? 1 : undefined;
			const bareNumberQtyAff = /^\d+$/.test(normalizedText.trim())
				? parseInt(normalizedText.trim(), 10)
				: undefined;
			const inlineQtyMatch = /\b(\d+)\b/.exec(normalizedText);
			const inlineQty = inlineQtyMatch
				? parseInt(inlineQtyMatch[1], 10)
				: undefined;
			const pendingQty = session.pendingStockConfirmQty;
			if (pendingQty !== undefined) session.pendingStockConfirmQty = undefined;
			const effectiveQtyAff =
				aiQuantity ?? bareNumberQtyAff ?? inlineQty ?? impliedQty ?? pendingQty;
			const variantForStock =
				sessionVariantAff ??
				(affirmationProduct.variants.length === 1
					? affirmationProduct.variants[0]
					: undefined);
			const availableStock = variantForStock
				? variantForStock.totalQty
				: totalQtyAff;
			const productForAffReply = sessionVariantAff
				? { ...affirmationProduct, variants: [sessionVariantAff] }
				: affirmationProduct;

			// Pide MÁS de lo disponible → NO agregar; informar y preguntar si quiere lo que
			// hay (igual que select_product/search). Un "sí" posterior lo agrega.
			if (
				effectiveQtyAff !== undefined &&
				availableStock !== undefined &&
				effectiveQtyAff > availableStock &&
				availableStock > 0
			) {
				session.pendingStockConfirmQty = availableStock;
				await redis.set(
					`session:${phoneNumber}`,
					JSON.stringify(session),
					'EX',
					SESSION_TTL_SECONDS,
				);
				return this.openai
					.generateReply({
						userMessage: text,
						selectedProduct: productForAffReply,
						requestedQuantity: effectiveQtyAff,
						stockOnlyAvailable: availableStock,
						lastBotMessage: session.lastBotMessage,
						currency,
					})
					.catch(
						() =>
							`De las ${effectiveQtyAff} que pidió, por ahora solo tenemos ${availableStock}. ¿Le incluyo esas ${availableStock}?`,
					);
			}

			if (effectiveQtyAff) {
				addToCart(
					session,
					affirmationProduct,
					effectiveQtyAff,
					currency,
					sessionVariantAff,
				);
			}
			await redis.set(
				`session:${phoneNumber}`,
				JSON.stringify(session),
				'EX',
				SESSION_TTL_SECONDS,
			);
			return this.openai
				.generateReply({
					userMessage: text,
					selectedProduct: productForAffReply,
					quantity: effectiveQtyAff,
					lastBotMessage: session.lastBotMessage,
					currency,
				})
				.catch(() => 'Claro, ¿en qué le puedo ayudar?');
		} else {
			return this.openai
				.generateReply({
					userMessage: text,
					intent: 'affirmation',
					lastBotMessage: session.lastBotMessage,
					products: session.lastProductList?.length
						? session.lastProductList
						: undefined,
					outOfStockProductName: session.outOfStockRagProductName,
					currency,
				})
				.catch(() => 'Claro, ¿en qué le puedo ayudar?');
		}
	};

	/**
	 * Extrae palabras clave de producto del texto del usuario para el fallback de búsqueda
	 * por título. Busca el primer término específico (longitud > 3, no en PRODUCT_FAMILY_WORDS)
	 * que siga a una palabra de categoría (aceite, cera, etc.), saltando preposiciones cortas.
	 * Ejemplo: "aceite de aguacate" → ["aguacate"]
	 */
	private extractProductTitleKeywords = (text: string): string[] => {
		const words = normalizeText(text).split(/\s+/);
		const keywords: string[] = [];
		for (let i = 0; i < words.length - 1; i++) {
			if (PRODUCT_FAMILY_WORDS.has(words[i])) {
				for (let j = i + 1; j <= Math.min(i + 3, words.length - 1); j++) {
					if (words[j].length > 3 && !PRODUCT_FAMILY_WORDS.has(words[j])) {
						keywords.push(words[j]);
						break;
					}
				}
			}
		}
		return [...new Set(keywords)];
	};

	/**
	 * Preguntas conversacionales/meta que NO son sobre productos, cotizaciones ni
	 * compras (identidad del bot, por qué dijo algo, capacidades, charla casual).
	 * Se delega por completo al modelo usando el system prompt principal y el
	 * historial: nada de búsqueda de producto ni RAG, así la respuesta es coherente.
	 */
	private handleIntentSmalltalk = async (
		ctx: IntentContext,
	): Promise<string> => {
		const { text, session, knownCustomerName } = ctx;
		return this.openai
			.generateReply({
				userMessage: text,
				intent: 'smalltalk',
				knownCustomerName,
				// Primer mensaje (ej. "¿esto es Manuarte?"): saludar cordialmente al inicio.
				isFirstInteraction: ctx.isFirstInteraction,
				isFirstEverInteraction: ctx.isFirstEverInteraction,
				askNameAndCity: ctx.awaitingNameAndCity,
				lastBotMessage: session.lastBotMessage,
				conversationHistory: session.conversationHistory,
			})
			.catch(() => 'Soy Gema, asesora de Manuarte 💛 ¿En qué le puedo ayudar?');
	};

	/**
	 * El cliente pide hablar con una persona, expresa insatisfacción con el servicio o
	 * tiene un reclamo. Por ahora solo respondemos con empatía y confirmamos que alguien
	 * del equipo lo atenderá (la lógica real de transferencia se agregará luego). Nunca
	 * se le ofrecen productos ni recetas aquí: es un momento sensible de atención.
	 */
	private handleIntentHumanHandoff = async (
		ctx: IntentContext,
	): Promise<string> => {
		const { text, session, knownCustomerName } = ctx;
		return this.openai
			.generateReply({
				userMessage: text,
				intent: 'human_handoff',
				knownCustomerName,
				lastBotMessage: session.lastBotMessage,
				conversationHistory: session.conversationHistory,
			})
			.catch(
				() =>
					'Con gusto le comunico con una persona del equipo. Enseguida alguien lo atiende por aquí. 🙌',
			);
	};

	/** A partir de esta cantidad de señales de frustración en la sesión, la respuesta
	 *  al reclamo ofrece transferir con una persona del equipo en vez de seguir intentando. */
	private FRUSTRATION_HANDOFF_THRESHOLD = 3;

	/**
	 * El cliente expresa una queja/frustración con la atención (sin pedir un humano
	 * explícitamente). Primero intentamos ayudarlo nosotros; solo tras varias señales
	 * de frustración (FRUSTRATION_HANDOFF_THRESHOLD) ofrecemos pasarlo con una persona.
	 */
	private handleIntentComplaint = async (
		ctx: IntentContext,
	): Promise<string> => {
		const { text, session, phoneNumber, knownCustomerName } = ctx;
		session.frustrationCount = (session.frustrationCount ?? 0) + 1;
		const escalateToHuman =
			session.frustrationCount >= this.FRUSTRATION_HANDOFF_THRESHOLD;
		await redis.set(
			`session:${phoneNumber}`,
			JSON.stringify(session),
			'EX',
			SESSION_TTL_SECONDS,
		);
		return this.openai
			.generateReply({
				userMessage: text,
				intent: 'complaint',
				escalateToHuman,
				knownCustomerName,
				lastBotMessage: session.lastBotMessage,
				conversationHistory: session.conversationHistory,
			})
			.catch(() =>
				escalateToHuman
					? 'Lamento mucho la molestia. Con gusto lo comunico con una persona del equipo para atenderlo mejor. 🙌'
					: 'Lamento que se sienta así. Cuénteme qué necesita y con gusto le ayudo a resolverlo.',
			);
	};

	/** Margen de score coseno bajo el cual dos FAQ se consideran "empatadas". */
	private FAQ_AMBIGUITY_MARGIN = 0.05;

	/**
	 * Detecta si los resultados FAQ son ambiguos: varias FAQ hermanas con score
	 * dentro de un margen pequeño del top que comparten un token de familia (ej.
	 * "velas"). Devuelve las etiquetas limpias de las opciones a distinguir, o
	 * null si hay un ganador claro o no pertenecen a la misma familia.
	 */
	private detectAmbiguousFaqOptions = (
		ragResults: Array<{ type: string; title: string; score: number }>,
	): string[] | null => {
		if (ragResults.length < 2 || ragResults[0].type !== 'faq') return null;

		const topScore = ragResults[0].score;
		const candidates = ragResults.filter(
			r => r.type === 'faq' && topScore - r.score <= this.FAQ_AMBIGUITY_MARGIN,
		);
		if (candidates.length < 2) return null;

		const STOPWORDS = new Set([
			'como',
			'cual',
			'cuales',
			'que',
			'los',
			'las',
			'del',
			'una',
			'uno',
			'para',
			'hacer',
			'hace',
			'hacen',
			'donde',
			'cuando',
			'porque',
			'por',
			'mas',
			'puedo',
			'puede',
			'necesito',
			'quiero',
			'tengo',
			'sobre',
			'este',
			'esta',
			'con',
		]);
		const tokenize = (title: string): Set<string> =>
			new Set(
				normalizeText(title.replace(/^faq\s*[-–]\s*/i, ''))
					.split(/\s+/)
					.filter(w => w.length > 3 && !STOPWORDS.has(w)),
			);

		const tokenSets = candidates.map(c => tokenize(c.title));
		// Token de familia: presente en TODOS los candidatos.
		const shared = [...tokenSets[0]].filter(tok =>
			tokenSets.every(s => s.has(tok)),
		);
		if (shared.length === 0) return null;

		return candidates.map(c =>
			c.title
				.replace(/^FAQ\s*[-–]\s*/i, '')
				.replace(/[¿?]/g, '')
				.trim(),
		);
	};

	private handleIntentGeneralQuestion = async (
		ctx: IntentContext,
	): Promise<string> => {
		const { text, isFirstInteraction, session, countryInfo, aiSearchQuery } =
			ctx;

		// Recomendación entre los productos ya mostrados ("¿cuál me recomienda?"):
		// recomendar UNO de la lista activa. Se hace ANTES del RAG para que una FAQ
		// tangencial (rendimiento, moldes…) no secuestre la respuesta.
		if (
			ctx.aiRecommendFromList &&
			session.lastProductList &&
			session.lastProductList.length > 0
		) {
			const currency =
				countryInfo?.currency ?? session.lastCountryInfo?.currency ?? 'USD';
			return this.openai
				.generateReply({
					userMessage: text,
					intent: 'recommend_from_list',
					recommendationOptions: session.lastProductList,
					currency,
					lastBotMessage: session.lastBotMessage,
					conversationHistory: session.conversationHistory,
				})
				.catch(
					() =>
						'De estas opciones, le recomendaría la base de glicerina transparente por su versatilidad. ¿Se la incluyo?',
				);
		}

		// Detectar si el usuario está preguntando por un producto distinto al contexto de sesión.
		// Si el mensaje menciona una palabra de categoría (aceite, cera…) junto a un cualificador
		// específico que NO aparece en lastRagDocTitle, se excluye el contexto de sesión para
		// evitar que el embedding quede sesgado hacia el producto anterior.
		let includeSessionContext = Boolean(session.lastRagDocTitle);
		if (includeSessionContext && session.lastRagDocTitle) {
			const lastDocNorm = normalizeText(session.lastRagDocTitle);
			const normalizedUserText = normalizeText(text);
			if (
				normalizedUserText.split(/\s+/).some(w => PRODUCT_FAMILY_WORDS.has(w))
			) {
				const lastDocSpecific = lastDocNorm
					.split(/\s+/)
					.filter(
						w =>
							w.length > 3 &&
							!PRODUCT_FAMILY_WORDS.has(w) &&
							!/^[a-z]{1,2}$/.test(w),
					);
				if (lastDocSpecific.length > 0) {
					const userMentionsLastProduct = lastDocSpecific.some(w =>
						normalizedUserText.includes(w),
					);
					if (!userMentionsLastProduct) {
						includeSessionContext = false;
						console.log(
							`[RAG] Product switch detected — dropping session context for query: "${text}"`,
						);
					}
				}
			}
		}

		// Construir ragQuery: si hay contexto de sesión válido (mismo producto), enriquecer
		// la búsqueda para resolver follow-ups cortos ("¿Qué certificaciones tiene?").
		// Si se detectó cambio de producto, usar solo el texto del usuario.
		const contextParts = includeSessionContext
			? [
					session.lastRagDocTitle,
					session.lastSearchQuery,
					session.lastBotMessage?.slice(0, 150),
				].filter((s): s is string => Boolean(s))
			: [];
		const normalizedText = normalizeRagQuery(text);
		// Si el clasificador resolvió el follow-up a una consulta concreta, usarla directo (sin ruido de contexto)
		const ragQuery = aiSearchQuery
			? normalizeRagQuery(aiSearchQuery)
			: contextParts.length > 0
				? `${contextParts.join(' ')} ${normalizedText}`
				: normalizedText;

		let ragContext: string | undefined;
		let ragType: 'faq' | 'datasheet' | undefined;
		let isFirstRagMention = false;
		let ragBaseTitle = '';
		// Umbral relajado para general_question: el intent classifier ya certificó que
		// la pregunta es FAQ/política, no búsqueda de producto. Un umbral más bajo (0.50)
		// cubre variaciones de vocabulario (ej: "empresas de mensajería" ≈ "transportadoras")
		// sin riesgo de falsos positivos en búsqueda de catálogo.
		const RAG_FAQ_THRESHOLD = 0.5;
		try {
			let ragResults: RagSearchResult[] = [];

			// El NLU marcó esta consulta como un tema canónico de FAQ. La recuperación
			// semántica es demasiado inestable para estos FAQ (el embedding es el centroide
			// de la pregunta + paráfrasis, y "dirección"/"tienda" empujan a FAQ vecinas), así
			// que la resolvemos por título — determinístico y confiable. La DECISIÓN de que
			// esto es una pregunta de ubicación la tomó el clasificador NLU, no el código.
			if (ctx.aiFaqTopic === 'store_location') {
				// El país sale del prefijo telefónico (igual que moneda y pagos), no del texto:
				// Ecuador → sede de Quito; Colombia (o país desconocido) → sede de Barranquilla.
				const isoCode =
					countryInfo?.isoCode ?? session.lastCountryInfo?.isoCode;
				const countryKeyword = isoCode === 'EC' ? 'ecuador' : 'colombia';
				const addressFaq = await this.ragDocService.searchByTitle([
					'ubicada',
					countryKeyword,
				]);
				if (addressFaq.length > 0) {
					console.log(
						`[RAG] NLU faqTopic=store_location — resolved address FAQ by title (${countryKeyword}): "${addressFaq[0].title}"`,
					);
					ragResults = addressFaq;
				}
			}

			if (ragResults.length === 0) {
				ragResults = await this.ragDocService.search(
					ragQuery,
					undefined,
					RAG_FAQ_THRESHOLD,
				);
			}

			// Si la búsqueda con contexto no retorna resultados y el ragQuery fue enriquecido,
			// reintentar con solo el texto del usuario. Esto cubre preguntas FAQ/generales en
			// sesiones donde lastRagDocTitle/lastBotMessage diluyeron el embedding.
			if (ragResults.length === 0 && ragQuery !== normalizedText) {
				console.log(
					`[RAG] Retrying with plain normalized text: "${normalizedText}"`,
				);
				ragResults = await this.ragDocService.search(
					normalizedText,
					undefined,
					RAG_FAQ_THRESHOLD,
				);
			}

			// Fallback FAQ-only con umbral relajado (0.38): seguro aquí porque el intent
			// classifier ya descartó que sea búsqueda de producto. Cubre variaciones de
			// vocabulario no capturadas por las paráfrasis (ej: "transportadoras" ≈ "mensajería").
			if (ragResults.length === 0) {
				console.log(
					`[RAG] Retrying FAQ-only search with relaxed threshold: "${normalizedText}"`,
				);
				ragResults = await this.ragDocService.searchFaqs(normalizedText);
			}

			// Si la búsqueda semántica no retorna resultados, intentar fallback por título.
			// Cubre documentos cuyo contenido está en otro idioma (ej: ficha técnica en inglés).
			if (ragResults.length === 0) {
				const titleKeywords = this.extractProductTitleKeywords(text);
				if (titleKeywords.length > 0) {
					ragResults = await this.ragDocService.searchByTitle(titleKeywords);
				}
			}

			// Guard anti-falso-positivo: si el cliente nombró un producto ESPECÍFICO
			// (palabra de familia + un calificador distintivo, ej. "aceite de RICINO"),
			// descartar cualquier documento RAG cuyo título NO contenga ese calificador.
			// La similitud coseno puede traer la ficha/FAQ de OTRO producto de la misma
			// familia por encima del umbral (ej. "ricino" → ficha de "romero", o "castor"
			// → FAQ "cera de arena"), lo que produce una respuesta segura pero EQUIVOCADA.
			// Sin documento, el modelo responde con conocimiento general, que es lo correcto
			// cuando no tenemos ficha del producto pedido.
			if (ragResults.length > 0) {
				const userWords = normalizeText(text).split(/\s+/);
				const userNamesProduct = userWords.some(w =>
					PRODUCT_FAMILY_WORDS.has(w),
				);
				const userQualifiers = userWords.filter(
					w => w.length > 3 && !PRODUCT_FAMILY_WORDS.has(w),
				);
				if (userNamesProduct && userQualifiers.length > 0) {
					const titleNorm = normalizeText(ragResults[0].title);
					const titleHasQualifier = userQualifiers.some(w =>
						titleNorm.includes(w),
					);
					if (!titleHasQualifier) {
						console.log(
							`[RAG] Discarding unrelated doc "${ragResults[0].title}" — user named a specific product (${userQualifiers.join(', ')}) not present in the doc title`,
						);
						ragResults = [];
					}
				}
			}

			// Cuando la búsqueda con contexto devuelve un DATASHEET pero el mensaje actual no
			// menciona palabras específicas del título de ese documento, es probable que el
			// resultado sea un falso positivo por contaminación del ragQuery con el contexto
			// del producto anterior (ej: sesión sobre aceite de ricino → cliente pregunta
			// "¿dónde están ubicados?" → RAG devuelve la ficha del ricino).
			// En ese caso buscar FAQs con el texto limpio y preferirlas si tienen mayor score.
			if (
				ragResults.length > 0 &&
				ragResults[0].type === 'datasheet' &&
				ragQuery !== normalizedText
			) {
				const datasheetTitleNorm = normalizeText(ragResults[0].title);
				const titleSpecificWords = datasheetTitleNorm
					.split(/\s+/)
					.filter(w => w.length > 3 && !PRODUCT_FAMILY_WORDS.has(w));
				const userTextNorm = normalizeText(text);
				const userRelatedToDatasheet = titleSpecificWords.some(w =>
					userTextNorm.includes(w),
				);
				if (!userRelatedToDatasheet) {
					try {
						const faqOverride =
							await this.ragDocService.searchFaqs(normalizedText);
						if (faqOverride.length > 0) {
							// When the datasheet is context-polluted and user isn't asking about
							// that product, always prefer any FAQ over the datasheet (don't compare
							// scores — a low-score FAQ is still more relevant than an unrelated datasheet).
							console.log(
								`[RAG] Context-polluted datasheet replaced by FAQ: "${faqOverride[0].title}" (score: ${faqOverride[0].score.toFixed(3)})`,
							);
							ragResults = faqOverride;
						} else {
							// No FAQ found — clear the polluted result so model doesn't hallucinate
							console.log(
								`[RAG] Context-polluted datasheet cleared; no FAQ found for "${normalizedText}"`,
							);
							ragResults = [];
						}
					} catch {
						ragResults = [];
					}
				}
			}

			// Filtro de dominancia FAQ: si la consulta empata con varias FAQ hermanas
			// (ej. "necesito hacer velas" → arena, gel, molde…), preguntar para aclarar
			// en vez de adivinar una variante. No setear lastRagDocTitle ni hacer el DB
			// lookup, para no contaminar el contexto del siguiente turno.
			const faqOptions = this.detectAmbiguousFaqOptions(ragResults);
			if (faqOptions) {
				console.log(
					`[RAG] Close FAQ matches for "${text}" → letting model answer-or-clarify among: ${faqOptions.join(' | ')}`,
				);
				// En vez de FORZAR una pregunta de aclaración, le damos al modelo el contenido
				// de las FAQ candidatas y dejamos que él decida: si la pregunta mapea claramente
				// a una, la responde; si es genuinamente ambigua, pide que precisen. Esto evita
				// pedir aclaraciones innecesarias en preguntas específicas (ej. "¿cuántas velas
				// con 1 kilo?") sin perder la aclaración en consultas vagas (ej. "necesito hacer velas").
				const ambiguousFaqContext = this.ragDocService.formatContext(
					ragResults.filter(r => r.type === 'faq').slice(0, 3),
				);
				return this.openai
					.generateReply({
						userMessage: text,
						intent: 'general_question',
						faqClarificationOptions: faqOptions,
						ragContext: ambiguousFaqContext,
						lastBotMessage: session.lastBotMessage,
						conversationHistory: session.conversationHistory,
					})
					.catch(
						() =>
							'¿Me cuenta un poco más sobre lo que necesita para orientarle mejor?',
					);
			}

			if (ragResults.length > 0) {
				const isFaqResult = ragResults[0].type === 'faq';
				// Para FAQ con ganador claro, usar SOLO la FAQ top: evita que el modelo
				// mezcle varias FAQ distintas. Las datasheets mantienen el top-K.
				const contextResults = isFaqResult ? [ragResults[0]] : ragResults;
				ragContext = this.ragDocService.formatContext(contextResults);
				ragType = ragResults[0].type as 'faq' | 'datasheet';
				// Detectar si es la primera vez que el bot usa esta ficha en la conversación
				ragBaseTitle =
					(ragResults[0] as { title?: string }).title?.replace(
						/ \[\d+\/\d+\]$/,
						'',
					) ?? '';
				// Verificar si el producto ya fue mencionado en el último mensaje del bot.
				// Cubre el caso donde el primer turno no encontró RAG (sin datos), pero el bot
				// respondió con conocimiento general mencionando el nombre del producto. En ese
				// caso lastRagDocTitle quedó vacío, pero el producto ya es conocido en la conv.
				const alreadyMentionedInLastMessage =
					Boolean(ragBaseTitle) &&
					Boolean(session.lastBotMessage) &&
					ragBaseTitle
						.split(/\s+/)
						.filter(w => w.length > 4)
						.some(w =>
							session.lastBotMessage!.toLowerCase().includes(w.toLowerCase()),
						);
				isFirstRagMention =
					Boolean(ragBaseTitle) &&
					ragBaseTitle !== session.lastRagDocTitle &&
					!alreadyMentionedInLastMessage;
				if (ragBaseTitle) session.lastRagDocTitle = ragBaseTitle;

				// Para resultados FAQ: forzar la plantilla sin preguntas de cierre (isFirstRagMention=false
				// activa "PROHIBIDO ABSOLUTO: No añadas ninguna pregunta al final"), y limpiar la lista
				// de productos obsoleta para que un "Sí" posterior no dispare productos no relacionados.
				if (ragResults[0].type === 'faq') {
					isFirstRagMention = false;
					if (!session.cart?.length) {
						session.lastProductList = undefined;
					}
				}
			}
		} catch (err) {
			console.error('[RAG] Error searching documents:', err);
		}

		// Limpiar el título del documento RAG (ej: "F.T. ACEITE ESENCIAL... MFM", "...MMTRR") para
		// obtener un nombre de producto usable en la búsqueda de BD.
		// El regex acepta hasta 10 letras para cubrir brand codes largos como "MMTRR" (5 letras).
		const cleanRagProductName = ragBaseTitle
			.replace(/^F\.T\.\s*/i, '')
			.replace(/\s+[A-Z]{2,10}$/, '')
			.trim();
		const ragProductToSearch = cleanRagProductName || ragBaseTitle;

		// Cuando RAG identifica un producto (DATASHEET), buscarlo también en la base de
		// datos para poblar session.lastProductList y session.selectedProduct. Esto permite
		// que en el siguiente turno ("Sí", "2 de 20 ml", etc.) el bot conozca las variantes
		// y stock disponibles sin necesidad de hacer otra búsqueda.
		// PROHIBIDO para FAQ: el título de una FAQ es una PREGUNTA temática (ej. "¿Qué tipo
		// de moldes debo usar?"), no un producto. Buscarlo en BD contamina la sesión con
		// productos incidentales (ej. moldes) que el cliente no pidió, y un mensaje vago
		// posterior ("dame una lista") terminaría mostrando ese producto. Las FAQ no fijan
		// producto seleccionado.
		if (
			ragType !== 'faq' &&
			ragContext &&
			ragBaseTitle &&
			session.lastSearchQuery !== ragProductToSearch
		) {
			try {
				const dbResult = await this.productSearchService.buildProductReply(
					normalizeText(ragProductToSearch),
					countryInfo,
					ragProductToSearch,
				);
				if (dbResult.products.length > 0) {
					session.lastProductList = dbResult.products;
					session.remainingProductList = dbResult.remainingProducts;
					session.awaitingMoreProducts = dbResult.remainingProducts.length > 0;
					session.lastSearchQuery = ragProductToSearch;
					if (countryInfo) session.lastCountryInfo = countryInfo;
					if (dbResult.products.length === 1) {
						session.selectedProduct = dbResult.products[0].name;
					}
					// Detectar si el producto buscado está sin stock o no aparece entre los resultados.
					// Se guarda en sesión para que el handler de "Sí" lo informe al cliente.
					if (dbResult.outOfStockProductName) {
						session.outOfStockRagProductName = dbResult.outOfStockProductName;
					} else {
						const reqWords = normalizeText(ragProductToSearch)
							.split(/\s+/)
							.filter(w => w.length > 4);
						const exactInList =
							reqWords.length > 0 &&
							dbResult.products.some(p => {
								const pNorm = normalizeText(p.name);
								return reqWords.every(w => pNorm.includes(w));
							});
						session.outOfStockRagProductName = exactInList
							? undefined
							: ragProductToSearch;
					}
					console.log(
						`[RAG] DB product lookup for "${ragProductToSearch}": found ${dbResult.products.length} product(s)` +
							(session.outOfStockRagProductName
								? ` (not available: ${session.outOfStockRagProductName})`
								: ''),
					);
				}
			} catch (err) {
				console.error('[RAG] Error looking up product in DB:', err);
			}
		}

		// Si no hubo ficha/FAQ (ragContext vacío) pero el cliente nombró un producto/ingrediente
		// (palabra de familia: aceite, cera, etc.), permitir responder con conocimiento general
		// en vez de disculparse por falta de información.
		const userNamesProduct = normalizeText(text)
			.split(/\s+/)
			.some(w => PRODUCT_FAMILY_WORDS.has(w));
		const isProductInfoQuestion = !ragContext && userNamesProduct;

		return this.openai
			.generateReply({
				userMessage: text,
				intent: 'general_question',
				isFirstInteraction,
				isFirstEverInteraction: ctx.isFirstEverInteraction,
				knownCustomerName: ctx.knownCustomerName,
				askNameAndCity: ctx.awaitingNameAndCity,
				ragContext,
				ragType,
				lastBotMessage: session.lastBotMessage,
				isFirstRagMention,
				isProductInfoQuestion,
				conversationHistory: session.conversationHistory,
			})
			.catch(
				() =>
					'No pude procesar esa consulta en este momento. ¿Le puedo ayudar con algo más del producto?',
			);
	};

	private handleIntentProductFollowup = async (
		ctx: IntentContext,
	): Promise<string> => {
		const {
			session,
			text,
			normalizedText,
			countryInfo,
			aiQuantity,
			aiVariantHint,
		} = ctx;
		const selectedProductEntry = session.lastProductList?.find(
			p => p.name === session.selectedProduct,
		);
		const currency =
			session.lastCountryInfo?.currency ?? countryInfo?.currency ?? 'USD';
		// Si el cliente expresa un peso (en variantHint o en el texto), resolver la
		// variante por peso y usar las unidades calculadas como cantidad.
		const requestedGramsFollowup =
			detectRequestedWeightGrams(aiVariantHint ?? '') ??
			detectRequestedWeightGrams(normalizedText);
		const weightResolvedFollowup =
			selectedProductEntry && requestedGramsFollowup !== null
				? resolveVariantByWeight(
						selectedProductEntry.variants,
						requestedGramsFollowup,
					)
				: null;

		const sessionVariant = weightResolvedFollowup
			? weightResolvedFollowup.variant
			: selectedProductEntry && session.selectedVariantName
				? selectedProductEntry.variants.find(
						v => v.name === session.selectedVariantName,
					)
				: selectedProductEntry && aiVariantHint
					? (resolveVariant(
							selectedProductEntry,
							aiVariantHint,
							normalizedText,
						) ?? undefined)
					: undefined;
		if (
			selectedProductEntry &&
			sessionVariant &&
			(weightResolvedFollowup || !session.selectedVariantName)
		) {
			session.selectedVariantName = sessionVariant.name;
		}
		const productForReply =
			selectedProductEntry && sessionVariant
				? { ...selectedProductEntry, variants: [sessionVariant] }
				: selectedProductEntry;
		if (selectedProductEntry) {
			const totalQtyFollowup = (
				sessionVariant ? [sessionVariant] : selectedProductEntry.variants
			).reduce((sum, v) => sum + v.totalQty, 0);
			const bareNumberQtyFollowup = /^\d+$/.test(normalizedText.trim())
				? parseInt(normalizedText.trim(), 10)
				: undefined;
			const effectiveQtyFollowup = weightResolvedFollowup
				? weightResolvedFollowup.units * Math.max(1, aiQuantity ?? 1)
				: (aiQuantity ??
					bareNumberQtyFollowup ??
					(totalQtyFollowup === 1 ? 1 : undefined));

			const cappedQtyFollowup =
				effectiveQtyFollowup !== undefined
					? Math.min(effectiveQtyFollowup, totalQtyFollowup)
					: undefined;
			const requestedQtyFollowup =
				effectiveQtyFollowup !== undefined &&
				cappedQtyFollowup !== undefined &&
				cappedQtyFollowup < effectiveQtyFollowup
					? effectiveQtyFollowup
					: undefined;

			if (cappedQtyFollowup && !requestedQtyFollowup) {
				addToCart(
					session,
					selectedProductEntry,
					cappedQtyFollowup,
					currency,
					sessionVariant,
				);
			}
			return this.openai
				.generateReply({
					userMessage: text,
					selectedProduct: productForReply,
					lastBotMessage: session.lastBotMessage,
					quantity: cappedQtyFollowup,
					requestedQuantity: requestedQtyFollowup,
					currency,
				})
				.catch(() => 'Claro, ¿en qué más le puedo ayudar?');
		} else {
			return this.openai
				.generateReply({
					userMessage: text,
					selectedProduct: productForReply,
					lastBotMessage: session.lastBotMessage,
					quantity: aiQuantity,
					currency,
				})
				.catch(() => 'Claro, ¿en qué más le puedo ayudar?');
		}
	};

	private handleIntentEditCart = async (
		ctx: IntentContext,
	): Promise<string> => {
		const { session, text, countryInfo, aiReasoning, aiChanges } = ctx;

		console.log(
			`[WhatsApp Agent] === EDIT_CART HANDLER === reasoning: "${aiReasoning}", changes: ${JSON.stringify(aiChanges)}`,
		);

		const showCartSecondary =
			ctx.secondaryIntent?.intent === 'show_cart'
				? { secondaryQuestion: 'ver el resumen del pedido' }
				: {};
		const currency =
			session.lastCountryInfo?.currency ?? countryInfo?.currency ?? 'USD';

		// Ambigüedad de presentación en una corrección por peso: "que sean 10 kilos"
		// sobre un ítem que se vende por KILO y también en bloque/caja. Si el cliente
		// no especifica la forma y el peso llega al umbral, preguntar en vez de asumir
		// (10 unidades de a kilo ≠ 1 bloque de 10 kilos). Solo el caso 'set' de un
		// único cambio; el resto conserva el comportamiento actual.
		if (aiChanges && aiChanges.length === 1) {
			const ch = aiChanges[0];
			const requestedGrams = ch.weightText
				? detectRequestedWeightGrams(ch.weightText)
				: null;
			const pref = classifyPresentationPreference(
				ch.variant ?? ch.weightText ?? ctx.normalizedText,
			);
			if (
				ch.action === 'set' &&
				!ch.variant &&
				!pref &&
				requestedGrams !== null &&
				requestedGrams >= PRESENTATION_AMBIGUITY_MIN_GRAMS &&
				requestedGrams % 1000 === 0
			) {
				const item = this.resolveCartItem(session.cart ?? [], ch);
				if (item && parseVariantWeightGrams(item.variantName ?? '') === 1000) {
					let productEntry = (session.lastProductList ?? []).find(
						p => normalizeText(p.name) === normalizeText(item.productName),
					);
					// El producto puede no estar en la lista activa (ej. se agregó por peso
					// en un turno anterior): buscarlo en BD para ver todas sus presentaciones.
					if (!productEntry) {
						const search = await this.productSearchService.buildProductReply(
							normalizeText(item.productName),
							countryInfo ?? session.lastCountryInfo ?? null,
							item.productName,
						);
						productEntry =
							search.products.find(
								p => normalizeText(p.name) === normalizeText(item.productName),
							) ?? (search.productFound ? search.products[0] : undefined);
					}
					if (productEntry) {
						const wp = resolveWeightedPresentation(
							productEntry.variants,
							requestedGrams,
						);
						if (wp.mode === 'ambiguous') {
							return this.askPresentationChoice(
								session,
								ctx.phoneNumber,
								productEntry,
								requestedGrams,
								wp,
								currency,
								'edit',
								item.productVariantId,
							);
						}
						// Sin presentación a granel en stock: si existe en catálogo pero está
						// agotada aquí, informar y ofrecer los kilos sueltos.
						const inStockBulk = productEntry.variants.some(
							v => (parseVariantWeightGrams(v.name) ?? 0) > 1000,
						);
						const kiloV = productEntry.variants.find(
							v => parseVariantWeightGrams(v.name) === 1000,
						);
						if (!inStockBulk && kiloV) {
							const stockIds =
								countryInfo?.stockIds ??
								session.lastCountryInfo?.stockIds ??
								[];
							const full =
								await this.productSearchService.getVariantsWithStock(
									productEntry.productId,
									stockIds,
								);
							const catalogBulk = full
								.filter(v => (parseVariantWeightGrams(v.name) ?? 0) > 1000)
								.sort(
									(a, b) =>
										(parseVariantWeightGrams(b.name) ?? 0) -
										(parseVariantWeightGrams(a.name) ?? 0),
								)[0];
							if (catalogBulk) {
								return this.offerKiloForUnavailableBulk(
									session,
									ctx.phoneNumber,
									productEntry,
									requestedGrams,
									kiloV,
									catalogBulk.name,
									currency,
									'edit',
									item.productVariantId,
									undefined,
									ctx.isFirstInteraction,
								);
							}
						}
					}
				}
			}
		}

		// Sin cambios estructurados del NLU → pedir aclaración honesta, nunca adivinar
		if (!aiChanges || aiChanges.length === 0) {
			return this.openai
				.generateReply({
					userMessage: text,
					intent: 'edit_cart',
					cart: session.cart,
					currency,
					editOutcomeNotes: [
						'No se pudo determinar qué cambio quiere hacer el cliente. NO confirmes ninguna actualización: pregunta amablemente qué desea cambiar de su pedido.',
					],
					...showCartSecondary,
				})
				.catch(() => '¿Qué desea cambiar de su pedido?');
		}

		// Snapshot de cantidades ANTES de aplicar, para poder revertir cambios de
		// arrastre (ítems que el NLU tocó pero el mensaje actual no menciona).
		const cartSnapshot = (session.cart ?? []).map(i => ({
			item: i,
			qty: i.quantity,
		}));

		// Aplicar todos los cambios en orden, acumulando el resultado real de cada uno
		const results: CartChangeResult[] = [];
		for (const change of aiChanges) {
			try {
				results.push(
					await this.applyCartChange(
						session,
						change,
						currency,
						countryInfo,
						ctx.normalizedText,
					),
				);
			} catch (err) {
				console.error('[WhatsApp Agent] Error applying cart change:', err);
				results.push({
					change,
					status: 'no_op',
					note: 'error interno al aplicar el cambio',
				});
			}
		}

		// Recuperación de cambios que requieren búsqueda en BD: adds fuera de la
		// lista activa, cambios de presentación y arrastres del NLU detectados
		for (const result of results) {
			if (result.status !== 'needs_search') continue;
			try {
				if (result.mentionMismatch) {
					this.reinterpretMismatchedChange(result, results, session, ctx);
					if (result.status === 'needs_search' && !result.mentionMismatch) {
						await this.recoverNewProductAdd(
							result,
							session,
							currency,
							countryInfo,
						);
					}
				} else if (result.variantSwitch) {
					await this.recoverVariantSwitch(
						result,
						session,
						currency,
						countryInfo,
					);
				} else {
					await this.recoverNewProductAdd(
						result,
						session,
						currency,
						countryInfo,
					);
				}
			} catch (err) {
				console.error('[WhatsApp Agent] Error recovering cart change:', err);
				result.status = 'no_op';
				result.note = 'error interno al aplicar el cambio';
			}
		}

		// Pidió MÁS de lo disponible: NO se agregó; informar y preguntar si quiere lo que
		// hay (un "sí" lo agrega vía pendingStockConfirmQty). Solo si fue el único cambio.
		const ssResult = results.find(r => r.stockShortage);
		if (results.length === 1 && ssResult?.stockShortage) {
			const ss = ssResult.stockShortage;
			session.selectedProduct = ss.product.name;
			session.selectedVariantName = ss.variant.name;
			session.lastProductList = [{ ...ss.product, variants: [ss.variant] }];
			session.pendingStockConfirmQty = ss.available;
			await redis.set(
				`session:${ctx.phoneNumber}`,
				JSON.stringify(session),
				'EX',
				SESSION_TTL_SECONDS,
			);
			return this.openai
				.generateReply({
					userMessage: text,
					selectedProduct: { ...ss.product, variants: [ss.variant] },
					requestedQuantity: ss.requested,
					stockOnlyAvailable: ss.available,
					isFirstInteraction: ctx.isFirstInteraction,
					knownCustomerName: ctx.knownCustomerName,
					conversationHistory: session.conversationHistory,
				})
				.catch(
					() =>
						`De ${ss.product.name} pidió ${ss.requested}, pero por ahora solo tenemos ${ss.available}. ¿Le incluyo esas ${ss.available}?`,
				);
		}

		// Presentación a granel agotada al agregar: ofrecer los kilos (si fue el único cambio).
		const buResult = results.find(r => r.bulkUnavailable);
		if (results.length === 1 && buResult?.bulkUnavailable) {
			const bu = buResult.bulkUnavailable;
			return this.offerKiloForUnavailableBulk(
				session,
				ctx.phoneNumber,
				bu.product,
				bu.requestedGrams,
				bu.kiloVariant,
				bu.bulkName,
				currency,
				'add',
				undefined,
				undefined,
				ctx.isFirstInteraction,
			);
		}

		// Peso ambiguo al agregar (kilos sueltos vs bloque/caja): si fue la única
		// instrucción, preguntar en vez de asumir.
		const pcResult = results.find(r => r.presentationChoice);
		if (results.length === 1 && pcResult?.presentationChoice) {
			const wp = resolveWeightedPresentation(
				pcResult.presentationChoice.product.variants,
				pcResult.presentationChoice.requestedGrams,
			);
			if (wp.mode === 'ambiguous') {
				return this.askPresentationChoice(
					session,
					ctx.phoneNumber,
					pcResult.presentationChoice.product,
					pcResult.presentationChoice.requestedGrams,
					wp,
					currency,
					'add',
				);
			}
		}

		// El cliente pidió un producto nuevo que NO está disponible (agotado / no
		// encontrado). Es la información saliente: informarla y NADA más (sin volcar el
		// pedido). Antes, revertimos cualquier cambio de ARRASTRE que el NLU haya
		// aplicado sobre ítems que el mensaje actual no menciona (ej. re-tocar la white
		// cuando el cliente solo pidió un termómetro).
		const failedNewAdd = results.find(
			r =>
				r.change.action === 'new' &&
				r.change.product &&
				(r.status === 'needs_search' ||
					(r.status === 'no_op' && r.availableStock !== undefined)),
		);
		if (failedNewAdd?.change.product) {
			const textWords = significantTextWords(ctx.normalizedText);
			for (const r of results) {
				if (
					r.status === 'applied' &&
					r.item &&
					!itemMentionedInText(textWords, r.itemLabel ?? cartItemLabel(r.item))
				) {
					const snap = cartSnapshot.find(s => s.item === r.item);
					if (r.removed) {
						if (!session.cart?.includes(r.item)) session.cart?.push(r.item);
						r.item.quantity = snap?.qty ?? r.item.quantity;
					} else if (snap) {
						r.item.quantity = snap.qty;
					}
					r.status = 'no_op';
					r.note = 'cambio de arrastre descartado (el cliente no lo mencionó)';
					console.log(
						`[WhatsApp Agent] edit_cart: reverted phantom change on "${r.itemLabel}" (message didn't mention it)`,
					);
				}
			}
			const stillApplied = results.filter(r => r.status === 'applied').length;
			if (stillApplied === 0) {
				// Redirigir a la búsqueda: informa que no está disponible y, si existen
				// productos del MISMO TIPO con stock (buildSuggestions ya filtra por tipo:
				// otra mecha, otra cera...), los ofrece como alternativas. Si no hay del
				// mismo tipo, la respuesta es solo la aclaración de agotado. Además deja
				// las sugerencias en lastProductList para que "dame la 2" funcione.
				console.log(
					`[WhatsApp Agent] edit_cart: product "${failedNewAdd.change.product}" unavailable and nothing else changed → redirecting to search for same-type alternatives`,
				);
				return this.handleIntentSearchProduct({
					...ctx,
					aiSearchQuery: failedNewAdd.change.product,
				});
			}
		}
		const appliedCount = results.filter(r => r.status === 'applied').length;

		// Reconciliación anti-contradicción: si un "new" quedó como no-encontrado/sin-stock
		// PERO ese producto SÍ está en el carrito (lo agregó otro cambio, o ya estaba), es un
		// duplicado espurio del NLU. Se descarta esa nota para no decir a la vez "agregué X"
		// y "no encontré X".
		const reconciledResults = results.filter(r => {
			const failedNew =
				r.change.action === 'new' &&
				r.change.product &&
				(r.status === 'needs_search' ||
					r.status === 'not_found' ||
					(r.status === 'no_op' && r.availableStock !== undefined));
			if (!failedNew) return true;
			// Match LAXO: "cortador metalico" (con calificativo) vs el ítem real "Cortador
			// Ondulado Acero Inoxidable" comparten la palabra clave "cortador". Basta con que
			// coincidan las palabras principales (score ≥ 0.5) para considerarlo el mismo y no
			// contradecir el resumen con un "no lo encontré".
			const inCart = (session.cart ?? []).some(
				i => scoreNameMatch(r.change.product!, cartItemLabel(i)) >= 0.5,
			);
			if (inCart) {
				console.log(
					`[WhatsApp Agent] edit_cart: dropping spurious "not found" for "${r.change.product}" (matching item already in cart)`,
				);
				return false;
			}
			return true;
		});

		const editOutcomeNotes = reconciledResults.map(r =>
			this.describeCartChangeResult(r),
		);
		console.log(
			`[WhatsApp Agent] edit_cart results: ${JSON.stringify(editOutcomeNotes)}`,
		);

		// Generar respuesta basada en el resultado real de cada cambio
		const editReply = await this.openai
			.generateReply({
				userMessage: text,
				intent: 'edit_cart',
				cart: session.cart,
				currency,
				editOutcomeNotes,
				// Primer mensaje (ej. "dame un bloque de tr" como primer mensaje): saludo de
				// apertura + pedir nombre/ciudad si el cliente es nuevo.
				isFirstInteraction: ctx.isFirstInteraction,
				knownCustomerName: ctx.knownCustomerName,
				askNameAndCity: ctx.awaitingNameAndCity,
				// Pasar el historial para que el modelo VEA cómo confirmó los cambios en
				// turnos anteriores y NO repita siempre la misma fórmula ("Perfecto. Le
				// agregué... Así queda su pedido:").
				conversationHistory: session.conversationHistory,
				...showCartSecondary,
			})
			.catch(() =>
				appliedCount > 0
					? 'Listo, actualicé su pedido. ¿Necesita algo más?'
					: 'No pude aplicar ese cambio. ¿Me confirma qué desea modificar de su pedido?',
			);

		if (session.pendingQuoteFlow?.step === 'awaiting_cart_confirmation') {
			return editReply + '\n\n¿Quiere que le genere la cotización?';
		}
		if (session.pendingQuoteFlow?.step === 'awaiting_confirmation') {
			return this.openai
				.generateReply({
					userMessage: text,
					intent: 'awaiting_confirmation',
					cart: session.cart,
					currency,
					editOutcomeNotes,
					quoteFlowData: session.pendingQuoteFlow.collectedData,
				})
				.catch(() => editReply);
		}
		if (session.pendingPurchaseFlow?.step === 'awaiting_confirmation') {
			session.pendingPurchaseFlow.items = session.cart ?? [];
			// El total queda obsoleto tras editar el carrito (p. ej. compra desde
			// cotización); al limpiarlo, el flujo lo recalcula desde los ítems.
			session.pendingPurchaseFlow.total = undefined;
			return this.openai
				.generateReply({
					userMessage: text,
					intent: 'awaiting_purchase_confirmation',
					cart: session.cart,
					currency,
					editOutcomeNotes,
					purchaseFlowData: session.pendingPurchaseFlow.collectedData,
				})
				.catch(() => editReply);
		}
		return editReply;
	};

	/**
	 * Aplica un cambio del NLU al carrito y devuelve el resultado real.
	 * Los casos esperables (ítem no encontrado, sin stock, peso no múltiplo)
	 * no lanzan: viajan en status/note para que la respuesta los refleje.
	 */
	private applyCartChange = async (
		session: UserSession,
		change: CartChange,
		currency: string,
		countryInfo: CountryContext | null,
		normalizedText: string,
	): Promise<CartChangeResult> => {
		const cart = session.cart ?? [];
		const stockIds =
			countryInfo?.stockIds ?? session.lastCountryInfo?.stockIds ?? [];

		// ── new: producto que no está en el carrito ──
		if (change.action === 'new') {
			// Identidad estricta: solo es "el mismo producto" si TODAS las palabras
			// del hint coinciden (evita que "aceite de coco" matchee otro aceite)
			const existing = this.findBestCartItemMatch(
				cart,
				change.product,
				undefined,
				true,
			);
			if (existing) {
				// Mal etiquetado por el modelo: ya está en el carrito → set/increase
				const redirected: CartChange = {
					...change,
					action:
						change.quantity !== undefined || change.weightText
							? 'set'
							: 'increase',
					cartIndex: cart.indexOf(existing) + 1,
				};
				return this.applyCartChange(
					session,
					redirected,
					currency,
					countryInfo,
					normalizedText,
				);
			}
			return this.applyNewFromActiveList(session, change, currency, stockIds);
		}

		// ── set / increase / decrease / remove: resolver el ítem del carrito ──
		const item = this.resolveCartItem(cart, change);
		if (!item) {
			// El NLU a veces etiqueta como set/increase un producto que NO está en
			// el carrito (típico al iniciar con el carrito vacío: "necesito 4 kilos
			// de X" → set sobre un cartIndex inexistente). La única lectura válida es
			// agregarlo como nuevo. decrease/remove SÍ deben quedar como not_found:
			// no se puede quitar lo que no está en el pedido.
			if (
				(change.action === 'set' || change.action === 'increase') &&
				change.product
			) {
				console.log(
					`[WhatsApp Agent] Cart: ${change.action} target "${change.product}" not in cart → reinterpreting as new add`,
				);
				return this.applyCartChange(
					session,
					{ ...change, action: 'new', cartIndex: undefined },
					currency,
					countryInfo,
					normalizedText,
				);
			}
			return { change, status: 'not_found' };
		}
		const itemLabel = cartItemLabel(item);

		// GUARDA anti-arrastre del NLU: si el mensaje actual nombra productos
		// explícitamente pero NINGUNA palabra del ítem resuelto aparece en él,
		// el modelo apuntó a un ítem de un turno anterior (ej: cliente pide
		// "2 aceites de coco" y el modelo manda set sobre el termómetro).
		// No mutar; el handler intenta interpretar el producto realmente pedido.
		const textWords = significantTextWords(normalizedText);
		if (
			!itemMentionedInText(textWords, itemLabel) &&
			textNamesAnyProduct(
				textWords,
				buildProductVocab(cart, session.lastProductList),
			)
		) {
			console.log(
				`[WhatsApp Agent] Cart: mention mismatch — change targets "${itemLabel}" but message names other products ("${normalizedText}")`,
			);
			return {
				change,
				status: 'needs_search',
				mentionMismatch: true,
				item,
				itemLabel,
				requestedQuantity: change.quantity,
			};
		}

		if (change.action === 'remove') {
			cart.splice(cart.indexOf(item), 1);
			console.log(`[WhatsApp Agent] Cart: removed ${itemLabel}`);
			return {
				change,
				status: 'applied',
				item,
				itemLabel,
				oldQuantity: item.quantity,
				removed: true,
			};
		}

		// Cambio de presentación → lo resuelve el handler con búsqueda en BD
		// (buscar antes de borrar, para no perder el ítem si la variante no existe)
		if (change.variant && !this.variantMatchesItem(change.variant, item)) {
			return {
				change,
				status: 'needs_search',
				variantSwitch: true,
				item,
				itemLabel,
				oldQuantity: item.quantity,
				requestedQuantity: change.quantity ?? item.quantity,
			};
		}

		// Cantidad expresada en peso → convertir a unidades según la presentación
		let amount = change.quantity;
		if (change.weightText) {
			const conversion = this.weightToUnits(change.weightText, item);
			if (conversion.error) {
				return {
					change,
					status: 'no_op',
					item,
					itemLabel,
					note: conversion.error,
				};
			}
			amount = conversion.units;
		}

		const old = item.quantity;

		if (change.action === 'decrease') {
			const delta = amount ?? 1;
			const newQty = old - delta;
			if (newQty <= 0) {
				cart.splice(cart.indexOf(item), 1);
				console.log(
					`[WhatsApp Agent] Cart: decrease removed ${itemLabel} (${old} - ${delta} ≤ 0)`,
				);
				return {
					change,
					status: 'applied',
					item,
					itemLabel,
					oldQuantity: old,
					removed: true,
				};
			}
			item.quantity = newQty;
			console.log(
				`[WhatsApp Agent] Cart: decrease ${itemLabel} ${old} - ${delta} → ${newQty}`,
			);
			return {
				change,
				status: 'applied',
				item,
				itemLabel,
				oldQuantity: old,
				newQuantity: newQty,
			};
		}

		// ── set / increase ──
		const target = change.action === 'set' ? amount : old + (amount ?? 1);
		if (target === undefined) {
			return {
				change,
				status: 'no_op',
				item,
				itemLabel,
				note: 'no se especificó la cantidad',
			};
		}

		// 'set' a la MISMA cantidad = sin cambios reales. Frecuente cuando el NLU
		// re-emite un ítem ya presente (arrastre). No lo anunciamos como si se hubiera
		// modificado (evita "le sumé/agregué X" cuando nada cambió).
		if (change.action === 'set' && target === old) {
			return {
				change,
				status: 'no_op',
				item,
				itemLabel,
				note: 'ya estaba en esa cantidad, sin cambios',
			};
		}

		// Validar contra stock disponible (mismo criterio que el resto de adds)
		let final = target;
		let capped = false;
		let available: number | undefined;
		if (item.stockItemId && target > old) {
			available = await this.productSearchService.getAvailableStock(
				item.stockItemId,
				stockIds,
			);
			if (available <= 0) {
				return {
					change,
					status: 'no_op',
					item,
					itemLabel,
					capped: true,
					requestedQuantity: target,
					availableStock: 0,
					note: 'sin stock disponible para aumentar la cantidad',
				};
			}
			if (target > available) {
				final = available;
				capped = true;
			}
		}

		item.quantity = final;
		console.log(
			`[WhatsApp Agent] Cart: ${change.action} ${itemLabel} ${old} → ${final}${capped ? ` (capped, requested ${target}, stock ${available})` : ''}`,
		);
		return {
			change,
			status: 'applied',
			item,
			itemLabel,
			oldQuantity: old,
			newQuantity: final,
			capped,
			requestedQuantity: capped ? target : undefined,
			availableStock: capped ? available : undefined,
		};
	};

	/** Agrega un producto nuevo desde la lista activa. Si no se puede resolver aquí, pide búsqueda en BD (needs_search). */
	private applyNewFromActiveList = async (
		session: UserSession,
		change: CartChange,
		currency: string,
		stockIds: string[],
	): Promise<CartChangeResult> => {
		if (!change.product) {
			return { change, status: 'no_op', note: 'no se especificó el producto' };
		}
		const fromList = this.productSearchService.resolveFromActiveList(
			session.lastProductList,
			change.product,
			change.weightText ?? change.variant,
		);
		if (!fromList || !fromList.variant.price) {
			return { change, status: 'needs_search' };
		}

		const { product: productEntry, variant } = fromList;
		const units = fromList.units * (change.quantity ?? 1);
		// Revalidar stock EN VIVO: session.lastProductList persiste en Redis (2h) y su
		// totalQty puede estar desactualizado o ser de otra bodega/país. Nunca agregar
		// confiando solo en el stock cacheado de la lista.
		const liveStock = variant.stockItemId
			? await this.productSearchService.getAvailableStock(
					variant.stockItemId,
					stockIds,
				)
			: 0;
		const capped = Math.min(units, liveStock);
		if (capped <= 0) {
			// Sin stock real → la búsqueda en BD mostrará alternativas o informará que no hay
			return { change, status: 'needs_search' };
		}
		// Pidió MÁS de lo disponible → NO agregar; el handler pregunta si quiere lo que hay.
		if (units > liveStock) {
			return {
				change,
				status: 'no_op',
				stockShortage: {
					product: productEntry,
					variant,
					requested: units,
					available: liveStock,
				},
			};
		}
		addToCart(session, productEntry, capped, currency, variant);
		const itemLabel = [productEntry.name, variant.name]
			.filter(Boolean)
			.join(' ');
		console.log(`[WhatsApp Agent] Cart: new added ${capped}x ${itemLabel}`);
		return {
			change,
			status: 'applied',
			itemLabel,
			newQuantity: capped,
			capped: capped < units,
			requestedQuantity: capped < units ? units : undefined,
			availableStock: capped < units ? liveStock : undefined,
		};
	};

	/**
	 * Reinterpreta un cambio donde el NLU arrastró un ítem de otro turno: el
	 * mensaje nombra un producto distinto al ítem apuntado. Si es la única
	 * instrucción, se convierte en un add del producto que el mensaje sí nombra
	 * (extraído del texto y resuelto por búsqueda en BD); si hay más cambios,
	 * se descarta con nota de aclaración para no adivinar.
	 */
	private reinterpretMismatchedChange = (
		result: CartChangeResult,
		results: CartChangeResult[],
		session: UserSession,
		ctx: IntentContext,
	): void => {
		result.mentionMismatch = false;

		if (results.length > 1) {
			result.status = 'no_op';
			result.note =
				'el cambio apuntaba a un producto que el cliente no mencionó; pregunta exactamente qué desea modificar';
			return;
		}

		// Extraer del mensaje el producto realmente pedido: desde la primera
		// palabra que indica producto (familia o vocabulario conocido) en adelante
		const vocab = buildProductVocab(
			session.cart ?? [],
			session.lastProductList,
		);
		const words = ctx.normalizedText.split(/\s+/);
		const startIdx = words.findIndex(
			w =>
				w.length > 2 &&
				!/^\d+$/.test(w) &&
				!CART_INSTRUCTION_STOPWORDS.has(w) &&
				isProductIndicator(w, vocab),
		);
		if (startIdx === -1) {
			result.status = 'no_op';
			result.note =
				'no se pudo identificar el producto mencionado; pregunta al cliente qué desea modificar';
			return;
		}

		const hint = words.slice(startIdx).join(' ');
		console.log(
			`[WhatsApp Agent] Cart: reinterpreting mismatched change as new "${hint}" (was ${result.change.action} on "${result.itemLabel}")`,
		);
		// Reemplazar el change para que la recuperación por búsqueda en BD (y el
		// redirect a búsqueda si tampoco se encuentra) lo traten como un add normal
		result.change = {
			action: 'new',
			product: hint,
			quantity: result.change.quantity,
			weightText: result.change.weightText,
		};
		result.item = undefined;
		result.itemLabel = undefined;
		// status queda en needs_search → recoverNewProductAdd lo procesa
	};

	/** Recupera un add que la lista activa no resolvió: busca el producto en BD y lo agrega (con stock validado). */
	private recoverNewProductAdd = async (
		result: CartChangeResult,
		session: UserSession,
		currency: string,
		countryInfo: CountryContext | null,
	): Promise<void> => {
		const change = result.change;
		if (!change.product) {
			result.status = 'no_op';
			result.note = 'no se especificó el producto';
			return;
		}
		// Snapshot para detectar exactamente qué ítems agrega la búsqueda
		const cartBefore = new Set(session.cart ?? []);
		const outcome = await this.productSearchService.processProductListItems(
			[
				{
					productHint: change.product,
					quantity: change.quantity ?? 1,
					variantHint: change.weightText ?? change.variant,
				},
			],
			session,
			currency,
			countryInfo,
			'purchase',
		);
		// Validar que lo agregado ES lo que pidió el cliente; si la búsqueda
		// devolvió un producto distinto (misma familia, otra variedad), revertir.
		const addedItems = (session.cart ?? []).filter(i => !cartBefore.has(i));
		for (const item of addedItems) {
			if (!matchesRequestedProduct(change.product, cartItemLabel(item))) {
				session.cart?.splice(session.cart.indexOf(item), 1);
				console.log(
					`[WhatsApp Agent] Cart: reverted mismatched add "${cartItemLabel(item)}" (requested "${change.product}")`,
				);
			}
		}
		const validAdded = addedItems.filter(i => session.cart?.includes(i));

		// Peso ambiguo (kilos sueltos vs bloque/caja): no se agregó nada; el handler
		// de edit_cart preguntará al cliente qué presentación prefiere.
		if (validAdded.length === 0 && outcome.presentationChoices.length > 0) {
			const pc = outcome.presentationChoices[0];
			result.presentationChoice = {
				product: pc.product,
				requestedGrams: pc.requestedGrams,
			};
			result.status = 'no_op';
			return;
		}

		// Presentación a granel pedida pero agotada aquí: el handler ofrecerá los kilos.
		if (validAdded.length === 0 && outcome.bulkUnavailable.length > 0) {
			result.bulkUnavailable = outcome.bulkUnavailable[0];
			result.status = 'no_op';
			return;
		}

		if (validAdded.length > 0) {
			const addedItem = validAdded[0];
			const requested = change.quantity ?? 1;
			// Pidió MÁS de lo disponible → deshacer y preguntar (no agregar arbitrariamente).
			if (addedItem.quantity > 0 && addedItem.quantity < requested) {
				session.cart?.splice(session.cart.indexOf(addedItem), 1);
				const variant = {
					variantId: addedItem.productVariantId ?? '',
					stockItemId: addedItem.stockItemId ?? null,
					name: addedItem.variantName ?? '',
					totalQty: addedItem.quantity,
					price: addedItem.unitPrice,
				};
				result.status = 'no_op';
				result.itemLabel = undefined;
				result.stockShortage = {
					product: {
						productId: addedItem.productId,
						name: addedItem.productName,
						variants: [variant],
					},
					variant,
					requested,
					available: addedItem.quantity,
				};
				return;
			}
			result.status = 'applied';
			result.itemLabel = cartItemLabel(addedItem);
			result.newQuantity = addedItem.quantity;
			return;
		}
		// La búsqueda solo trajo productos que no corresponden → no encontrado
		if (addedItems.length > 0) {
			result.status = 'needs_search';
			return;
		}
		// addToCart fusionó con un ítem existente (misma variante) en lugar de crear línea
		if (outcome.added > 0) {
			const merged = this.findBestCartItemMatch(
				session.cart ?? [],
				change.product,
			);
			result.status = 'applied';
			result.itemLabel = merged ? cartItemLabel(merged) : change.product;
			result.newQuantity = merged?.quantity;
			return;
		}
		// No se agregó: sin stock (con detalle) o no encontrado (queda needs_search)
		const detail = outcome.outOfStockDetails[0];
		if (detail) {
			result.status = 'no_op';
			// availableStock marca el caso sin-stock: si fue la única instrucción,
			// el handler redirige a búsqueda para mostrar alternativas al cliente
			result.availableStock = detail.currentStock ?? 0;
			result.note =
				`"${detail.name}" está sin stock` +
				(detail.alternatives.length > 0
					? `; alternativas disponibles: ${detail.alternatives.map(a => a.name).join(', ')}`
					: '');
		}
	};

	/**
	 * Cambia la presentación de un ítem del carrito: busca el producto en BD,
	 * resuelve la variante pedida y reemplaza el ítem. Busca ANTES de borrar
	 * para que el carrito quede intacto si la presentación no existe.
	 */
	private recoverVariantSwitch = async (
		result: CartChangeResult,
		session: UserSession,
		currency: string,
		countryInfo: CountryContext | null,
	): Promise<void> => {
		const change = result.change;
		const item = result.item;
		if (!item || !change.variant) {
			result.status = 'no_op';
			result.note = 'no se pudo identificar la presentación pedida';
			return;
		}

		const search = await this.productSearchService.buildProductReply(
			normalizeText(item.productName),
			countryInfo ?? session.lastCountryInfo ?? null,
			item.productName,
		);
		const product =
			search.products.find(
				p => normalizeText(p.name) === normalizeText(item.productName),
			) ?? (search.productFound ? search.products[0] : undefined);
		if (!product) {
			result.status = 'no_op';
			result.note = `no se encontraron otras presentaciones de ${item.productName}`;
			return;
		}

		// Variante pedida: primero por peso equivalente, luego por nombre
		const wantedGrams = parseVariantWeightGrams(change.variant);
		const wantedNorm = normalizeText(change.variant);
		const resolved =
			(wantedGrams !== null
				? product.variants.find(
						v => parseVariantWeightGrams(v.name) === wantedGrams,
					)
				: undefined) ??
			product.variants.find(v => {
				const vn = normalizeText(v.name);
				return (
					vn.length > 0 && (vn.includes(wantedNorm) || wantedNorm.includes(vn))
				);
			});
		if (!resolved?.price) {
			const options = product.variants.map(v => v.name).filter(Boolean);
			result.status = 'no_op';
			result.note =
				`no existe la presentación "${change.variant}" de ${item.productName}` +
				(options.length > 0
					? `; presentaciones disponibles: ${options.join(', ')}`
					: '');
			return;
		}

		const targetQty = result.requestedQuantity ?? item.quantity;
		const finalQty = Math.min(targetQty, resolved.totalQty);
		if (finalQty <= 0) {
			result.status = 'no_op';
			result.note = `la presentación ${resolved.name} está sin stock`;
			return;
		}

		const idx = session.cart?.indexOf(item) ?? -1;
		if (idx >= 0) session.cart!.splice(idx, 1);
		addToCart(session, product, finalQty, currency, resolved);

		result.status = 'applied';
		result.itemLabel = [product.name, resolved.name].filter(Boolean).join(' ');
		result.newQuantity = finalQty;
		result.capped = finalQty < targetQty;
		result.requestedQuantity = finalQty < targetQty ? targetQty : undefined;
		result.availableStock =
			finalQty < targetQty ? resolved.totalQty : undefined;
		result.note = `cambió de presentación: antes ${cartItemLabel(item)}, ahora ${result.itemLabel}`;
		console.log(
			`[WhatsApp Agent] Cart: variant switch ${cartItemLabel(item)} → ${finalQty}x ${result.itemLabel}`,
		);
	};

	/**
	 * Convierte un CartChangeResult en una nota de hechos para el modelo.
	 * Formato telegráfico a propósito: son DATOS para redactar, no frases
	 * para copiar (la redacción natural la pone el modelo).
	 */
	private describeCartChangeResult = (result: CartChangeResult): string => {
		const { change, status } = result;
		const ref = result.itemLabel ?? change.product ?? 'el producto';

		if (status === 'applied') {
			let note: string;
			if (result.removed) {
				note = `QUITADO del pedido: ${ref}`;
			} else if (result.oldQuantity === undefined) {
				note = `AGREGADO: ${result.newQuantity}x ${ref}`;
			} else {
				note = `CANTIDAD de ${ref}: ${result.oldQuantity} → ${result.newQuantity}`;
			}
			if (result.note) note += ` (${result.note})`;
			if (result.capped) {
				note += `. STOCK INSUFICIENTE: pidió ${result.requestedQuantity ?? 'más'}, solo hay ${result.availableStock} — informa esto al cliente`;
			}
			return note;
		}
		if (status === 'not_found') {
			return `NO ESTÁ EN EL PEDIDO: "${change.product ?? 'ese producto'}" — no digas que lo actualizaste; informa al cliente y pregunta a cuál se refiere`;
		}
		if (status === 'needs_search') {
			return `NO ENCONTRADO: "${change.product ?? 'ese producto'}" — no digas que lo agregaste; informa al cliente y pídele más detalle del producto`;
		}
		// no_op
		return `NO APLICADO: ${ref}${result.note ? ` — ${result.note}` : ''} — no digas que lo actualizaste; explica el motivo al cliente`;
	};

	/** Resuelve el ítem del carrito referenciado por el change: índice del NLU primero, scoring por nombre como respaldo. */
	private resolveCartItem = (
		cart: CartItem[],
		change: CartChange,
	): CartItem | undefined => {
		const byIndex =
			change.cartIndex !== undefined &&
			change.cartIndex >= 1 &&
			change.cartIndex <= cart.length
				? cart[change.cartIndex - 1]
				: undefined;
		if (byIndex) {
			// Protección contra off-by-one del modelo: el nombre dado debe
			// compartir al menos una palabra con el ítem indexado.
			if (
				!change.product ||
				scoreNameMatch(change.product, cartItemLabel(byIndex)) > 0
			) {
				return byIndex;
			}
			console.log(
				`[WhatsApp Agent] Cart: cartIndex ${change.cartIndex} does not match "${change.product}", falling back to name scoring`,
			);
		}
		return this.findBestCartItemMatch(cart, change.product, change.variant);
	};

	/**
	 * Mejor coincidencia por nombre dentro del carrito (score ≥ 0.5).
	 * Con requireAllWords, solo considera ítems donde TODAS las palabras del
	 * hint coinciden (identidad de producto, no solo similitud).
	 */
	private findBestCartItemMatch = (
		cart: CartItem[],
		hint?: string,
		variantHint?: string,
		requireAllWords = false,
	): CartItem | undefined => {
		if (!hint || cart.length === 0) return undefined;
		const fullHint = variantHint ? `${hint} ${variantHint}` : hint;
		let best: CartItem | undefined;
		let bestScore = 0;
		for (const item of cart) {
			const label = cartItemLabel(item);
			if (requireAllWords && !allHintWordsMatch(fullHint, label)) continue;
			const score = scoreNameMatch(fullHint, label);
			if (score > bestScore) {
				bestScore = score;
				best = item;
			}
		}
		return bestScore >= 0.5 ? best : undefined;
	};

	/** true si la presentación pedida corresponde a la variante actual del ítem (por peso equivalente o por nombre). */
	private variantMatchesItem = (
		variantHint: string,
		item: CartItem,
	): boolean => {
		const itemVariant = item.variantName ?? '';
		const hintGrams = parseVariantWeightGrams(variantHint);
		const itemGrams = parseVariantWeightGrams(itemVariant);
		if (hintGrams !== null && itemGrams !== null)
			return hintGrams === itemGrams;
		const hintNorm = normalizeText(variantHint);
		const itemNorm = normalizeText(itemVariant);
		if (!itemNorm) return false;
		return itemNorm.includes(hintNorm) || hintNorm.includes(itemNorm);
	};

	/** Convierte una cantidad expresada en peso a unidades según la presentación del ítem. */
	private weightToUnits = (
		weightText: string,
		item: CartItem,
	): { units?: number; error?: string } => {
		const requestedGrams = detectRequestedWeightGrams(weightText);
		if (requestedGrams === null || requestedGrams <= 0) {
			return { error: `no se entendió el peso "${weightText}"` };
		}
		const itemGrams = parseVariantWeightGrams(item.variantName ?? '');
		if (itemGrams === null || itemGrams <= 0) {
			return {
				error: `la presentación de ${cartItemLabel(item)} no se vende por peso; pide la cantidad en unidades`,
			};
		}
		if (requestedGrams % itemGrams !== 0) {
			return {
				error: `${weightText} no es múltiplo de la presentación de ${cartItemLabel(item)} (${itemGrams} g por unidad); propone la cantidad en unidades o la presentación que sí calce`,
			};
		}
		return { units: requestedGrams / itemGrams };
	};

	/**
	 * Resumen del pedido en formato lista + total ("Listo, aquí está su pedido: ...").
	 * Devuelve '' si el carrito está vacío. Se usa para confirmar lo agregado antes de
	 * aclarar, al final del mensaje, un producto no disponible.
	 */
	private buildCartSummary = (cart: CartItem[], currency: string): string => {
		if (!cart || cart.length === 0) return '';
		const lines = cart
			.map(item => {
				const name = item.variantName
					? `${item.productName} ${item.variantName}`
					: item.productName;
				const total = item.unitPrice
					? formatPrice(
							String(Number(item.unitPrice) * item.quantity),
							item.currency,
						)
					: null;
				return total
					? `- ${item.quantity}x ${name} = ${total}`
					: `- ${item.quantity}x ${name}`;
			})
			.join('\n');
		const grandTotal = cart.reduce(
			(sum, item) =>
				sum + (item.unitPrice ? Number(item.unitPrice) * item.quantity : 0),
			0,
		);
		return `Listo, aquí está su pedido:\n${lines}\n\nTotal: ${formatPrice(String(grandTotal), currency)}`;
	};

	/** Convierte una opción de peso resuelta a PresentationOption serializable. */
	private toPresentationOption = (x: {
		variant: ProductListEntry['variants'][0];
		units: number;
	}): PresentationOption => ({
		variantId: x.variant.variantId,
		stockItemId: x.variant.stockItemId,
		variantName: x.variant.name,
		units: x.units,
		unitPrice: x.variant.price,
		totalQty: x.variant.totalQty,
	});

	/**
	 * Guarda en sesión una elección de presentación pendiente (kilos sueltos vs
	 * bloque/caja) y devuelve la pregunta al cliente. La respuesta del cliente se
	 * resuelve en el siguiente turno vía resolvePendingPresentationChoice.
	 */
	private askPresentationChoice = async (
		session: UserSession,
		phoneNumber: string,
		product: ProductListEntry,
		requestedGrams: number,
		ambiguous: Extract<WeightedPresentationResult, { mode: 'ambiguous' }>,
		currency: string,
		mode: 'add' | 'edit',
		cartItemVariantId?: string,
	): Promise<string> => {
		const choice: PendingPresentationChoice = {
			productId: product.productId,
			productName: product.name,
			requestedGrams,
			currency,
			kilo: this.toPresentationOption(ambiguous.kilo),
			bulk: ambiguous.bulk.map(b => this.toPresentationOption(b)),
			mode,
			cartItemVariantId,
		};
		session.pendingPresentationChoice = choice;
		await redis.set(
			`session:${phoneNumber}`,
			JSON.stringify(session),
			'EX',
			SESSION_TTL_SECONDS,
		);

		const kg = requestedGrams / 1000;
		const kgLabel = kg % 1 === 0 ? `${kg}` : kg.toFixed(1);
		const lineFor = (opt: PresentationOption, forma: string): string => {
			const total = opt.unitPrice
				? formatPrice(String(Number(opt.unitPrice) * opt.units), currency)
				: null;
			return `- ${forma}: ${opt.units} x ${opt.variantName}${total ? ` = ${total}` : ''}`;
		};
		const lines = [
			lineFor(choice.kilo, 'en kilos sueltos'),
			...choice.bulk.map(b =>
				lineFor(b, /caja/i.test(b.variantName) ? 'en caja' : 'en bloque'),
			),
		].join('\n');
		return (
			`Para ${kgLabel} kilos de ${product.name} tiene dos formas de llevarlo:\n${lines}\n\n` +
			`¿Cómo lo prefiere?`
		);
	};

	/**
	 * La presentación a granel (bloque/caja) que pidió el cliente existe en catálogo
	 * pero está AGOTADA en su país. Guarda un pendiente con solo la opción por kilo y
	 * ofrece esa alternativa (un "sí" la confirma en el siguiente turno).
	 */
	private offerKiloForUnavailableBulk = async (
		session: UserSession,
		phoneNumber: string,
		product: ProductListEntry,
		requestedGrams: number,
		kiloVariant: ProductListEntry['variants'][0],
		bulkName: string,
		currency: string,
		mode: 'add' | 'edit',
		cartItemVariantId?: string,
		/** Ítems ya agregados a confirmar (lista+total) antes de la aclaración (multi/quote). */
		confirmCart?: CartItem[],
		/** true si es el primer mensaje de la conversación (para el saludo de apertura). */
		isFirstTurn?: boolean,
	): Promise<string> => {
		const units = Math.max(1, Math.round(requestedGrams / 1000));
		const cappedUnits = Math.min(units, kiloVariant.totalQty);
		const bulkGrams = parseVariantWeightGrams(bulkName);
		const bulkLabel = /bloque/i.test(bulkName)
			? `bloque${bulkGrams ? ` de ${bulkGrams / 1000} kilos` : ''}`
			: /caja/i.test(bulkName)
				? bulkName.toLowerCase()
				: `presentación ${bulkName}`;

		if (cappedUnits <= 0) {
			// Ni bloque ni kilo disponibles: nada que ofrecer.
			session.pendingPresentationChoice = null;
			await redis.set(
				`session:${phoneNumber}`,
				JSON.stringify(session),
				'EX',
				SESSION_TTL_SECONDS,
			);
			return this.openai
				.generateReply({
					userMessage: 'sin stock',
					knownCustomerName:
						session.knownCustomerName ?? session.collectedCustomerName,
					lastBotMessage: session.lastBotMessage,
					editOutcomeNotes: [
						`NO hay ${bulkLabel} ni presentación por kilo de "${product.name}" disponible ahora. Dilo de forma natural y breve (nombre corto del producto, sin lista) y ofrece ayudar con otra base.`,
					],
				})
				.catch(
					() =>
						`Por ahora no tengo disponible esa presentación de ese producto. ¿Le ayudo con otra base?`,
				);
		}

		session.pendingPresentationChoice = {
			productId: product.productId,
			productName: product.name,
			requestedGrams,
			currency,
			kilo: this.toPresentationOption({
				variant: kiloVariant,
				units: cappedUnits,
			}),
			bulk: [],
			mode,
			cartItemVariantId,
			bulkUnavailable: true,
			unavailableBulkName: bulkName,
		};
		await redis.set(
			`session:${phoneNumber}`,
			JSON.stringify(session),
			'EX',
			SESSION_TTL_SECONDS,
		);

		return this.openai
			.generateReply({
				userMessage: 'presentacion no disponible',
				knownCustomerName:
					session.knownCustomerName ?? session.collectedCustomerName,
				isFirstInteraction: isFirstTurn,
				currency,
				lastBotMessage: session.lastBotMessage,
				conversationHistory: session.conversationHistory,
				cart: confirmCart && confirmCart.length > 0 ? confirmCart : undefined,
				bulkUnavailable: {
					productName: product.name,
					bulkLabel,
					kiloUnits: cappedUnits,
					kiloUnitPrice: kiloVariant.price,
				},
			})
			.catch(() => {
				const total = kiloVariant.price
					? ` (${formatPrice(String(Number(kiloVariant.price) * cappedUnits), currency)})`
					: '';
				const summary =
					confirmCart && confirmCart.length > 0
						? `${this.buildCartSummary(confirmCart, currency)}\n\n`
						: '';
				return `${summary}Esa base no la tenemos en ${bulkLabel} por ahora; sí la manejamos de a kilo. ¿Le agrego ${cappedUnits}${total}?`;
			});
	};

	/**
	 * Interceptor de la elección de presentación pendiente: si el cliente responde
	 * a la pregunta "kilos sueltos vs bloque/caja", resuelve, agrega/reemplaza en el
	 * carrito y confirma. Si la respuesta no expresa una preferencia clara, limpia el
	 * pendiente y devuelve null para que el mensaje se procese con el flujo normal.
	 */
	resolvePendingPresentationChoice = async (
		session: UserSession,
		phoneNumber: string,
		text: string,
		normalizedText: string,
		countryInfo: CountryContext | null,
	): Promise<string | null> => {
		const choice = session.pendingPresentationChoice;
		if (!choice) return null;

		const pref = classifyPresentationPreference(normalizedText);
		let chosen: PresentationOption | undefined;
		if (pref === 'unit') {
			chosen = choice.kilo;
		} else if (pref === 'bulk' && choice.bulk.length > 0) {
			// Casar por nombre de variante (ej. dice "caja" → variante con "caja"); si no, la primera (mayor: bloque)
			const byName = choice.bulk.find(b =>
				normalizeText(b.variantName)
					.split(/\s+/)
					.some(w => w.length > 2 && normalizedText.includes(w)),
			);
			chosen = byName ?? choice.bulk[0];
		} else if (choice.bulk.length > 0) {
			// Respuesta por peso ("el de 10 kilos", "la de 5") → opción a granel cuyo
			// gramaje por unidad coincide con lo que menciona el cliente.
			const g = detectRequestedWeightGrams(normalizedText);
			if (g !== null) {
				chosen = choice.bulk.find(
					b => parseVariantWeightGrams(b.variantName) === g,
				);
			}
		}

		// Bloque/caja agotado: solo se ofreció la opción por kilo. Un "sí" la confirma;
		// un "no" la descarta.
		if (!chosen && choice.bulkUnavailable) {
			const affirm =
				/\b(si|sii+|claro|dale|listo|bueno|buenas?|ok|oka|okay|okey|de una|hagale|hagalo|dele|perfecto|va|vale|correcto|exacto|asi es|de acuerdo|obvio|sip|sipi|porfa|por favor|melo|dejemelo|dejelas?|dejelos?)\b/.test(
					normalizedText,
				);
			const negate =
				/\b(no|nel|nop|nope|mejor no|ninguno|ninguna|asi no|nada)\b/.test(
					normalizedText,
				);
			if (negate && !affirm) {
				session.pendingPresentationChoice = null;
				await redis.set(
					`session:${phoneNumber}`,
					JSON.stringify(session),
					'EX',
					SESSION_TTL_SECONDS,
				);
				return 'Listo, lo dejo así. ¿Le ayudo con algo más?';
			}
			if (affirm) chosen = choice.kilo;
		}

		// Sin preferencia clara → no consumir; limpiar y dejar que el NLU maneje el mensaje.
		if (!chosen) {
			session.pendingPresentationChoice = null;
			await redis.set(
				`session:${phoneNumber}`,
				JSON.stringify(session),
				'EX',
				SESSION_TTL_SECONDS,
			);
			return null;
		}

		session.pendingPresentationChoice = null;
		const currency = choice.currency;

		// mode 'edit': quitar el ítem previo (la presentación anterior) antes de agregar la nueva
		if (choice.mode === 'edit' && choice.cartItemVariantId) {
			const idx = (session.cart ?? []).findIndex(
				i => i.productVariantId === choice.cartItemVariantId,
			);
			if (idx >= 0) session.cart!.splice(idx, 1);
		}

		const cappedUnits = Math.min(chosen.units, chosen.totalQty);
		const stockExceeded = cappedUnits < chosen.units;
		const productEntry: ProductListEntry = {
			productId: choice.productId,
			name: choice.productName,
			variants: [
				{
					variantId: chosen.variantId,
					stockItemId: chosen.stockItemId,
					name: chosen.variantName,
					totalQty: chosen.totalQty,
					price: chosen.unitPrice,
				},
			],
		};
		if (cappedUnits > 0) {
			addToCart(session, productEntry, cappedUnits, currency, productEntry.variants[0]);
			session.selectedProduct = choice.productName;
			session.selectedVariantName = chosen.variantName;
		}
		await redis.set(
			`session:${phoneNumber}`,
			JSON.stringify(session),
			'EX',
			SESSION_TTL_SECONDS,
		);

		if (cappedUnits <= 0) {
			return this.openai
				.generateReply({
					userMessage: text,
					intent: 'edit_cart',
					cart: session.cart,
					currency,
					editOutcomeNotes: [
						`NO se pudo agregar ${choice.productName}: sin stock. Dilo natural y breve, sin listar el pedido.`,
					],
					conversationHistory: session.conversationHistory,
				})
				.catch(
					() =>
						'Ese producto no tiene stock disponible en este momento. ¿Le ayudo con otra base?',
				);
		}

		// Igual que al agregar un producto: confirmar y mostrar el pedido de forma
		// NATURAL y VARIADA (vía modelo, no plantilla fija), reflejando lo agregado.
		const addedLabel = `${choice.productName} ${chosen.variantName}`.trim();
		const addedNote =
			`AGREGADO: ${cappedUnits}x ${addedLabel}` +
			(chosen.unitPrice
				? ` = ${formatPrice(String(Number(chosen.unitPrice) * cappedUnits), currency)}`
				: '') +
			(stockExceeded
				? `. STOCK: pidió ${chosen.units}, solo había ${cappedUnits} — menciónalo`
				: '');
		return this.openai
			.generateReply({
				userMessage: text,
				intent: 'edit_cart',
				cart: session.cart,
				currency,
				editOutcomeNotes: [addedNote],
				conversationHistory: session.conversationHistory,
			})
			.catch(() => {
				const summary = this.buildCartSummary(session.cart ?? [], currency);
				return `${summary}\n\n¿Necesita algo más?`;
			});
	};

	private handleIntentShowCart = async (
		ctx: IntentContext,
	): Promise<string> => {
		const { session, text, countryInfo } = ctx;
		const currency =
			session.lastCountryInfo?.currency ?? countryInfo?.currency ?? 'USD';
		const reply = await this.openai
			.generateReply({
				userMessage: text,
				intent: 'show_cart',
				cart: session.cart,
				currency,
				knownCustomerName: session.knownCustomerName,
				hasShownCartByName: session.hasShownCartByName,
			})
			.catch(() => 'No tiene productos en su pedido todavía.');
		if (session.knownCustomerName && !session.hasShownCartByName) {
			session.hasShownCartByName = true;
		}
		return reply;
	};

	private handleIntentRequestQuote = async (
		ctx: IntentContext,
	): Promise<string> => {
		const { session, phoneNumber, text, countryInfo, aiProductList } = ctx;

		let outOfStockFromList: string[] = [];
		let outOfStockDetailsFromList: Array<{
			name: string;
			currentStock: number;
			alternatives: Array<{ name: string; stock: number }>;
		}> = [];
		// Solo procesar aiProductList cuando el carrito está vacío (caso "cotízame 7 mechas"
		// en un solo mensaje). Si el carrito ya tiene ítems, el cliente está pidiendo cotizar
		// lo que ya armó ("me regalas la cotización"); en ese caso NO se debe re-parsear ni
		// agregar productos: el NLU puede alucinar una productList desde el historial y un
		// match difuso terminaría agregando un producto que el cliente nunca pidió.
		const cartHasItems = (session.cart?.length ?? 0) > 0;
		if (aiProductList && aiProductList.length > 0 && !cartHasItems) {
			const currency =
				session.lastCountryInfo?.currency ?? countryInfo?.currency ?? 'USD';
			const listResult =
				await this.productSearchService.processProductListItems(
					aiProductList,
					session,
					currency,
					countryInfo,
					'quote',
				);
			outOfStockFromList = listResult.outOfStock;
			outOfStockDetailsFromList = listResult.outOfStockDetails;
			console.log(
				`[WhatsApp Agent] Processed product list for quote: ${session.cart?.length ?? 0} items added to cart`,
			);
			// Presentación a granel agotada aquí: en un solo mensaje (vía modelo, variado)
			// confirmar lo agregado y aclarar el no disponible + ofrecer kilos, antes de cotizar.
			if (listResult.bulkUnavailable.length > 0) {
				const bu = listResult.bulkUnavailable[0];
				return this.offerKiloForUnavailableBulk(
					session,
					phoneNumber,
					bu.product,
					bu.requestedGrams,
					bu.kiloVariant,
					bu.bulkName,
					currency,
					'add',
					undefined,
					session.cart,
					ctx.isFirstInteraction,
				);
			}

			// Peso ambiguo (kilos sueltos vs bloque/caja): preguntar antes de armar la
			// cotización. Los ítems no ambiguos ya quedaron en el carrito; al resolver la
			// presentación el cliente puede volver a pedir la cotización.
			if (listResult.presentationChoices.length > 0) {
				const choice = listResult.presentationChoices[0];
				return this.askPresentationChoice(
					session,
					phoneNumber,
					choice.product,
					choice.requestedGrams,
					choice.ambiguous,
					currency,
					'add',
				);
			}
		} else if (aiProductList && aiProductList.length > 0 && cartHasItems) {
			console.log(
				`[WhatsApp Agent] Skipped aiProductList for quote (cart already has ${session.cart?.length} items) to avoid phantom additions`,
			);
		}

		// Solo aplica al caso en que efectivamente se procesó la lista (carrito vacío).
		const isSingleProductFromList =
			!cartHasItems &&
			aiProductList !== undefined &&
			aiProductList.length === 1;

		if (!session.cart || session.cart.length === 0) {
			if (outOfStockFromList.length > 0) {
				return this.openai
					.generateReply({
						userMessage: text,
						outOfStockProductName: outOfStockFromList[0],
						products: undefined,
					})
					.catch(
						() =>
							`Lo sentimos, "${outOfStockFromList[0]}" no está disponible en este momento. ¿Le puedo ayudar con otra cosa?`,
					);
			}
			return '¿Qué le gustaría cotizar?';
		} else if (isSingleProductFromList) {
			const currency =
				session.lastCountryInfo?.currency ?? countryInfo?.currency ?? 'USD';
			const lastCartItem = session.cart[session.cart.length - 1];
			const foundInList = session.lastProductList?.find(
				p => p.name === lastCartItem?.productName,
			);
			const foundVariant = foundInList?.variants.find(
				v => v.name === lastCartItem?.variantName,
			);
			const productForReply: OpenAIProduct =
				foundInList && foundVariant
					? { ...foundInList, variants: [foundVariant] }
					: (foundInList ?? {
							name: lastCartItem?.productName ?? '',
							description: undefined,
							variants: lastCartItem?.variantName
								? [
										{
											name: lastCartItem.variantName,
											price: lastCartItem.unitPrice ?? '0',
											totalQty: lastCartItem.quantity,
										},
									]
								: [],
						});
			await redis.set(
				`session:${phoneNumber}`,
				JSON.stringify(session),
				'EX',
				SESSION_TTL_SECONDS,
			);
			return this.openai
				.generateReply({
					userMessage: text,
					selectedProduct: productForReply,
					quantity: lastCartItem?.quantity,
					currency,
				})
				.catch(
					() =>
						`Listo, agregué ${lastCartItem?.productName ?? 'el producto'} a su pedido. ¿Necesita algo más?`,
				);
		} else {
			const currency =
				session.lastCountryInfo?.currency ?? countryInfo?.currency ?? 'USD';
			const isoCode =
				session.lastCountryInfo?.isoCode ?? countryInfo?.isoCode ?? 'CO';
			const localPhone = stripCallingCode(phoneNumber);
			const existingCustomer = await this.customerService.findByPhone(
				localPhone,
				isoCode,
			);
			if (existingCustomer) {
				session.pendingQuoteFlow = {
					step: 'awaiting_confirmation',
					outOfStockItems:
						outOfStockFromList.length > 0 ? outOfStockFromList : undefined,
					collectedData: {
						fullName: existingCustomer.fullName,
						dni: existingCustomer.dni,
						phoneNumber: localPhone,
						location: existingCustomer.location,
						cityId: existingCustomer.cityId,
						cityName: existingCustomer.cityName
							? `${existingCustomer.cityName}${existingCustomer.regionName ? `, ${existingCustomer.regionName}` : ''}`
							: undefined,
						customerId: existingCustomer.id,
						personId: existingCustomer.personId,
					},
				};
				await redis.set(
					`session:${phoneNumber}`,
					JSON.stringify(session),
					'EX',
					SESSION_TTL_SECONDS,
				);
				let reply = await this.openai
					.generateReply({
						userMessage: text,
						intent: 'existing_customer_confirmation',
						cart: session.cart,
						currency,
						quoteFlowData: session.pendingQuoteFlow.collectedData,
					})
					.catch(
						() =>
							`¡Hola de nuevo, ${existingCustomer.fullName}! Ya tengo sus datos registrados. ¿Procedemos con la cotización?`,
					);
				if (outOfStockDetailsFromList.length > 0) {
					const lines = outOfStockDetailsFromList
						.map(p => {
							const stockNote =
								p.currentStock > 0
									? `solo hay ${p.currentStock} disponible${p.currentStock !== 1 ? 's' : ''}`
									: 'sin stock';
							const altNote =
								p.alternatives.length > 0
									? `; también disponible en: ${p.alternatives.map(a => `${a.name} (${a.stock})`).join(', ')}`
									: '';
							return `- ${p.name} (${stockNote}${altNote})`;
						})
						.join('\n');
					reply += `\n\n⚠️ Los siguientes productos no tienen stock suficiente:\n${lines}`;
				}
				return reply;
			} else {
				session.pendingQuoteFlow = {
					step: 'awaiting_customer_data',
					outOfStockItems:
						outOfStockFromList.length > 0 ? outOfStockFromList : undefined,
					collectedData: { phoneNumber: localPhone },
				};
				await redis.set(
					`session:${phoneNumber}`,
					JSON.stringify(session),
					'EX',
					SESSION_TTL_SECONDS,
				);
				return this.openai
					.generateReply({
						userMessage: text,
						intent: 'request_quote',
					})
					.catch(
						() =>
							'¡Claro! Para armarle la cotización necesito su nombre completo y su número de cédula.',
					);
			}
		}
	};

	private handleIntentMultiProductAdd = async (
		ctx: IntentContext,
	): Promise<string> => {
		const { session, phoneNumber, countryInfo, aiProductList, aiChanges } = ctx;

		// El NLU es inconsistente con el formato de multi_product_add: a veces pone los
		// productos en `productList`, y otras en `changes` (formato edit_cart) con
		// action "new". Normalizamos ambos a una sola lista para procesarla igual.
		let productList = aiProductList;
		if ((!productList || productList.length === 0) && aiChanges?.length) {
			const fromChanges = aiChanges
				.filter(c => c.action === 'new' && c.product)
				.map(c => ({
					productHint: c.product as string,
					quantity: c.quantity ?? 1,
					variantHint: c.weightText ?? c.variant,
				}));
			if (fromChanges.length > 0) {
				console.log(
					`[WhatsApp Agent] multi_product_add: derived productList from changes: ${JSON.stringify(fromChanges)}`,
				);
				productList = fromChanges;
			}
		}

		if (!productList || productList.length === 0) {
			// El NLU clasificó multi_product_add pero no devolvió ni productList ni
			// changes utilizables (error ocasional del modelo). En vez de fallar,
			// tratamos el mensaje como una búsqueda normal: handleIntentSearchProduct
			// detecta el peso del texto y agrega el producto cuando corresponde.
			console.log(
				'[WhatsApp Agent] multi_product_add without products → falling back to search',
			);
			return this.handleIntentSearchProduct(ctx);
		}
		const currency =
			session.lastCountryInfo?.currency ?? countryInfo?.currency ?? 'USD';
		const result = await this.productSearchService.processProductListItems(
			productList,
			session,
			currency,
			countryInfo,
			'purchase',
		);
		console.log(
			`[WhatsApp Agent] multi_product_add: added=${result.added}, outOfStock=${result.outOfStock.join(',')}, presentationChoices=${result.presentationChoices.length}, bulkUnavailable=${result.bulkUnavailable.length}`,
		);

		// Presentación a granel (bloque/caja) pedida pero agotada aquí. En un solo mensaje
		// (vía modelo, variado): confirma lo que SÍ quedó en el pedido y al final aclara el
		// no disponible ofreciendo los kilos.
		if (result.bulkUnavailable.length > 0) {
			const bu = result.bulkUnavailable[0];
			return this.offerKiloForUnavailableBulk(
				session,
				phoneNumber,
				bu.product,
				bu.requestedGrams,
				bu.kiloVariant,
				bu.bulkName,
				currency,
				'add',
				undefined,
				session.cart,
				ctx.isFirstInteraction,
			);
		}

		// Ítem con peso ambiguo (kilos sueltos vs bloque/caja): preguntar antes de asumir.
		// Los demás ítems ya quedaron en el carrito; se listan como preámbulo.
		if (result.presentationChoices.length > 0) {
			const choice = result.presentationChoices[0];
			const question = await this.askPresentationChoice(
				session,
				phoneNumber,
				choice.product,
				choice.requestedGrams,
				choice.ambiguous,
				currency,
				'add',
			);
			if (session.cart && session.cart.length > 0) {
				const addedLines = session.cart
					.map(item => {
						const name = item.variantName
							? `${item.productName} ${item.variantName}`
							: item.productName;
						return `- ${item.quantity}x ${name}`;
					})
					.join('\n');
				return `Le agregué:\n${addedLines}\n\n${question}`;
			}
			return question;
		}

		if (!session.cart || session.cart.length === 0) {
			// No se agregó nada, pero la presentación pedida (bloque/caja) existe y está
			// agotada: informar con la alternativa en vez de decir "no encontré".
			if (result.outOfStockDetails.length > 0) {
				const lines = result.outOfStockDetails
					.map(p => {
						const alt =
							p.alternatives.length > 0
								? `; sí disponible en: ${p.alternatives.map(a => `${a.name} (${a.stock})`).join(', ')}`
								: '';
						return `- ${p.name} (no disponible${alt})`;
					})
					.join('\n');
				return `Sobre lo que pidió:\n${lines}\n\n¿Le dejo la presentación disponible?`;
			}
			const hints = productList.map(i => `"${i.productHint}"`).join(', ');
			return `No encontré los productos solicitados (${hints}). ¿Puede revisar los nombres?`;
		}
		// Notas para el modelo: lo agregado (para confirmar y detectar "con gusto") + avisos
		// de sin-stock. Se responde por el mismo formato edit_cart (saludo de primer mensaje,
		// resumen con lista + total, cierre variado / nombre+ciudad) para ser consistentes
		// con el resto de flujos de "agregar".
		const editOutcomeNotes: string[] = session.cart.map(item => {
			const name = item.variantName
				? `${item.productName} ${item.variantName}`
				: item.productName;
			const total = item.unitPrice
				? ` = ${formatPrice(String(Number(item.unitPrice) * item.quantity), item.currency)}`
				: '';
			return `AGREGADO: ${item.quantity}x ${name}${total}`;
		});
		if (result.outOfStockDetails.length > 0) {
			for (const p of result.outOfStockDetails) {
				if (p.currentStock === 0) {
					const alt =
						p.alternatives.length > 0
							? `; sí disponible en: ${p.alternatives.map(a => `${a.name} (${a.stock})`).join(', ')}`
							: '';
					editOutcomeNotes.push(
						`NO DISPONIBLE (no se agregó): ${p.name}${alt} — infórmalo al cliente`,
					);
				} else {
					editOutcomeNotes.push(
						`STOCK INSUFICIENTE: solo hay ${p.currentStock} de ${p.name} — infórmalo`,
					);
				}
			}
		}
		await redis.set(
			`session:${phoneNumber}`,
			JSON.stringify(session),
			'EX',
			SESSION_TTL_SECONDS,
		);
		return this.openai
			.generateReply({
				userMessage: ctx.text,
				intent: 'edit_cart',
				cart: session.cart,
				currency,
				editOutcomeNotes,
				isFirstInteraction: ctx.isFirstInteraction,
				knownCustomerName: ctx.knownCustomerName,
				askNameAndCity: ctx.awaitingNameAndCity,
				conversationHistory: session.conversationHistory,
			})
			.catch(() => {
				const summary = this.buildCartSummary(session.cart ?? [], currency);
				return (
					summary +
					(ctx.awaitingNameAndCity
						? '\n\nPor cierto, ¿me regala su nombre y desde qué ciudad nos escribe?'
						: '\n\n¿Necesita algo más?')
				);
			});
	};

	private handleIntentPurchaseIntent = async (
		ctx: IntentContext,
	): Promise<string> => {
		const { session, phoneNumber, botPhoneNumberId, text, countryInfo } = ctx;
		const isoCode =
			session.lastCountryInfo?.isoCode ?? countryInfo?.isoCode ?? 'CO';
		const localPhone = stripCallingCode(phoneNumber);
		const cartItems = session.cart ?? [];
		const hasQuote = !!session.lastQuoteId && !!session.lastQuoteSerial;
		const hasCartItems = cartItems.length > 0;

		if (!hasCartItems && !hasQuote) {
			return '¿Qué productos desea adquirir? Con gusto le ayudo.';
		} else if (hasQuote) {
			const currency =
				session.lastCountryInfo?.currency ?? countryInfo?.currency ?? 'COP';
			// Compra desde cotización: el medio de pago por defecto es el QR de
			// transferencia (el link de tarjeta solo si el cliente lo pide, en
			// awaiting_receipt). presentQuotePurchasePayment carga los datos de la
			// cotización (incluido personId) y muestra el pago SIN repetir el resumen.
			session.pendingPurchaseFlow = {
				step: 'awaiting_receipt',
				purchaseFromQuote: true,
				quoteId: session.lastQuoteId,
				quoteSerial: session.lastQuoteSerial,
				currency,
			};
			return await this.flowsService.presentQuotePurchasePayment(
				session,
				phoneNumber,
				botPhoneNumberId,
				countryInfo,
			);
		} else {
			const currency =
				session.lastCountryInfo?.currency ?? countryInfo?.currency ?? 'USD';

			const stockIds =
				session.lastCountryInfo?.stockIds ?? countryInfo?.stockIds ?? [];
			const { purchasableItems, blockedItems } =
				await this.productSearchService.filterCartItemsByStock(
					cartItems,
					stockIds,
				);

			if (purchasableItems.length === 0) {
				return 'Ninguno de los productos en su pedido tiene stock suficiente para procesar la compra en este momento. Si quiere, puedo generarle una cotización.';
			} else if (blockedItems.length > 0) {
				const blockedItemsContext = await Promise.all(
					blockedItems.map(async blocked => {
						const availableStock = blocked.stockItemId
							? await this.productSearchService.getAvailableStock(
									blocked.stockItemId,
									stockIds,
								)
							: 0;
						const productEntry = session.lastProductList?.find(
							p => p.productId === blocked.productId,
						);
						const alternatives = productEntry
							? productEntry.variants
									.filter(
										v =>
											v.variantId !== blocked.productVariantId &&
											v.totalQty > 0,
									)
									.map(v => ({
										variantId: v.variantId,
										name: v.name || '',
										stock: v.totalQty,
										unitPrice: v.price,
									}))
							: [];
						return { item: blocked, availableStock, alternatives };
					}),
				);

				session.pendingPurchaseFlow = {
					step: 'awaiting_out_of_stock_resolution',
					purchaseFromQuote: false,
					items: purchasableItems,
					currency,
					collectedData: { phoneNumber: localPhone },
					blockedItemsContext,
				};

				return buildOutOfStockResolutionMessage(blockedItemsContext);
			} else {
				const existingCustomer = await this.customerService.findByPhone(
					localPhone,
					isoCode,
				);
				if (existingCustomer) {
					session.pendingPurchaseFlow = {
						step: 'awaiting_confirmation',
						purchaseFromQuote: false,
						items: purchasableItems,
						currency,
						collectedData: {
							fullName: existingCustomer.fullName,
							dni: existingCustomer.dni,
							phoneNumber: localPhone,
							location: existingCustomer.location,
							cityId: existingCustomer.cityId,
							cityName: existingCustomer.cityName
								? `${existingCustomer.cityName}${existingCustomer.regionName ? `, ${existingCustomer.regionName}` : ''}`
								: undefined,
							customerId: existingCustomer.id,
							personId: existingCustomer.personId,
						},
					};
					return this.openai
						.generateReply({
							userMessage: text,
							intent: 'existing_customer_purchase_confirmation',
							cart: purchasableItems,
							currency,
							purchaseFlowData: session.pendingPurchaseFlow.collectedData,
						})
						.catch(
							() =>
								`¡Hola de nuevo, ${existingCustomer.fullName}! Ya tengo sus datos. ¿Procedemos con la compra?`,
						);
				} else {
					session.pendingPurchaseFlow = {
						step: 'awaiting_customer_data',
						purchaseFromQuote: false,
						items: purchasableItems,
						currency,
						collectedData: { phoneNumber: localPhone },
					};
					return this.openai
						.generateReply({
							userMessage: text,
							intent: 'purchase_intent',
						})
						.catch(
							() =>
								'¡Claro! Para procesar su compra necesito su nombre completo y su número de cédula.',
						);
				}
			}
			await redis.set(
				`session:${phoneNumber}`,
				JSON.stringify(session),
				'EX',
				SESSION_TTL_SECONDS,
			);
		}
	};

	private handleIntentFarewell = async (
		ctx: IntentContext,
	): Promise<string> => {
		const { session } = ctx;
		const afterPurchase =
			Boolean(session.lastPurchaseAt) &&
			!session.cart?.length &&
			!session.pendingPurchaseFlow &&
			!session.pendingQuoteFlow;
		return this.openai
			.generateReply({
				userMessage: ctx.text,
				intent: 'farewell',
				lastBotMessage: ctx.session.lastBotMessage ?? undefined,
				conversationHistory: ctx.session.conversationHistory,
				afterPurchase,
			})
			.catch(() =>
				afterPurchase
					? '¡Con gusto! Un placer atenderle 🙌'
					: 'Con gusto 😊 Cuando necesite algo más, aquí estaré.',
			);
	};

	private handleIntentNameCollected = async (
		ctx: IntentContext,
	): Promise<string> => {
		return this.openai
			.generateReply({
				userMessage: ctx.text,
				intent: 'name_collected',
				isFirstInteraction: false,
				knownCustomerName: ctx.knownCustomerName,
				// Carrito: si ya venía armando un pedido, el cierre debe ser sobre el pedido.
				cart: ctx.session.cart,
				// Producto que estaba consultando (para ofrecérselo tras dar sus datos):
				// solo si el carrito está vacío (aún no ha agregado nada).
				pendingOfferProduct:
					!ctx.session.cart?.length && ctx.session.lastProductList?.length
						? ctx.session.lastProductList[0].name
						: undefined,
				currency:
					ctx.session.lastCountryInfo?.currency ??
					ctx.countryInfo?.currency ??
					'COP',
				conversationHistory: ctx.session.conversationHistory,
			})
			.catch(
				() =>
					`Perfecto, ${ctx.knownCustomerName ?? 'con gusto'} ¿En qué le puedo ayudar?`,
			);
	};

	/**
	 * Resuelve el contexto de la intención secundaria (multi-intent).
	 * Si la intención secundaria tiene un searchQuery, realiza una búsqueda RAG ligera.
	 * Devuelve la pregunta y el contexto RAG (si existe) para inyectarlos en generateReply.
	 */
	private resolveSecondaryContext = async (
		secondaryIntent: import('../openai.service').NLUIntent | undefined,
		userText: string,
	): Promise<{ secondaryQuestion?: string; ragContext?: string }> => {
		if (!secondaryIntent?.searchQuery) return {};

		const question = secondaryIntent.searchQuery;

		// Backstop anti-alucinación: el clasificador a veces fabrica una "pregunta
		// secundaria" tomando términos del historial (no del mensaje actual). Si
		// ningún término significativo del searchQuery aparece en el mensaje actual
		// del cliente, descartamos la secundaria para no responder algo que el
		// cliente nunca preguntó (ej. "¿cuál me recomiendas?" generando una
		// supuesta pregunta sobre "fragancia" vista antes en el historial).
		const normalizedUserText = normalizeText(userText);
		const queryTokens = normalizeText(question)
			.split(/\s+/)
			.filter(w => w.length > 3);
		const groundedInMessage =
			queryTokens.length > 0 &&
			queryTokens.some(w => normalizedUserText.includes(w));
		if (!groundedInMessage) {
			console.log(
				`[NLU] Dropping ungrounded secondary question "${question}" — not present in user message: "${userText}"`,
			);
			return {};
		}

		try {
			const ragResults = await this.ragDocService.search(
				question,
				undefined,
				0.5,
			);
			if (ragResults.length > 0) {
				return {
					secondaryQuestion: question,
					ragContext: this.ragDocService.formatContext(ragResults),
				};
			}
		} catch {
			// RAG failure is non-critical for secondary intent
		}
		return { secondaryQuestion: question };
	};
}
