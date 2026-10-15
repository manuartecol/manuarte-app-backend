import { getSession, saveSession } from '../session.store';
import { getLineByPhoneNumberId } from '../lines';
import { ENV } from '../../../config/env';
import { WhatsAppService } from '../../whatsapp/service';
import { QuoteService } from '../../quote/service';
import { CountryService } from './country.service';
import { AiStateService } from './ai-state.service';
import { BillingService } from '../../billing/service';
import { BillingStatus, PaymentMethod } from '../../billing/types';
import { isWithinOfficeHours } from '../utils';
import { UserSession } from '../types';
import { StockItemModel } from '../../stock-item/model';
import { ProductVariantModel } from '../../product-variant/model';

type SendReplyFn = (
	to: string,
	botPhoneNumberId: string,
	text: string,
) => Promise<void>;

export class MediaHandlerService {
	constructor(
		private countryService: CountryService,
		private quoteService: QuoteService,
		private whatsAppService: WhatsAppService,
		private sendReply: SendReplyFn,
		private billingService: BillingService,
		private aiStateService: AiStateService,
	) {}

	handleIncomingImage = (
		phoneNumber: string,
		botPhoneNumberId: string,
		mediaId: string,
		mediaType: 'image' | 'document',
		processingQueue: Map<string, Promise<void>>,
	): Promise<void> => {
		// Misma clave que el agente (<phoneNumberId>:<teléfono>): comparten Map,
		// así que un comprobante y un texto del mismo cliente en la misma línea
		// se siguen procesando en serie, y dos líneas no se bloquean entre sí.
		const key = `${botPhoneNumberId}:${phoneNumber}`;
		const prev = processingQueue.get(key);
		let resolveCurrent!: () => void;
		const current = new Promise<void>(resolve => {
			resolveCurrent = resolve;
		});
		processingQueue.set(key, current);
		const run = async () => {
			if (prev) await prev;
			try {
				await this.doHandleIncomingImage(
					phoneNumber,
					botPhoneNumberId,
					mediaId,
					mediaType,
				);
			} finally {
				resolveCurrent();
				if (processingQueue.get(key) === current) {
					processingQueue.delete(key);
				}
			}
		};
		return run();
	};

