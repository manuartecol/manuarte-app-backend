import axios from 'axios';
import FormData from 'form-data';
import { ENV } from '../../config/env';
import { formatCurrency } from '../docs/utils';

const GRAPH_API_BASE = 'https://graph.facebook.com/v21.0';

type SendTemplateParams = {
	customerName: string;
	serialNumber: string;
	total: number;
	docName: string;
	templateName: string;
};

export class WhatsAppService {
	uploadMedia = async (
		buffer: Buffer,
		filename: string,
		phoneNumberId: string = ENV.WHATSAPP_PHONE_NUMBER_ID,
		contentType: string = 'application/pdf',
	): Promise<string> => {
		const form = new FormData();
		form.append('file', buffer, {
			filename,
			contentType,
			knownLength: buffer.length,
		});
		form.append('messaging_product', 'whatsapp');

		const response = await axios.post(
			`${GRAPH_API_BASE}/${phoneNumberId}/media`,
			form,
			{
				headers: {
					...form.getHeaders(),
					Authorization: `Bearer ${ENV.WHATSAPP_ACCESS_TOKEN}`,
					'Content-Length': form.getLengthSync(),
				},
				maxBodyLength: Infinity,
			},
		);

		return response.data.id as string;
	};

	sendDocument = async (
		to: string,
		mediaId: string,
		phoneNumberId: string,
		filename: string,
		caption: string,
	): Promise<void> => {
		await axios.post(
			`${GRAPH_API_BASE}/${phoneNumberId}/messages`,
			{
				messaging_product: 'whatsapp',
				recipient_type: 'individual',
				to,
				type: 'document',
				document: {
					id: mediaId,
					filename,
					caption,
				},
			},
			{
				headers: {
					Authorization: `Bearer ${ENV.WHATSAPP_ACCESS_TOKEN}`,
					'Content-Type': 'application/json',
				},
			},
		);
	};

	sendImage = async (
		to: string,
		mediaId: string,
		phoneNumberId: string,
		caption?: string,
	): Promise<void> => {
		await axios.post(
			`${GRAPH_API_BASE}/${phoneNumberId}/messages`,
			{
				messaging_product: 'whatsapp',
				recipient_type: 'individual',
				to,
				type: 'image',
				image: {
					id: mediaId,
					...(caption ? { caption } : {}),
				},
			},
			{
				headers: {
					Authorization: `Bearer ${ENV.WHATSAPP_ACCESS_TOKEN}`,
					'Content-Type': 'application/json',
				},
			},
		);
	};

	sendTemplate = async (
		to: string,
		mediaId: string,
		params: SendTemplateParams,
	): Promise<void> => {
		const { customerName, serialNumber, total, docName, templateName } = params;

		await axios.post(
			`${GRAPH_API_BASE}/${ENV.WHATSAPP_PHONE_NUMBER_ID}/messages`,
			{
				messaging_product: 'whatsapp',
				recipient_type: 'individual',
				to,
				type: 'template',
				template: {
					name: templateName,
					language: { code: 'es_CO' },
					components: [
						{
							type: 'header',
							parameters: [
								{
									type: 'document',
									document: {
										filename: docName,
										id: mediaId,
									},
								},
							],
						},
						{
							type: 'body',
							parameters: [
								{ type: 'text', text: customerName },
								{ type: 'text', text: serialNumber },
								{ type: 'text', text: formatCurrency(total) },
							],
						},
					],
				},
			},
			{
				headers: {
					Authorization: `Bearer ${ENV.WHATSAPP_ACCESS_TOKEN}`,
					'Content-Type': 'application/json',
				},
			},
		);
	};
}
