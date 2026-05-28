import crypto from 'crypto';
import { PersonModel } from '../../person/model';
import { CustomerModel } from '../../customer/model';
import { OpenAIService } from '../openai.service';
import { PaymentLinkService } from '../payment-link.service';
import { CustomerService } from '../../customer/service';
import { CityService } from '../../city/service';
import { QuoteService } from '../../quote/service';
import { DocsService } from '../../docs/service';
import { WhatsAppService } from '../../whatsapp/service';
import { QuoteStatus } from '../../quote/types';
import { calculateTotals, formatCurrency } from '../../docs/utils';
import { ENV } from '../../../config/env';
import { formatPrice, normalizeText } from '../utils';
import { ProductSearchService } from './product-search.service';
import { stripCallingCode } from '../helpers/intent-detection';
import { mapCartToQuoteItems } from '../helpers/cart-helpers';
import { CartItem, CollectionFlow, UserSession } from '../types';

export class FlowsService {
	constructor(
		private openai: OpenAIService,
		private customerService: CustomerService,
		private cityService: CityService,
		private quoteService: QuoteService,
		private docsService: DocsService,
		private whatsAppService: WhatsAppService,
		private paymentLinkService: PaymentLinkService,
		private productSearchService: ProductSearchService,
	) {}

	/**
	 * Maneja los pasos comunes de recopilación de datos del cliente
	 * (awaiting_customer_data → awaiting_address → awaiting_city_selection → awaiting_confirmation).
	 * Compartido entre handleQuoteFlowStep y handlePurchaseFlowStep.
	 */
	handleCommonCollectionSteps = async (
		flow: CollectionFlow,
		text: string,
		normalizedText: string,
		cart: CartItem[],
		currency: string,
		confirmationIntent: string,
		confirmationContextKey: 'quoteFlowData' | 'purchaseFlowData',
	): Promise<string | null> => {
		const getConfirmCtx = () =>
			confirmationContextKey === 'quoteFlowData'
				? { quoteFlowData: flow.collectedData }
				: { purchaseFlowData: flow.collectedData };

		if (flow.step === 'awaiting_customer_data') {
			const extracted = await this.openai.extractCustomerData(
				text,
				'customer_data',
			);
			const fullName = extracted.fullName ?? flow.collectedData?.fullName;
			const dni = extracted.dni ?? flow.collectedData?.dni;

			if (!fullName || !dni) {
				flow.collectedData = { ...flow.collectedData, fullName, dni };
				const missing =
					!fullName && !dni
						? 'su nombre completo y su número de cédula'
						: !fullName
							? 'su nombre completo'
							: 'su número de cédula';
				return await this.openai
					.generateReply({
						userMessage: text,
						intent: 'awaiting_customer_data',
					})
					.catch(() => `Me falta ${missing}. ¿Me lo compartes?`);
			}

			flow.collectedData = { ...flow.collectedData, fullName, dni };
			flow.step = 'awaiting_address';

			return await this.openai
				.generateReply({ userMessage: text, intent: 'awaiting_address' })
				.catch(
					() =>
						'Perfecto. Ahora necesito su dirección de entrega y la ciudad, por favor.',
				);
		}

		if (flow.step === 'awaiting_address') {
			const extracted = await this.openai.extractCustomerData(text, 'address');
			const location = extracted.location ?? flow.collectedData?.location;
			const cityText = extracted.city;

			if (!location) {
				return await this.openai
					.generateReply({ userMessage: text, intent: 'awaiting_address' })
					.catch(
						() =>
							'Necesito su dirección de entrega para continuar. ¿Me la comparte?',
					);
			}

			flow.collectedData = { ...flow.collectedData, location };

			if (!cityText) return '¿Y en qué ciudad estás?';

			const cityResult = await this.cityService.search(cityText);
			const cityResults = cityResult?.cities ?? [];
			if (cityResults.length === 0) {
				return `No encontré la ciudad "${cityText}". ¿Puedes escribirla de nuevo?`;
			}

			if (cityResults.length === 1) {
				const city = cityResults[0].dataValues;
				flow.collectedData.cityId = city.id;
				flow.collectedData.cityName = `${city.name}, ${city.regionName}`;
				flow.step = 'awaiting_confirmation';
				return await this.openai
					.generateReply({
						userMessage: text,
						intent: confirmationIntent,
						cart,
						currency,
						...getConfirmCtx(),
					})
					.catch(() => '¿Confirmo con estos datos?');
			}

			flow.cityCandidates = cityResults.slice(0, 5).map(c => {
				const d = c.dataValues;
				return { id: d.id, name: d.name, regionName: d.regionName };
			});
			flow.step = 'awaiting_city_selection';

			return await this.openai
				.generateReply({
					userMessage: text,
					intent: 'awaiting_city_selection',
					cityCandidates: flow.cityCandidates.map((c, i) => ({
						index: i + 1,
						name: c.name,
						region: c.regionName,
					})),
				})
				.catch(() => {
					const list = flow
						.cityCandidates!.map(
							(c, i) => `${i + 1}. ${c.name}, ${c.regionName}`,
						)
						.join('\n');
					return `Encontré varias opciones:\n${list}\n¿Cuál es la suya?`;
				});
		}

		if (flow.step === 'awaiting_city_selection') {
			const candidates = flow.cityCandidates ?? [];
			const selectionMatch = normalizedText.match(/^(\d+)$/);
			const selectedIdx = selectionMatch
				? parseInt(selectionMatch[1], 10) - 1
				: -1;

			let selected:
				| { id: number; name: string; regionName: string }
				| undefined;
			if (selectedIdx >= 0 && selectedIdx < candidates.length) {
				selected = candidates[selectedIdx];
			} else {
				selected = candidates.find(
					c =>
						normalizeText(c.name).includes(normalizedText) ||
						normalizedText.includes(normalizeText(c.name)),
				);
			}

			if (selected) {
				flow.collectedData = {
					...flow.collectedData,
					cityId: selected.id,
					cityName: `${selected.name}, ${selected.regionName}`,
				};
				flow.cityCandidates = undefined;
				flow.step = 'awaiting_confirmation';
				return await this.openai
					.generateReply({
						userMessage: text,
						intent: confirmationIntent,
						cart,
						currency,
						...getConfirmCtx(),
					})
					.catch(() => '¿Confirmo con estos datos?');
			}

			const list = candidates
				.map((c, i) => `${i + 1}. ${c.name}, ${c.regionName}`)
				.join('\n');
			return `No entendí su selección. Elija el número:\n${list}`;
		}

		return null;
	};