	private doHandleIncomingImage = async (
		phoneNumber: string,
		botPhoneNumberId: string,
		mediaId: string,
		mediaType: 'image' | 'document',
	): Promise<void> => {
		// Segunda comprobación: la media llega por una vía propia y se procesa en
		// cola, así que un empleado puede haber tomado la conversación entre la
		// recepción y este punto. Procesar un comprobante aquí generaría una
		// factura mientras una persona ya está atendiendo el caso.
		if (await this.aiStateService.isPaused(botPhoneNumberId, phoneNumber)) {
			console.log(
				`[WhatsApp Agent] Media from ${phoneNumber} skipped: a human is handling the conversation.`,
			);
			return;
		}

		const session: UserSession = await getSession(botPhoneNumberId, phoneNumber);

		const step = session.pendingPurchaseFlow?.step;
		if (
			step !== 'awaiting_receipt' &&
			step !== 'awaiting_payment_confirmation'
		) {
			// Media outside receipt flow: ignore silently
			console.log(
				`[WhatsApp Agent] Received media from ${phoneNumber} outside receipt flow, ignoring.`,
			);
			return;
		}

		const flow = session.pendingPurchaseFlow!;
		const line = getLineByPhoneNumberId(botPhoneNumberId);
		const countryInfo = line
			? await this.countryService.resolveForLine(line)
			: null;

		const shopId =
			flow.quoteShopId ??
			session.lastCountryInfo?.shopId ??
			countryInfo?.shopId ??
			'';
		const stockId =
			flow.quoteStockId ??
			session.lastCountryInfo?.stockIds?.[0] ??
			countryInfo?.stockIds?.[0] ??
			'';

		console.log(
			`[WhatsApp Agent] Receipt received: phoneNumber=${phoneNumber}, shopId=${shopId}, stockId=${stockId}, itemCount=${flow.items?.length ?? 0}, quoteId=${flow.quoteId ?? 'N/A'}`,
		);

		// Enriquecer items: para items con productVariantId pero sin stockItemId, buscar stockItemId
		const enrichedItems = await Promise.all(
			(flow.items ?? []).map(async item => {
				if (!item.stockItemId && item.productVariantId && stockId) {
					try {
						const si = await StockItemModel.findOne({
							where: { stockId, active: true },
							include: [
								{
									model: ProductVariantModel,
									as: 'productVariants',
									where: { id: item.productVariantId },
									required: true,
									attributes: [],
									through: { attributes: [] },
								},
							],
							attributes: ['id'],
						});
						if (si) {
							return { ...item, stockItemId: si.getDataValue('id') as string };
						}
					} catch (e) {
						console.error('[WhatsApp Agent] Error looking up stockItemId:', e);
					}
				}
				return item;
			}),
		);

		// Intentar crear la factura automáticamente si los ítems tienen los IDs necesarios
		const validItems = enrichedItems.filter(
			i => i.stockItemId && i.productVariantId,
		);
		const allItemsValid =
			validItems.length > 0 && validItems.length === enrichedItems.length;

		let billSerial: string | undefined;
		if (allItemsValid && shopId && stockId && flow.paymentRef) {
			try {
				const billingResult = await this.billingService.create({
					billingData: {
						shopId,
						stockId,
						status: BillingStatus.PAID,
						payments: [
							{
								paymentMethod: (flow.paymentMethod ??
									'BANK_TRANSFER_RT') as PaymentMethod,
								amount: flow.total ?? 0,
								paymentReference: flow.paymentRef,
							},
						],
						subtotal: flow.total ?? 0,
						discountType: 'FIXED',
						discount: 0,
						shipping: '0',
						comments: 'Pedido realizado por WhatsApp',
						currency: flow.currency ?? 'USD',
						requestedBy: ENV.AGENT_SYSTEM_USER_ID,
						clientRequestId: flow.paymentRef,
						...(flow.quoteId ? { quoteId: flow.quoteId } : {}),
						items: validItems.map(i => ({
							stockItemId: i.stockItemId!,
							productVariantId: i.productVariantId!,
							billingId: '',
							stockId,
							name: i.variantName
								? `${i.productName} ${i.variantName}`
								: i.productName,
							quantity: i.quantity,
							price: parseFloat(i.unitPrice ?? '0'),
							totalPrice: parseFloat(i.unitPrice ?? '0') * i.quantity,
							currency: (i.currency ?? flow.currency ?? 'USD') as 'COP' | 'USD',
						})),
					},
					customerData: {
						fullName: flow.collectedData?.fullName ?? '',
						dni: flow.collectedData?.dni ?? '',
						email: '',
						phoneNumber: flow.collectedData?.phoneNumber ?? phoneNumber,
						location: flow.collectedData?.location ?? '',
						cityId: String(flow.collectedData?.cityId ?? ''),
						customerId: flow.collectedData?.customerId,
						personId: flow.collectedData?.personId,
					},
				});
				billSerial = billingResult.newBilling?.serialNumber;
				console.log(
					`[WhatsApp Agent] Billing created: serial=${billSerial}, receipt=${mediaType}:${mediaId}`,
				);
			} catch (billingErr) {
				console.error('[WhatsApp Agent] Error creating billing:', billingErr);
			}
		} else if (!allItemsValid) {
			const itemDetails = enrichedItems
				.map(
					i =>
						`{name=${i.productName}, variantId=${i.productVariantId || 'MISSING'}, stockItemId=${i.stockItemId || 'MISSING'}}`,
				)
				.join(', ');
			console.warn(
				`[WhatsApp Agent] Skipping billing: allItemsValid=false. stockId=${stockId}, shopId=${shopId}, quoteId=${flow.quoteId ?? 'N/A'}, items=[${itemDetails}]`,
			);
		}

		// El aviso de pedido nuevo a la tienda se retiró: con Coexistence el
		// personal ya ve el comprobante y la confirmación en este mismo chat, y
		// la línea del agente es la propia tienda, así que el aviso se enviaría a
		// sí misma. Queda pendiente decidir cómo avisar de una venta hecha por la
		// IA sin duplicar lo que ya está a la vista.

		// Eliminar cotización si se creó la factura exitosamente
		if (billSerial && flow.quoteId) {
			await this.quoteService
				.delete(flow.quoteId)
				.catch(e =>
					console.error(
						'[WhatsApp Agent] Error deleting quote after billing:',
						e,
					),
				);
			console.log(
				`[WhatsApp Agent] Quote ${flow.quoteId} deleted after billing ${billSerial}`,
			);
		}

		// Clear flow, cart y la referencia a la cotización: la compra ya se completó
		// (y la cotización fue eliminada). Si no limpiamos lastQuoteId/lastQuoteSerial,
		// un saludo posterior re-ofrecería esa cotización ya consumida.
		session.pendingPurchaseFlow = null;
		session.cart = [];
		session.lastQuoteId = undefined;
		session.lastQuoteSerial = undefined;
		// Marca la compra como recién completada: el cierre/saludo siguiente debe sonar a
		// "gracias por su compra / un gusto atenderlo", no a "me avisa cualquier cosa".
		session.lastPurchaseAt = Date.now();

		await saveSession(botPhoneNumberId, phoneNumber, session);

		const offHoursNote = !isWithinOfficeHours()
			? '\n\n⏰ Nuestro equipo está fuera de horario ahora mismo (L–V 8–18h, Sáb 8–14h), pero recibirán su pedido y le contactarán a la brevedad.'
			: '';

		const reply =
			`✅ ¡Comprobante recibido! Nuestro equipo lo verificará y le confirmará el pedido en breve.` +
			`\n\n📦 *Nota importante*: El flete (envío) no está incluido en el pago. Nuestro equipo se pondrá en contacto con usted para coordinar el envío y confirmar el costo.` +
			offHoursNote +
			`\n\n¡Gracias por su compra! 🎉`;

		await this.sendReply(phoneNumber, botPhoneNumberId, reply);
	};
}
