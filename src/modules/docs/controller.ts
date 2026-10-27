import axios from 'axios';
import { Handler } from 'express';
import { DocsService } from './service';
import { QuoteService } from '../quote/service';
import { BillingService } from '../billing/service';
import { WhatsAppService } from '../whatsapp/service';
import { calculateTotals } from './utils';
import { ENV } from '../../config/env';

/**
 * Un fallo de la API de WhatsApp llega como error de axios, con un mensaje en
 * inglés ("Request failed with status code 400") que el panel le mostraría tal
 * cual al vendedor. Se cambia por uno que entienda; el detalle de Meta (status y
 * cuerpo de la respuesta) sigue en el error que registra el errorHandler. Los
 * errores propios, como el de un PDF que no se pudo generar, ya traen su
 * mensaje y pasan sin tocarse.
 */
const toSendError = (error: unknown) => {
	if (axios.isAxiosError(error)) {
		error.message = 'No se pudo enviar el documento por WhatsApp';
	}
	return error;
};

export class DocsController {
	private docsService;
	private quoteService;
	private billingService;
	private whatsAppService;

	constructor(
		docsService: DocsService,
		quoteService: QuoteService,
		billingService: BillingService,
		whatsAppService: WhatsAppService,
	) {
		this.docsService = docsService;
		this.quoteService = quoteService;
		this.billingService = billingService;
		this.whatsAppService = whatsAppService;
	}

	getQuotePdf: Handler = async (req, res, next) => {
		try {
			const { serialNumber } = req.params;

			const buffer = await this.docsService.generateQuote(serialNumber);

			res.set({
				'Content-Type': 'application/pdf',
				'Content-Disposition': `inline; filename="CTZ-${serialNumber}.pdf"`,
				'Content-Length': buffer.length,
			});

			res.end(buffer);
		} catch (error) {
			next(error);
		}
	};

	sendQuotePdfWhatsApp: Handler = async (req, res, next) => {
		try {
			const { serialNumber } = req.params;

			const result = await this.quoteService.getOne(serialNumber);
			if (result.status !== 200) {
				res.sendStatus(result.status);
				return;
			}

			const quote = result.quote;

			if (!quote.callingCode || !quote.phoneNumber) {
				res.status(400).json({
					message: 'El cliente no tiene número de teléfono registrado',
				});
				return;
			}

			const buffer = await this.docsService.generateQuote(serialNumber);
			const filename = `CTZ-${serialNumber}.pdf`;
			const mediaId = await this.whatsAppService.uploadMedia(buffer, filename);

			const customerName =
				(quote.fullName as string)?.toUpperCase() ?? 'CONSUMIDOR FINAL';
			const { total } = calculateTotals(quote);
			const templateParams = {
				customerName,
				serialNumber,
				total,
				docName: filename,
				templateName: 'send_quote',
			};

			// Sin `.catch`, igual que en facturas: si el envío al cliente falla, el
			// error sube y el vendedor lo ve. Antes se registraba y la respuesta
			// seguía siendo "PDF enviado correctamente" aunque no hubiera llegado.
			// La copia a la tienda sí va aparte, porque su fallo no afecta al cliente
			const recipientPhone = `${quote.callingCode}${quote.phoneNumber}`;
			await this.whatsAppService.sendTemplate(
				recipientPhone,
				mediaId,
				templateParams,
			);

			const shopPhone =
				quote.countryIsoCode === 'CO'
					? ENV.SHOP_NOTIFY_CO_PHONE
					: ENV.SHOP_NOTIFY_EC_PHONE;

			if (shopPhone) {
				this.whatsAppService
					.sendTemplate(shopPhone, mediaId, templateParams)
					.catch(err =>
						console.error('Error sending WhatsApp to shop:', err.message),
					);
			}

			res.status(200).json({ message: 'PDF enviado correctamente' });
		} catch (error) {
			next(toSendError(error));
		}
	};

	getBillingPdf: Handler = async (req, res, next) => {
		try {
			const { serialNumber } = req.params;

			const buffer = await this.docsService.generateBilling(serialNumber);

			res.set({
				'Content-Type': 'application/pdf',
				'Content-Disposition': `inline; filename="FCT-${serialNumber}.pdf"`,
				'Content-Length': buffer.length,
			});

			res.end(buffer);
		} catch (error) {
			next(error);
		}
	};

	sendBillingPdfWhatsApp: Handler = async (req, res, next) => {
		try {
			const { serialNumber } = req.params;

			const result = await this.billingService.getOne(serialNumber);
			if (result.status !== 200) {
				res.sendStatus(result.status);
				return;
			}

			const billing = result.billing;

			if (!billing.callingCode || !billing.phoneNumber) {
				res.status(400).json({
					message: 'El cliente no tiene número de teléfono registrado',
				});
				return;
			}

			const buffer = await this.docsService.generateBilling(serialNumber);
			const filename = `FCT-${serialNumber}.pdf`;
			const mediaId = await this.whatsAppService.uploadMedia(buffer, filename);

			const customerName =
				(billing.fullName as string)?.toUpperCase() ?? 'CONSUMIDOR FINAL';
			const { total } = calculateTotals(billing);
			const templateParams = {
				customerName,
				serialNumber,
				total,
				docName: filename,
				templateName: 'send_billing',
			};

			const recipientPhone = `${billing.callingCode}${billing.phoneNumber}`;
			await this.whatsAppService.sendTemplate(
				recipientPhone,
				mediaId,
				templateParams,
			);

			const shopPhone =
				billing.countryIsoCode === 'CO'
					? ENV.SHOP_NOTIFY_CO_PHONE
					: ENV.SHOP_NOTIFY_EC_PHONE;

			if (shopPhone) {
				this.whatsAppService
					.sendTemplate(shopPhone, mediaId, templateParams)
					.catch(err =>
						console.error('Error sending WhatsApp to shop:', err.message),
					);
			}

			res.status(200).json({ message: 'PDF enviado correctamente' });
		} catch (error) {
			next(toSendError(error));
		}
	};
}