	/**
	 * Maneja cada paso del flujo de cotización. Retorna el texto de respuesta
	 * si el paso fue procesado, o null si se debe continuar con el flujo normal.
	 */
	handleQuoteFlowStep = async (
		phoneNumber: string,
		botPhoneNumberId: string,
		text: string,
		normalizedText: string,
		session: UserSession,
		countryInfo: {
			currency: string;
			stockIds: string[];
			shopId: string;
			isoCode: string;
		} | null,
	): Promise<string | null> => {
		const flow = session.pendingQuoteFlow!;
		const currency =
			session.lastCountryInfo?.currency ?? countryInfo?.currency ?? 'USD';

		// Permitir cancelar el flujo
		if (/\b(cancelar|cancelalo|dejalo|olvidalo)\b/i.test(normalizedText)) {
			session.pendingQuoteFlow = null;
			return 'Listo, cancelé el proceso de cotización. ¿Necesitas algo más?';
		}

		// Manejar el paso de confirmación del carrito antes de iniciar el flujo de datos
		if (flow.step === 'awaiting_cart_confirmation') {
			const isConfirm =
				/^(si|sí|vale|ok|dale|claro|listo|perfecto|bueno|confirmo|de acuerdo|va|venga|correcto|todo bien|esta bien|procede|procedemos|sigamos|continua|generar|genera|cotizar|cotizacion|cotización|cotizame|cotizalo|cotizalos|quiero\s+cotizar|quiero\s+la\s+cotizacion|quiero\s+la\s+cotización|genera\s+la\s+cotizacion|genera\s+la\s+cotización)\b/i.test(
					normalizedText.trim(),
				);
			if (!isConfirm) {
				// No es confirmación → dejar que el flujo normal maneje edit_cart, search_product, etc.
				return null;
			}
			// Confirmado → buscar cliente existente y transicionar
			const isoCode =
				session.lastCountryInfo?.isoCode ?? countryInfo?.isoCode ?? 'CO';
			const localPhone = stripCallingCode(phoneNumber);
			const existingCustomer = await this.customerService.findByPhone(
				localPhone,
				isoCode,
			);
			if (existingCustomer) {
				flow.step = 'awaiting_confirmation';
				flow.collectedData = {
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
				};
				return await this.openai
					.generateReply({
						userMessage: text,
						intent: 'existing_customer_confirmation',
						cart: session.cart,
						currency,
						quoteFlowData: flow.collectedData,
					})
					.catch(
						() =>
							`¡Hola de nuevo, ${existingCustomer.fullName}! Ya tengo sus datos registrados. ¿Procedemos con la cotización?`,
					);
			} else {
				flow.step = 'awaiting_customer_data';
				flow.collectedData = { phoneNumber: localPhone };
				return await this.openai
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

		const commonReply = await this.handleCommonCollectionSteps(
			flow,
			text,
			normalizedText,
			session.cart ?? [],
			currency,
			'awaiting_confirmation',
			'quoteFlowData',
		);
		if (commonReply !== null) return commonReply;

		if (flow.step === 'awaiting_confirmation') {
			// Detectar confirmación: comienza con palabra afirmativa Y no contiene intención de corrección
			const startsAffirmative =
				/^(si|sí|vale|ok|dale|claro|listo|perfecto|bueno|confirmo|de acuerdo|va|venga|correcto|todo bien|esta bien|nada)\b/i.test(
					normalizedText.trim(),
				);
			const hasCorrection =
				/\b(cambiar|cambio|cambia|corregir|corrige|modificar|modifica|pero|mal|error|falta|no es|en vez de|en lugar de|la cedula|el nombre|la direccion|el telefono|el numero)\b/i.test(
					normalizedText,
				);
			// Also detect when message contains a raw number that looks like a DNI correction
			const looksLikeDniCorrection =
				!startsAffirmative && /\b\d{6,12}\b/.test(normalizedText);
			const isConfirm =
				startsAffirmative && !hasCorrection && !looksLikeDniCorrection;

			if (!isConfirm) {
				// Use AI to detect what the customer wants to correct
				const correctionResult = await this.openai.extractQuoteCorrection(
					text,
					flow.collectedData ?? {},
				);

				let dataChanged = false;

				// Apply corrections detected by AI
				if (correctionResult.fullName) {
					flow.collectedData = {
						...flow.collectedData,
						fullName: correctionResult.fullName,
					};
					dataChanged = true;
				}
				if (correctionResult.dni) {
					flow.collectedData = {
						...flow.collectedData,
						dni: correctionResult.dni,
					};
					dataChanged = true;
				}
				if (correctionResult.phoneNumber) {
					flow.collectedData = {
						...flow.collectedData,
						phoneNumber: correctionResult.phoneNumber,
					};
					dataChanged = true;
				}
				if (correctionResult.location) {
					flow.collectedData = {
						...flow.collectedData,
						location: correctionResult.location,
					};
					dataChanged = true;
				}
				if (correctionResult.city) {
					const cityText = correctionResult.city;
					const cityResult = await this.cityService.search(cityText);
					const cityResults = cityResult?.cities ?? [];
					if (cityResults.length === 1) {
						const city = cityResults[0].dataValues;
						flow.collectedData = {
							...flow.collectedData,
							cityId: city.id,
							cityName: `${city.name}, ${city.regionName}`,
						};
						dataChanged = true;
					} else if (cityResults.length > 1) {
						flow.cityCandidates = cityResults.slice(0, 5).map(c => {
							const d = c.dataValues;
							return { id: d.id, name: d.name, regionName: d.regionName };
						});
						flow.step = 'awaiting_city_selection';
						const list = flow.cityCandidates
							.map((c, i) => `${i + 1}. ${c.name}, ${c.regionName}`)
							.join('\n');
						return `Encontré varias opciones para "${cityText}":\n${list}\n¿Cuál es?`;
					}
				}

				if (dataChanged) {
					return await this.openai
						.generateReply({
							userMessage: text,
							intent: 'awaiting_confirmation',
							cart: session.cart,
							currency,
							quoteFlowData: flow.collectedData,
						})
						.catch(
							() => '¿Confirmo la cotización con estos datos actualizados?',
						);
				}

				// Any other message (cart edits, product adds/removes) → let the normal pipeline handle it
				return null;
			}

			// Generar la cotización
			try {
				const data = flow.collectedData!;
				const shopId =
					session.lastCountryInfo?.shopId ?? countryInfo?.shopId ?? '';
				const items = mapCartToQuoteItems(session.cart ?? []);

				if (items.length === 0) {
					session.pendingQuoteFlow = null;
					return 'No hay productos válidos en su pedido para generar la cotización.';
				}

				// Si no tenemos customerId, buscar persona existente por DNI
				// para evitar SequelizeUniqueConstraintError en person.dni
				if (!data.customerId && data.dni) {
					const existingPerson = await PersonModel.findOne({
						where: { dni: data.dni },
						attributes: ['id'],
					});
					if (existingPerson) {
						data.personId = existingPerson.id;
						const existingCustomer = await CustomerModel.findOne({
							where: { personId: existingPerson.id },
							attributes: ['id'],
						});
						if (existingCustomer) {
							data.customerId = existingCustomer.id;
						}
					}
				}

				// Quitar código de país del teléfono (ej: 573127600792 → 3127600792)
				const rawPhone = data.phoneNumber ?? phoneNumber;
				const localPhone = rawPhone.replace(/^(57|593)/, '');

				const result = await this.quoteService.create({
					quoteData: {
						shopId,
						items,
						status: QuoteStatus.PENDING,
						discountType: 'FIXED',
						discount: 0,
						shipping: 0,
						requestedBy: ENV.WHATSAPP_BOT_USER_ID,
						currency: currency as 'COP' | 'USD',
					},
					customerData: {
						fullName: data.fullName ?? '',
						dni: data.dni ?? '',
						email: '',
						phoneNumber: localPhone,
						location: data.location ?? '',
						cityId: String(data.cityId ?? ''),
						customerId: data.customerId,
						personId: data.personId,
					},
				});

				// Limpiar flujo y carrito
				session.pendingQuoteFlow = null;
				session.cart = [];
				session.selectedProduct = undefined;

				// Guardar referencia de la cotización para el flujo de compra
				session.lastQuoteId = result.newQuote.id;
				session.lastQuoteSerial = result.newQuote.serialNumber;

				// Iniciar flujo de compra en paso de confirmación de cotización
				session.pendingPurchaseFlow = {
					step: 'awaiting_quote_confirmation',
					purchaseFromQuote: true,
					quoteId: result.newQuote.id,
					quoteSerial: result.newQuote.serialNumber,
					currency,
				};

				const serial = result.newQuote.serialNumber;

				// Enviar PDF por WhatsApp antes de devolver el mensaje de confirmación
				try {
					const buffer = await this.docsService.generateQuote(serial);
					const filename = `CTZ-${serial}.pdf`;
					const quoteResult = await this.quoteService.getOne(serial);

					if (quoteResult.status === 200) {
						const quote = quoteResult.quote;
						const mediaId = await this.whatsAppService.uploadMedia(
							buffer,
							filename,
							botPhoneNumberId,
						);
						const { total } = calculateTotals(quote);
						const recipientPhone = `${quote.callingCode}${quote.phoneNumber}`;
						const formattedTotal = formatCurrency(total);
						const caption = `📄 Cotización #${serial} por un total de ${formattedTotal}.\n\n`;

						await this.whatsAppService.sendDocument(
							recipientPhone,
							mediaId,
							botPhoneNumberId,
							filename,
							caption,
						);
					}
				} catch (err) {
					console.error(
						`[WhatsApp Agent] Error sending quote PDF for ${serial}:`,
						err,
					);
				}

				return 'Con gusto le ayudo a completar la compra 😊';
			} catch (error) {
				console.error('[WhatsApp Agent] Error creating quote:', error);
				session.pendingQuoteFlow = null;
				return 'Hubo un problema generando la cotización. Por favor intenta de nuevo o contacta a nuestro equipo.';
			}
		}

		return null;
	};

	/**
	 * Maneja cada paso del flujo de compra.
	 * Análogo a handleQuoteFlowStep pero para completar una compra con link de pago.
	 */
	handlePurchaseFlowStep = async (
		phoneNumber: string,
		botPhoneNumberId: string,
		text: string,
		normalizedText: string,
		session: UserSession,
		countryInfo: {
			currency: string;
			stockIds: string[];
			shopId: string;
			isoCode: string;
		} | null,
	): Promise<string | null> => {
		const flow = session.pendingPurchaseFlow!;
		const isoCode =
			session.lastCountryInfo?.isoCode ?? countryInfo?.isoCode ?? 'CO';
		const currency =
			session.lastCountryInfo?.currency ?? countryInfo?.currency ?? 'USD';

		// Permitir cancelar el flujo
		if (
			/\b(cancelar|cancelalo|no\s*quiero|dejalo|olvidalo)\b/i.test(
				normalizedText,
			)
		) {
			session.pendingPurchaseFlow = null;
			return 'Listo, cancelé el proceso de compra. ¿Necesitas algo más?';
		}

		// ── Paso 0b: resolución de ítems sin stock suficiente ──
		if (flow.step === 'awaiting_out_of_stock_resolution') {
			const blockedCtx = flow.blockedItemsContext ?? [];

			// Detectar intención del cliente
			const wantsTakeAvailable =
				/^(s[ií]|yes|vale|ok|dale|claro|listo|perfecto|bueno|de acuerdo|va|venga|inclúyel[ao]s?|incluyel[ao]s?|ponl[ao]s?|agr[eé]gal[ao]s?|ponme\s+l[ao]s?)\b/i.test(
					normalizedText.trim(),
				) ||
				/\b(as[ií]|llevar\s+(los|las|el|la)?\s*(disponibles?|que\s+hay)|quiero?\s+(los|las)?\s*disponibles?|con\s+(los|las)?\s*disponibles?|tomar?\s+(los|las)?\s*disponibles?|los\s+que\s+hay|lo\s+que\s+hay)\b/i.test(
					normalizedText,
				);

			// Detectar si el cliente pide una alternativa por nombre
			let chosenAlternative: {
				blockedItem: CartItem;
				variant: {
					variantId: string;
					name: string;
					stock: number;
					unitPrice: string | null;
				};
			} | null = null;
			for (const blocked of blockedCtx) {
				for (const alt of blocked.alternatives) {
					const altNorm = normalizeText(alt.name);
					if (normalizedText.includes(altNorm)) {
						chosenAlternative = { blockedItem: blocked.item, variant: alt };
						break;
					}
					// Intento por palabras clave (ej: "10 kilos")
					const altWords = altNorm.split(/\s+/).filter(w => w.length > 2);
					if (
						altWords.length > 0 &&
						altWords.every(w => normalizedText.includes(w))
					) {
						chosenAlternative = { blockedItem: blocked.item, variant: alt };
						break;
					}
				}
				if (chosenAlternative) break;
			}

			// Construir lista de ítems final (skip es el comportamiento por defecto)
			const updatedItems = [...(flow.items ?? [])];

			if (wantsTakeAvailable) {
				// Agregar ítems bloqueados con la cantidad disponible
				for (const blocked of blockedCtx) {
					if (blocked.availableStock > 0) {
						updatedItems.push({
							...blocked.item,
							quantity: blocked.availableStock,
						});
					}
				}
			} else if (chosenAlternative) {
				// Agregar la variante alternativa elegida (cantidad 1 por defecto)
				const { blockedItem, variant } = chosenAlternative;
				// Buscar stockItemId para la variante alternativa
				const productEntry = session.lastProductList?.find(
					p => p.productId === blockedItem.productId,
				);
				const altVariantEntry = productEntry?.variants.find(
					v => v.variantId === variant.variantId,
				);
				updatedItems.push({
					...blockedItem,
					productVariantId: variant.variantId,
					variantName: variant.name,
					stockItemId: altVariantEntry?.stockItemId ?? null,
					quantity: 1,
					unitPrice: variant.unitPrice,
				});
			}
			// else wantsSkip (o por defecto): no agregar los bloqueados

			flow.items = updatedItems;
			flow.blockedItemsContext = undefined;

			// Continuar con el flujo de compra normal
			const localPhone =
				flow.collectedData?.phoneNumber ?? stripCallingCode(phoneNumber);
			const existingCustomer = await this.customerService.findByPhone(
				localPhone,
				isoCode,
			);

			if (existingCustomer) {
				flow.collectedData = {
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
				};
				flow.step = 'awaiting_confirmation';
				return await this.openai
					.generateReply({
						userMessage: text,
						intent: 'existing_customer_purchase_confirmation',
						cart: updatedItems,
						currency,
						purchaseFlowData: flow.collectedData,
					})
					.catch(
						() =>
							`¡Hola de nuevo, ${existingCustomer.fullName}! Ya tengo sus datos. ¿Procedemos con la compra?`,
					);
			} else {
				flow.collectedData = { phoneNumber: localPhone };
				flow.step = 'awaiting_customer_data';
				return await this.openai
					.generateReply({
						userMessage: text,
						intent: 'purchase_intent',
					})
					.catch(
						() =>
							'¡Perfecto! Para procesar su compra necesito su nombre completo y su número de cédula.',
					);
			}
		}

		// ── Paso 0: confirmar si procede desde la cotización existente ──
		if (flow.step === 'awaiting_quote_confirmation') {
			// Los datos ya fueron confirmados en el flujo de cotización.
			// Solo se aborta si el cliente rechaza explícitamente o pide una corrección.
			const isExplicitRefusal =
				/^(no\b|cancelar|cancela|no\s+quiero|no\s+gracias|olvidalo|dejalo|no\s+me)\b/i.test(
					normalizedText.trim(),
				);
			const hasCorrectionRequest =
				/\b(cambiar|cambio|cambia|corregir|corrige|modificar|modifica|pero|mal|error|falta|no es|en vez de|en lugar de|la cedula|el nombre|la direccion|el telefono)\b/i.test(
					normalizedText,
				);
			const isConfirm = !isExplicitRefusal && !hasCorrectionRequest;

			if (isConfirm) {
				// Cargar items de la cotización
				const quoteResult = await this.quoteService.getOne(flow.quoteSerial!);
				if (quoteResult.status === 200 && quoteResult.quote) {
					const quote = quoteResult.quote;
					const quoteItemsArr: Array<{
						name: string;
						quantity: number;
						price: number;
						productVariantId?: string;
						stockItemId?: string;
					}> = (quote.items ?? quote.quoteItems ?? []) as Array<{
						name: string;
						quantity: number;
						price: number;
						productVariantId?: string;
						stockItemId?: string;
					}>;
					const items: CartItem[] = quoteItemsArr.map(qi => ({
						productId: '',
						productVariantId: qi.productVariantId ?? '',
						stockItemId: qi.stockItemId ?? undefined,
						productName: qi.name,
						quantity: qi.quantity,
						unitPrice: String(qi.price),
						currency,
					}));
					const { total } = calculateTotals(quote);
					flow.items = items;
					flow.total = total;
					flow.currency = currency;
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					flow.quoteStockId = (quote as any).stockId ?? undefined;
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					flow.quoteShopId = (quote as any).shopId ?? undefined;
					flow.purchaseFromQuote = true;
					console.log(
						`[WhatsApp Agent] Quote items loaded for purchase: ${items.length} items, stockId=${flow.quoteStockId}, shopId=${flow.quoteShopId}`,
					);
					// Usar datos del cliente de la cotización si los hay
					flow.collectedData = flow.collectedData ?? {
						fullName: quote.fullName,
						dni: quote.dni,
						phoneNumber: quote.phoneNumber,
						location: quote.location,
						cityId: quote.cityId,
						cityName: quote.cityName
							? `${quote.cityName}${quote.regionName ? `, ${quote.regionName}` : ''}`
							: undefined,
						customerId: String(quote.customerId ?? ''),
					};
				}

				// Mostrar QR de transferencia y esperar comprobante
				const paymentRef = crypto.randomUUID();
				flow.paymentRef = paymentRef;
				flow.paymentMethod = 'BANK_TRANSFER_RT';
				flow.step = 'awaiting_receipt';

				const qrInfo =
					isoCode === 'CO' ? ENV.PAYMENT_QR_CO_INFO : ENV.PAYMENT_QR_EC_INFO;
				const itemLines =
					flow.items && flow.items.length > 0
						? flow.items
								.map(i => {
									const name = i.variantName
										? `${i.productName} – ${i.variantName}`
										: i.productName;
									return `  • ${i.quantity}x ${name}`;
								})
								.join('\n')
						: '';

				const totalStr =
					flow.total != null
						? formatPrice(String(flow.total), flow.currency ?? currency)
						: '';

				return (
					`Para completar su pedido, realice el pago por transferencia:\n\n${qrInfo}\n\n` +
					(itemLines ? `Pedido:\n${itemLines}\n\n` : '') +
					(totalStr ? `Total: ${totalStr}\n\n` : '') +
					`Ref: ${paymentRef}\n\n` +
					`Cuando realice el pago, envíenos el comprobante (imagen o PDF) 📸`
				);
			} else {
				// El cliente no quiere usar la cotización → iniciar flujo con datos nuevos
				// Cargar ítems de la cotización antes de limpiar la referencia para que
				// estén disponibles en el paso awaiting_confirmation (el carrito fue vaciado
				// al generar la cotización y session.cart = [] en este punto).
				if (flow.quoteSerial && (!flow.items || flow.items.length === 0)) {
					const savedSerial = flow.quoteSerial;
					const quoteResult = await this.quoteService.getOne(savedSerial);
					if (quoteResult.status === 200 && quoteResult.quote) {
						const quote = quoteResult.quote;
						const rejectedQuoteItems: Array<{
							name: string;
							quantity: number;
							price: number;
							productVariantId?: string;
							stockItemId?: string;
						}> = (quote.items ?? quote.quoteItems ?? []) as Array<{
							name: string;
							quantity: number;
							price: number;
							productVariantId?: string;
							stockItemId?: string;
						}>;
						flow.items = rejectedQuoteItems.map(qi => ({
							productId: '',
							productVariantId: qi.productVariantId ?? '',
							stockItemId: qi.stockItemId ?? undefined,
							productName: qi.name,
							quantity: qi.quantity,
							unitPrice: String(qi.price),
							currency,
						}));
						const { total } = calculateTotals(quote);
						flow.total = total;
						flow.currency = currency;
					}
				}

				const localPhone = stripCallingCode(phoneNumber);
				flow.purchaseFromQuote = false;
				flow.quoteId = undefined;
				flow.quoteSerial = undefined;

				// Verificar si ya existe el cliente
				const existingCustomer = await this.customerService.findByPhone(
					localPhone,
					isoCode,
				);
				if (existingCustomer) {
					flow.collectedData = {
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
					};
					flow.step = 'awaiting_confirmation';
					return await this.openai
						.generateReply({
							userMessage: text,
							intent: 'existing_customer_purchase_confirmation',
							cart: flow.items ?? session.cart,
							currency,
							purchaseFlowData: flow.collectedData,
						})
						.catch(
							() =>
								`¡Hola de nuevo, ${existingCustomer.fullName}! Ya tengo sus datos. ¿Procedemos con la compra?`,
						);
				} else {
					flow.collectedData = { phoneNumber: localPhone };
					flow.step = 'awaiting_customer_data';
					return await this.openai
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
		}

		// ── Paso 1-3: recopilación de datos del cliente (reutiliza lógica común) ──
		const commonReply = await this.handleCommonCollectionSteps(
			flow,
			text,
			normalizedText,
			flow.items ?? session.cart ?? [],
			currency,
			'awaiting_purchase_confirmation',
			'purchaseFlowData',
		);
		if (commonReply !== null) return commonReply;

		// ── Paso 4: confirmación de datos antes del pago ──
		if (flow.step === 'awaiting_confirmation') {
			const startsAffirmative =
				/^(si|sí|vale|ok|dale|claro|listo|perfecto|bueno|confirmo|de acuerdo|va|venga|correcto|todo bien|esta bien|nada)\b/i.test(
					normalizedText.trim(),
				);
			const hasCorrection =
				/\b(cambiar|cambio|cambia|corregir|corrige|modificar|modifica|pero|mal|error|falta|no es|en vez de|en lugar de|la cedula|el nombre|la direccion|el telefono|el numero)\b/i.test(
					normalizedText,
				);
			const looksLikeDniCorrection =
				!startsAffirmative && /\b\d{6,12}\b/.test(normalizedText);
			const isConfirm =
				startsAffirmative && !hasCorrection && !looksLikeDniCorrection;

			if (!isConfirm) {
				const correctionResult = await this.openai.extractQuoteCorrection(
					text,
					flow.collectedData ?? {},
				);
				let dataChanged = false;
				if (correctionResult.fullName) {
					flow.collectedData = {
						...flow.collectedData,
						fullName: correctionResult.fullName,
					};
					dataChanged = true;
				}
				if (correctionResult.dni) {
					flow.collectedData = {
						...flow.collectedData,
						dni: correctionResult.dni,
					};
					dataChanged = true;
				}
				if (correctionResult.phoneNumber) {
					flow.collectedData = {
						...flow.collectedData,
						phoneNumber: correctionResult.phoneNumber,
					};
					dataChanged = true;
				}
				if (correctionResult.location) {
					flow.collectedData = {
						...flow.collectedData,
						location: correctionResult.location,
					};
					dataChanged = true;
				}
				if (correctionResult.city) {
					const cityResult = await this.cityService.search(
						correctionResult.city,
					);
					const cityResults = cityResult?.cities ?? [];
					if (cityResults.length === 1) {
						const city = cityResults[0].dataValues;
						flow.collectedData = {
							...flow.collectedData,
							cityId: city.id,
							cityName: `${city.name}, ${city.regionName}`,
						};
						dataChanged = true;
					} else if (cityResults.length > 1) {
						flow.cityCandidates = cityResults.slice(0, 5).map(c => {
							const d = c.dataValues;
							return { id: d.id, name: d.name, regionName: d.regionName };
						});
						flow.step = 'awaiting_city_selection';
						const list = flow.cityCandidates
							.map((c, i) => `${i + 1}. ${c.name}, ${c.regionName}`)
							.join('\n');
						return `Encontré varias opciones para "${correctionResult.city}":\n${list}\n¿Cuál es?`;
					}
				}
				if (dataChanged) {
					return await this.openai
						.generateReply({
							userMessage: text,
							intent: 'awaiting_purchase_confirmation',
							cart: flow.items ?? session.cart,
							currency,
							purchaseFlowData: flow.collectedData,
						})
						.catch(() => '¿Confirmo la compra con estos datos actualizados?');
				}

				// Any other message (cart edits, product adds/removes) → let the normal pipeline handle it
				return null;
			}

			// Confirmado — generar items y total si no están aún
			if (!flow.items || flow.items.length === 0) {
				flow.items = session.cart ?? [];
			}
			if (flow.total == null) {
				flow.total = flow.items.reduce((sum, item) => {
					return (
						sum +
						(item.unitPrice ? parseFloat(item.unitPrice) * item.quantity : 0)
					);
				}, 0);
				flow.currency = currency;
			}

			// Mostrar QR de transferencia y esperar comprobante
			const paymentRef = crypto.randomUUID();
			flow.paymentRef = paymentRef;
			flow.paymentMethod = 'BANK_TRANSFER_RT';
			flow.step = 'awaiting_receipt';

			const qrInfo =
				isoCode === 'CO' ? ENV.PAYMENT_QR_CO_INFO : ENV.PAYMENT_QR_EC_INFO;
			const itemLines =
				flow.items.length > 0
					? flow.items
							.map(i => {
								const name = i.variantName
									? `${i.productName} – ${i.variantName}`
									: i.productName;
								return `  • ${i.quantity}x ${name}`;
							})
							.join('\n')
					: '';
			const totalStr = formatPrice(
				String(flow.total),
				flow.currency ?? currency,
			);

			return (
				`Para completar su pedido, realice el pago por transferencia:\n\n${qrInfo}\n\n` +
				(itemLines ? `Pedido:\n${itemLines}\n\n` : '') +
				`Total: ${totalStr}\n\n` +
				`Ref: ${paymentRef}\n\n` +
				`Cuando realice el pago, envíenos el comprobante (imagen o PDF) 📸`
			);
		}

		// ── Paso 5: confirmación de pago (compatibilidad sesiones anteriores) ──
		if (flow.step === 'awaiting_payment_confirmation') {
			// Transicionar directamente a awaiting_receipt
			flow.step = 'awaiting_receipt';
			return 'Por favor envíenos el comprobante de pago (imagen o PDF) para que nuestro equipo pueda verificarlo. 📸';
		}

		// ── Paso 6: esperando recibo ──
		if (flow.step === 'awaiting_receipt') {
			// CO: solicitud de Bold / tarjeta
			if (
				isoCode === 'CO' &&
				/bold|tarjeta|pagar\s+con\s+tarjeta|débito|crédito/i.test(
					normalizedText,
				)
			) {
				try {
					const link = await this.paymentLinkService.getBoldLink(
						flow.total ?? 0,
						flow.currency ?? currency,
						flow.paymentRef ?? crypto.randomUUID(),
					);
					flow.paymentMethod = 'BOLD';
					flow.paymentLink = link;
					const boldTotal = flow.total
						? formatPrice(String(flow.total), flow.currency ?? currency)
						: '';
					return (
						`Aquí tiene su link de pago con Bold:\n\n🔗 ${link}\n\n` +
						`Ref: ${flow.paymentRef}\n` +
						(boldTotal ? `Total: ${boldTotal}\n\n` : '') +
						`Cuando realice el pago, envíenos el comprobante. 📸`
					);
				} catch {
					return 'Hubo un problema generando el link de pago. Inténtelo de nuevo o contáctenos.';
				}
			}
			// CO: solicitud de Nequi
			if (isoCode === 'CO' && /nequi/i.test(normalizedText)) {
				const nequiInfo = this.paymentLinkService.getNequiInfo();
				const nequiTotal = flow.total
					? formatPrice(String(flow.total), flow.currency ?? currency)
					: '';
				flow.paymentMethod = 'NEQUI';
				return (
					`Para pagar por Nequi:\n\n${nequiInfo}\n\n` +
					`Concepto/Ref: ${flow.paymentRef}\n` +
					(nequiTotal ? `Total: ${nequiTotal}\n\n` : '') +
					`Envíenos el comprobante cuando complete el pago. 📸`
				);
			}
			// EC: solicitud de PayPhone / tarjeta
			if (
				isoCode === 'EC' &&
				/payphone|pay\s*phone|tarjeta|pagar\s+con\s+tarjeta/i.test(
					normalizedText,
				)
			) {
				try {
					const link = await this.paymentLinkService.getPayPhoneLink(
						flow.total ?? 0,
						flow.currency ?? currency,
						flow.paymentRef ?? crypto.randomUUID(),
					);
					flow.paymentMethod = 'PAYPHONE';
					flow.paymentLink = link;
					const ppTotal = flow.total
						? formatPrice(String(flow.total), flow.currency ?? currency)
						: '';
					return (
						`Aquí tiene su link de pago con PayPhone:\n\n🔗 ${link}\n\n` +
						`Ref: ${flow.paymentRef}\n` +
						(ppTotal ? `Total: ${ppTotal}\n\n` : '') +
						`Cuando realice el pago, envíenos el comprobante. 📸`
					);
				} catch {
					return 'Hubo un problema generando el link de pago. Inténtelo de nuevo o contáctenos.';
				}
			}
			return 'Para continuar necesitamos el comprobante de pago. Por favor envía una imagen o PDF del comprobante. 📸';
		}

		return null;
	};
}
