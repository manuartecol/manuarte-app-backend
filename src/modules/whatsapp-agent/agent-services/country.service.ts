import { ShopModel } from '../../shop/model';
import { StockModel } from '../../stock/model';
import { CountryModel } from '../../country/model';
import { WhatsAppLogService } from '../logging/log.service';
import { WhatsAppLine } from '../lines';

export type CountryContext = {
	currency: string;
	stockIds: string[];
	shopId: string;
	isoCode: string;
};

export class CountryService {
	constructor(private logService: WhatsAppLogService) {}

	/**
	 * Resuelve el contexto operativo (tienda, stock, moneda, país) a partir de la
	 * LÍNEA por la que entró el mensaje, no del teléfono del cliente.
	 *
	 * Un cliente puede escribir a cualquiera de las líneas, así que su prefijo
	 * telefónico no dice nada sobre qué catálogo, precios o inventario le
	 * corresponden: eso lo define el número del negocio al que escribió.
	 */
	resolveForLine = async (
		line: WhatsAppLine,
	): Promise<CountryContext | null> => {
		try {
			const shop = await ShopModel.findOne({
				where: { slug: line.shopSlug },
				attributes: ['id', 'currency'],
				include: [
					{
						model: StockModel,
						as: 'stock',
						attributes: ['id'],
					},
					{
						model: CountryModel,
						as: 'country',
						attributes: ['isoCode'],
					},
				],
			});

			if (!shop) {
				console.error(
					`[WhatsApp Agent] Shop not found for line ${line.isoCode} (slug: ${line.shopSlug})`,
				);
				return null;
			}

			const stock = shop.get('stock') as { id: string } | null;
			const country = shop.get('country') as { isoCode: string } | null;
			const stockIds = stock ? [stock.id] : [];
			const currency = (shop.get('currency') as string | undefined) ?? 'USD';
			const isoCode = country?.isoCode ?? line.isoCode;

			console.log(
				`[WhatsApp Agent] Line context resolved: phoneNumberId=${line.phoneNumberId}, ` +
					`shop=${line.shopSlug}, currency=${currency}, isoCode=${isoCode}, stocks=${stockIds.join(', ')}`,
			);
			return { currency, stockIds, shopId: shop.id, isoCode };
		} catch (error) {
			console.error('[WhatsApp Agent] Error resolving line context:', error);
			this.logService
				.logError({
					context: 'resolveLineContext',
					error,
					botPhoneNumberId: line.phoneNumberId,
				})
				.catch(e =>
					console.error('[WhatsApp Agent] Failed to save error log:', e),
				);
			return null;
		}
	};
}
